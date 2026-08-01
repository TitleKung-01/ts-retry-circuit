// src/core.ts

import {
  CircuitAbortedError,
  CircuitCapacityRejectedError,
  CircuitHalfOpenThrottledError,
  CircuitOpenError,
  CircuitTimeoutError,
} from "./errors.js";

export type CircuitState = "CLOSED" | "OPEN" | "HALF-OPEN";

export type CircuitTripStrategy = "consecutive" | "rolling";

export type CircuitEvent =
  | "open"
  | "close"
  | "halfOpen"
  | "success"
  | "failure"
  | "reject"
  | "timeout"
  | "fallback"
  | "retry";

export interface CircuitEventPayload {
  state: CircuitState;
  name?: string;
  error?: unknown;
  attempt?: number;
  durationMs?: number;
  retryAfterMs?: number;
}

export type CircuitEventHandler = (payload: CircuitEventPayload) => void;

export interface CircuitFallbackContext {
  state: CircuitState;
}

export interface CircuitConfig {
  /** Consecutive failures required to transition to OPEN (used when strategy is "consecutive") */
  failureThreshold: number;
  /** Milliseconds to stay OPEN before entering HALF-OPEN */
  cooldownPeriod: number;
  /** Max retries while CLOSED (default: 3) */
  maxRetries?: number;
  /** Initial delay in ms for exponential full-jitter backoff (default: 500) */
  initialRetryDelay?: number;
  /** Errors returning true are rethrown without counting as circuit failures */
  isExpectedError?: (error: unknown) => boolean;
  /** Per-attempt timeout in ms; timed-out attempts count as failures and abort the attempt signal */
  timeout?: number;
  /**
   * Invoked when the circuit rejects (OPEN / HALF-OPEN throttle / capacity)
   * or after final counted failure. Not used for expected errors.
   */
  fallback?: (
    error: unknown,
    context: CircuitFallbackContext,
  ) => unknown | Promise<unknown>;
  /** Successes required in HALF-OPEN before returning to CLOSED (default: 1) */
  halfOpenSuccessThreshold?: number;
  /** Optional name for registry / observability */
  name?: string;
  /** Max concurrent executions (bulkhead). Default: unlimited */
  capacity?: number;
  /** Trip strategy (default: "consecutive") */
  strategy?: CircuitTripStrategy;
  /** Rolling: failure percentage to open (default: 50) */
  errorThresholdPercentage?: number;
  /** Rolling: min samples in window before percentage applies (default: 5) */
  volumeThreshold?: number;
  /** Rolling: window size in ms (default: 10000) */
  rollingWindowMs?: number;
  /** Rolling: number of buckets in the window (default: 10) */
  rollingBuckets?: number;
}

export interface CircuitStatus {
  state: CircuitState;
  failureCount: number;
  nextAttemptTime: number;
  activeRequests: number;
  name?: string;
}

export interface CircuitMetrics extends CircuitStatus {
  successCount: number;
  halfOpenSuccessCount: number;
  openedCount: number;
  rejectedCount: number;
  attemptCount: number;
  totalDurationMs: number;
  fallbackCount: number;
  timeoutCount: number;
  retryCount: number;
}

export interface ExecuteOptions {
  signal?: AbortSignal;
}

interface RollingBucket {
  start: number;
  successes: number;
  failures: number;
}

const namedBreakers = new Map<string, CircuitBreaker>();

export const CircuitRegistry = {
  get(name: string): CircuitBreaker | undefined {
    return namedBreakers.get(name);
  },

  getOrCreate(name: string, config: CircuitConfig): CircuitBreaker {
    const existing = namedBreakers.get(name);
    if (existing) return existing;
    const breaker = new CircuitBreaker({ ...config, name });
    namedBreakers.set(name, breaker);
    return breaker;
  },

  register(name: string, breaker: CircuitBreaker): void {
    namedBreakers.set(name, breaker);
  },

  release(name: string): boolean {
    return namedBreakers.delete(name);
  },

  clear(): void {
    namedBreakers.clear();
  },

  keys(): string[] {
    return [...namedBreakers.keys()];
  },
};

export class CircuitBreaker {
  private state: CircuitState = "CLOSED";
  private failureCount: number = 0;
  private halfOpenSuccessCount: number = 0;
  private nextAttemptTime: number = 0;
  private activeRequests: number = 0;
  private successCount: number = 0;
  private openedCount: number = 0;
  private rejectedCount: number = 0;
  private attemptCount: number = 0;
  private totalDurationMs: number = 0;
  private fallbackCount: number = 0;
  private timeoutCount: number = 0;
  private retryCount: number = 0;

  private readonly failureThreshold: number;
  private readonly cooldownPeriod: number;
  private readonly maxRetries: number;
  private readonly initialRetryDelay: number;
  private readonly isExpectedError?: (error: unknown) => boolean;
  private readonly timeout?: number;
  private readonly fallback?: CircuitConfig["fallback"];
  private readonly halfOpenSuccessThreshold: number;
  private readonly capacity?: number;
  private readonly strategy: CircuitTripStrategy;
  private readonly errorThresholdPercentage: number;
  private readonly volumeThreshold: number;
  private readonly rollingWindowMs: number;
  private readonly rollingBuckets: number;
  private readonly bucketSizeMs: number;
  readonly name?: string;

  private buckets: RollingBucket[] = [];

  private readonly listeners = new Set<
    (state: CircuitState, details: { failureCount: number }) => void
  >();
  private readonly eventHandlers = new Map<
    CircuitEvent,
    Set<CircuitEventHandler>
  >();

  /** @deprecated Prefer `on("open" | "close" | ...)` */
  public onStateChange?: (
    state: CircuitState,
    details: { failureCount: number },
  ) => void;

  public subscribe(
    listener: (state: CircuitState, details: { failureCount: number }) => void,
  ): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public on(event: CircuitEvent, handler: CircuitEventHandler): () => void {
    let set = this.eventHandlers.get(event);
    if (!set) {
      set = new Set();
      this.eventHandlers.set(event, set);
    }
    set.add(handler);
    return () => {
      set!.delete(handler);
    };
  }

  public once(event: CircuitEvent, handler: CircuitEventHandler): () => void {
    const off = this.on(event, (payload) => {
      off();
      handler(payload);
    });
    return off;
  }

  public off(event: CircuitEvent, handler: CircuitEventHandler): void {
    this.eventHandlers.get(event)?.delete(handler);
  }

  static get(name: string, config?: CircuitConfig): CircuitBreaker {
    if (config) return CircuitRegistry.getOrCreate(name, config);
    const existing = CircuitRegistry.get(name);
    if (!existing) {
      throw new Error(
        `[CircuitBreaker] No breaker registered as "${name}". Pass config to create one.`,
      );
    }
    return existing;
  }

  static register(name: string, breaker: CircuitBreaker): CircuitBreaker {
    CircuitRegistry.register(name, breaker);
    return breaker;
  }

  static release(name: string): boolean {
    return CircuitRegistry.release(name);
  }

  constructor(config: CircuitConfig) {
    if (config.failureThreshold <= 0)
      throw new Error("failureThreshold must be greater than 0");
    if (config.cooldownPeriod <= 0)
      throw new Error("cooldownPeriod must be greater than 0");
    if (config.timeout !== undefined && config.timeout <= 0)
      throw new Error("timeout must be greater than 0");
    if (
      config.halfOpenSuccessThreshold !== undefined &&
      config.halfOpenSuccessThreshold <= 0
    )
      throw new Error("halfOpenSuccessThreshold must be greater than 0");
    if (config.capacity !== undefined && config.capacity <= 0)
      throw new Error("capacity must be greater than 0");

    this.strategy = config.strategy ?? "consecutive";
    this.errorThresholdPercentage = config.errorThresholdPercentage ?? 50;
    this.volumeThreshold = config.volumeThreshold ?? 5;
    this.rollingWindowMs = config.rollingWindowMs ?? 10_000;
    this.rollingBuckets = config.rollingBuckets ?? 10;

    if (this.strategy === "rolling") {
      if (
        this.errorThresholdPercentage < 0 ||
        this.errorThresholdPercentage > 100
      ) {
        throw new Error("errorThresholdPercentage must be between 0 and 100");
      }
      if (this.volumeThreshold <= 0)
        throw new Error("volumeThreshold must be greater than 0");
      if (this.rollingWindowMs <= 0)
        throw new Error("rollingWindowMs must be greater than 0");
      if (this.rollingBuckets <= 0)
        throw new Error("rollingBuckets must be greater than 0");
    }

    this.failureThreshold = config.failureThreshold;
    this.cooldownPeriod = config.cooldownPeriod;
    this.maxRetries = config.maxRetries ?? 3;
    this.initialRetryDelay = config.initialRetryDelay ?? 500;
    this.isExpectedError = config.isExpectedError;
    this.timeout = config.timeout;
    this.fallback = config.fallback;
    this.halfOpenSuccessThreshold = config.halfOpenSuccessThreshold ?? 1;
    this.capacity = config.capacity;
    this.name = config.name;
    this.bucketSizeMs = this.rollingWindowMs / this.rollingBuckets;

    if (this.name) {
      CircuitRegistry.register(this.name, this);
    }
  }

  async execute<T>(
    fn: (signal: AbortSignal) => Promise<T>,
    options?: ExecuteOptions,
  ): Promise<T> {
    const parentSignal = options?.signal;
    this.throwIfAborted(parentSignal);
    this.updateState();

    if (this.state === "OPEN") {
      const remainingTime = Math.max(0, this.nextAttemptTime - Date.now());
      const error = new CircuitOpenError(remainingTime);
      this.rejectedCount++;
      this.emit("reject", { error, retryAfterMs: remainingTime });
      this.emitStateChange();
      return this.applyFallbackOrThrow<T>(error);
    }

    if (this.state === "HALF-OPEN" && this.activeRequests > 0) {
      const error = new CircuitHalfOpenThrottledError();
      this.rejectedCount++;
      this.emit("reject", { error });
      this.emitStateChange();
      return this.applyFallbackOrThrow<T>(error);
    }

    if (this.capacity !== undefined && this.activeRequests >= this.capacity) {
      const error = new CircuitCapacityRejectedError(this.capacity);
      this.rejectedCount++;
      this.emit("reject", { error });
      this.emitStateChange();
      return this.applyFallbackOrThrow<T>(error);
    }

    this.activeRequests++;
    this.emitStateChange();
    let attempt = 0;

    try {
      while (true) {
        this.throwIfAborted(parentSignal);
        const attemptStarted = Date.now();
        try {
          const result = await this.runAttempt(fn, parentSignal);
          const durationMs = Date.now() - attemptStarted;
          this.totalDurationMs += durationMs;
          this.attemptCount++;
          this.onSuccess();
          this.emit("success", { durationMs, attempt });
          return result;
        } catch (error) {
          const durationMs = Date.now() - attemptStarted;
          this.totalDurationMs += durationMs;
          this.attemptCount++;

          if (error instanceof CircuitAbortedError) {
            throw error;
          }

          if (error instanceof CircuitTimeoutError) {
            this.timeoutCount++;
            this.emit("timeout", { error, durationMs, attempt });
          }

          if (this.isExpectedError && this.isExpectedError(error)) {
            throw error;
          }

          attempt++;

          if (attempt <= this.maxRetries && this.state === "CLOSED") {
            this.retryCount++;
            this.emit("retry", { error, attempt, durationMs });
            const backoffLimit =
              this.initialRetryDelay * Math.pow(2, attempt - 1);
            const jitteredDelay = Math.random() * backoffLimit;
            await this.sleep(jitteredDelay, parentSignal);
            continue;
          }

          this.onFailure(error);
          this.emit("failure", { error, durationMs, attempt });
          return this.applyFallbackOrThrow<T>(error);
        }
      }
    } finally {
      this.activeRequests--;
      this.emitStateChange();
    }
  }

  public getStatus(): CircuitStatus {
    this.updateState();
    return {
      state: this.state,
      failureCount: this.failureCount,
      nextAttemptTime: this.nextAttemptTime,
      activeRequests: this.activeRequests,
      name: this.name,
    };
  }

  public getMetrics(): CircuitMetrics {
    this.updateState();
    return {
      ...this.getStatus(),
      successCount: this.successCount,
      halfOpenSuccessCount: this.halfOpenSuccessCount,
      openedCount: this.openedCount,
      rejectedCount: this.rejectedCount,
      attemptCount: this.attemptCount,
      totalDurationMs: this.totalDurationMs,
      fallbackCount: this.fallbackCount,
      timeoutCount: this.timeoutCount,
      retryCount: this.retryCount,
    };
  }

  public reset(): void {
    const previousState = this.state;
    const previousFailureCount = this.failureCount;
    const previousHalfOpenSuccessCount = this.halfOpenSuccessCount;

    this.state = "CLOSED";
    this.failureCount = 0;
    this.halfOpenSuccessCount = 0;
    this.nextAttemptTime = 0;
    this.buckets = [];

    if (
      previousState !== "CLOSED" ||
      previousFailureCount > 0 ||
      previousHalfOpenSuccessCount > 0
    ) {
      this.emit("close", {});
      this.emitStateChange();
    }
  }

  private async applyFallbackOrThrow<T>(error: unknown): Promise<T> {
    if (this.fallback) {
      this.fallbackCount++;
      this.emit("fallback", { error });
      return (await this.fallback(error, { state: this.state })) as T;
    }
    throw error;
  }

  private async runAttempt<T>(
    fn: (signal: AbortSignal) => Promise<T>,
    parentSignal?: AbortSignal,
  ): Promise<T> {
    this.throwIfAborted(parentSignal);

    const controller = new AbortController();
    const cleanup: Array<() => void> = [];

    if (parentSignal) {
      const onParentAbort = () => controller.abort();
      if (parentSignal.aborted) {
        throw new CircuitAbortedError();
      }
      parentSignal.addEventListener("abort", onParentAbort);
      cleanup.push(() =>
        parentSignal.removeEventListener("abort", onParentAbort),
      );
    }

    let timedOut = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const timeoutPromise =
      this.timeout === undefined
        ? null
        : new Promise<never>((_, reject) => {
            const timeoutMs = this.timeout!;
            timeoutId = setTimeout(() => {
              timedOut = true;
              controller.abort();
              reject(new CircuitTimeoutError(timeoutMs));
            }, timeoutMs);
            cleanup.push(() => {
              if (timeoutId !== undefined) clearTimeout(timeoutId);
            });
          });

    try {
      const work = fn(controller.signal);
      if (timeoutPromise) {
        return await Promise.race([work, timeoutPromise]);
      }
      return await work;
    } catch (error) {
      if (timedOut || error instanceof CircuitTimeoutError) {
        throw error instanceof CircuitTimeoutError
          ? error
          : new CircuitTimeoutError(this.timeout!);
      }
      if (parentSignal?.aborted) {
        throw new CircuitAbortedError();
      }
      throw error;
    } finally {
      for (const fnCleanup of cleanup) fnCleanup();
    }
  }

  private onSuccess() {
    const previousState = this.state;
    const previousFailureCount = this.failureCount;
    this.successCount++;
    this.recordRollingOutcome(true);

    if (this.state === "HALF-OPEN") {
      this.halfOpenSuccessCount++;
      this.failureCount = 0;

      if (this.halfOpenSuccessCount >= this.halfOpenSuccessThreshold) {
        this.halfOpenSuccessCount = 0;
        this.state = "CLOSED";
        this.emit("close", {});
        this.emitStateChange();
      } else {
        this.emitStateChange();
      }
      return;
    }

    this.failureCount = 0;
    this.halfOpenSuccessCount = 0;
    this.state = "CLOSED";

    if (previousState !== "CLOSED" || previousFailureCount > 0) {
      this.emitStateChange();
    }
  }

  private onFailure(_error?: unknown) {
    this.failureCount++;
    this.halfOpenSuccessCount = 0;
    this.recordRollingOutcome(false);

    if (this.state === "HALF-OPEN") {
      this.openCircuit();
      return;
    }

    if (this.strategy === "rolling") {
      if (this.shouldOpenFromRolling()) {
        this.openCircuit();
      } else {
        this.emitStateChange();
      }
      return;
    }

    if (this.failureCount >= this.failureThreshold) {
      this.openCircuit();
    } else {
      this.emitStateChange();
    }
  }

  private openCircuit() {
    this.openedCount++;
    this.changeState("OPEN", Date.now() + this.cooldownPeriod);
    this.emit("open", {
      retryAfterMs: this.cooldownPeriod,
    });
  }

  private recordRollingOutcome(success: boolean) {
    if (this.strategy !== "rolling") return;
    const now = Date.now();
    this.pruneBuckets(now);
    let current = this.buckets[this.buckets.length - 1];
    if (!current || now - current.start >= this.bucketSizeMs) {
      current = { start: now, successes: 0, failures: 0 };
      this.buckets.push(current);
    }
    if (success) current.successes++;
    else current.failures++;
  }

  private pruneBuckets(now: number) {
    const cutoff = now - this.rollingWindowMs;
    this.buckets = this.buckets.filter((b) => b.start >= cutoff);
  }

  private windowTotals(): { successes: number; failures: number } {
    this.pruneBuckets(Date.now());
    return this.buckets.reduce(
      (acc, b) => {
        acc.successes += b.successes;
        acc.failures += b.failures;
        return acc;
      },
      { successes: 0, failures: 0 },
    );
  }

  private shouldOpenFromRolling(): boolean {
    const { successes, failures } = this.windowTotals();
    const total = successes + failures;
    if (total < this.volumeThreshold) return false;
    const rate = (failures / total) * 100;
    return rate >= this.errorThresholdPercentage;
  }

  private updateState() {
    if (this.state === "OPEN" && Date.now() > this.nextAttemptTime) {
      this.halfOpenSuccessCount = 0;
      this.changeState("HALF-OPEN", 0);
      this.emit("halfOpen", {});
    }
  }

  private changeState(newState: CircuitState, nextAttemptTime: number) {
    this.state = newState;
    this.nextAttemptTime = nextAttemptTime;
    this.emitStateChange();
  }

  private emit(
    event: CircuitEvent,
    partial: Omit<CircuitEventPayload, "state" | "name">,
  ) {
    const payload: CircuitEventPayload = {
      state: this.state,
      name: this.name,
      ...partial,
    };
    const handlers = this.eventHandlers.get(event);
    if (!handlers) return;
    for (const handler of handlers) {
      handler(payload);
    }
  }

  private emitStateChange() {
    if (this.onStateChange) {
      this.onStateChange(this.state, { failureCount: this.failureCount });
    }
    for (const listener of this.listeners) {
      listener(this.state, { failureCount: this.failureCount });
    }
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw new CircuitAbortedError();
    }
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new CircuitAbortedError());
        return;
      }

      const timeoutId = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);

      const onAbort = () => {
        clearTimeout(timeoutId);
        signal?.removeEventListener("abort", onAbort);
        reject(new CircuitAbortedError());
      };

      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

export {
  CircuitAbortedError,
  CircuitCapacityRejectedError,
  CircuitHalfOpenThrottledError,
  CircuitOpenError,
  CircuitTimeoutError,
  isCircuitError,
} from "./errors.js";
