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

export interface ExecuteContext {
  signal: AbortSignal;
}

export type ExecuteWork<T> = (ctx: ExecuteContext & AbortSignal) => Promise<T>;

export const CONFIG_BOUNDS = {
  failureThreshold: { min: 1, max: 1000 },
  cooldownPeriod: { min: 1, max: 86_400_000 },
  maxRetries: { min: 0, max: 20 },
  initialRetryDelay: { min: 1, max: 60_000 },
  timeout: { min: 1, max: 300_000 },
  halfOpenSuccessThreshold: { min: 1, max: 100 },
} as const;

export interface CircuitConfig {
  /** Consecutive failures required to transition to OPEN (1..1000, used when strategy is "consecutive") */
  failureThreshold: number;
  /** Milliseconds to stay OPEN before entering HALF-OPEN (1..86400000) */
  cooldownPeriod: number;
  /** Max retries while CLOSED (0..20, default: 3) */
  maxRetries?: number;
  /** Initial delay in ms for exponential full-jitter backoff (1..60000, default: 500) */
  initialRetryDelay?: number;
  /** Errors returning true are rethrown without counting as circuit failures */
  isExpectedError?: (error: unknown) => boolean;
  /** Per-attempt timeout in ms (1..300000); timed-out attempts count as failures and abort attempt signal */
  timeout?: number;
  /**
   * Invoked when the circuit rejects (OPEN / HALF-OPEN throttle / capacity) or after
   * final counted failure. Not used for expected errors.
   */
  fallback?: (
    error: unknown,
    context: CircuitFallbackContext,
  ) => unknown | Promise<unknown>;
  /** Successes required in HALF-OPEN before returning to CLOSED (1..100, default: 1) */
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
};

function assertInRange(
  name: string,
  value: number,
  min: number,
  max: number,
): void {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
}

function assertConfig(config: CircuitConfig): {
  maxRetries: number;
  initialRetryDelay: number;
  halfOpenSuccessThreshold: number;
} {
  assertInRange(
    "failureThreshold",
    config.failureThreshold,
    CONFIG_BOUNDS.failureThreshold.min,
    CONFIG_BOUNDS.failureThreshold.max,
  );
  assertInRange(
    "cooldownPeriod",
    config.cooldownPeriod,
    CONFIG_BOUNDS.cooldownPeriod.min,
    CONFIG_BOUNDS.cooldownPeriod.max,
  );

  const maxRetries = config.maxRetries ?? 3;
  assertInRange(
    "maxRetries",
    maxRetries,
    CONFIG_BOUNDS.maxRetries.min,
    CONFIG_BOUNDS.maxRetries.max,
  );

  const initialRetryDelay = config.initialRetryDelay ?? 500;
  assertInRange(
    "initialRetryDelay",
    initialRetryDelay,
    CONFIG_BOUNDS.initialRetryDelay.min,
    CONFIG_BOUNDS.initialRetryDelay.max,
  );

  if (config.timeout !== undefined) {
    assertInRange(
      "timeout",
      config.timeout,
      CONFIG_BOUNDS.timeout.min,
      CONFIG_BOUNDS.timeout.max,
    );
  }

  const halfOpenSuccessThreshold = config.halfOpenSuccessThreshold ?? 1;
  assertInRange(
    "halfOpenSuccessThreshold",
    halfOpenSuccessThreshold,
    CONFIG_BOUNDS.halfOpenSuccessThreshold.min,
    CONFIG_BOUNDS.halfOpenSuccessThreshold.max,
  );

  if (config.capacity !== undefined && config.capacity <= 0) {
    throw new Error("capacity must be greater than 0");
  }

  if (config.strategy === "rolling") {
    if (
      config.errorThresholdPercentage !== undefined &&
      (config.errorThresholdPercentage < 0 ||
        config.errorThresholdPercentage > 100)
    ) {
      throw new Error("errorThresholdPercentage must be between 0 and 100");
    }
    if (config.volumeThreshold !== undefined && config.volumeThreshold <= 0) {
      throw new Error("volumeThreshold must be greater than 0");
    }
    if (config.rollingWindowMs !== undefined && config.rollingWindowMs <= 0) {
      throw new Error("rollingWindowMs must be greater than 0");
    }
    if (config.rollingBuckets !== undefined && config.rollingBuckets <= 0) {
      throw new Error("rollingBuckets must be greater than 0");
    }
  }

  return { maxRetries, initialRetryDelay, halfOpenSuccessThreshold };
}

export class CircuitBreaker {
  private state: CircuitState = "CLOSED";
  private failureCount: number = 0;
  private halfOpenSuccessCount: number = 0;
  private nextAttemptTime: number = 0;
  private activeRequests: number = 0;
  private halfOpenProbeActive: boolean = false;

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
  private readonly fallback?: (
    error: unknown,
    context: CircuitFallbackContext,
  ) => unknown | Promise<unknown>;
  private readonly halfOpenSuccessThreshold: number;
  public readonly name?: string;
  private readonly capacity?: number;

  private readonly strategy: CircuitTripStrategy;
  private readonly errorThresholdPercentage: number;
  private readonly volumeThreshold: number;
  private readonly rollingWindowMs: number;
  private readonly rollingBuckets: number;
  private readonly bucketSizeMs: number;
  private buckets: RollingBucket[] = [];

  private listeners: Set<
    (state: CircuitState, details: { failureCount: number }) => void
  > = new Set();
  private eventHandlers: Map<CircuitEvent, Set<CircuitEventHandler>> =
    new Map();
  private onStateChange?: (
    state: CircuitState,
    details: { failureCount: number },
  ) => void;

  static get(name: string, config?: CircuitConfig): CircuitBreaker {
    if (config) {
      return CircuitRegistry.getOrCreate(name, config);
    }
    const existing = CircuitRegistry.get(name);
    if (!existing) {
      throw new Error(`CircuitBreaker with name "${name}" is not registered`);
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
    const normalized = assertConfig(config);

    this.failureThreshold = config.failureThreshold;
    this.cooldownPeriod = config.cooldownPeriod;
    this.maxRetries = normalized.maxRetries;
    this.initialRetryDelay = normalized.initialRetryDelay;
    this.isExpectedError = config.isExpectedError;
    this.timeout = config.timeout;
    this.fallback = config.fallback;
    this.halfOpenSuccessThreshold = normalized.halfOpenSuccessThreshold;
    this.name = config.name;
    this.capacity = config.capacity;

    this.strategy = config.strategy ?? "consecutive";
    this.errorThresholdPercentage = config.errorThresholdPercentage ?? 50;
    this.volumeThreshold = config.volumeThreshold ?? 5;
    this.rollingWindowMs = config.rollingWindowMs ?? 10_000;
    this.rollingBuckets = config.rollingBuckets ?? 10;
    this.bucketSizeMs = this.rollingWindowMs / this.rollingBuckets;

    if (this.name) {
      CircuitRegistry.register(this.name, this);
    }
  }

  async execute<T>(
    fn: (ctx: ExecuteContext & AbortSignal) => Promise<T>,
    options?: ExecuteOptions,
  ): Promise<T> {
    const externalSignal = options?.signal;
    this.throwIfAborted(externalSignal);
    this.updateState();

    if (this.state === "OPEN") {
      const remainingTime = Math.max(0, this.nextAttemptTime - Date.now());
      const error = new CircuitOpenError(remainingTime);
      this.rejectedCount++;
      this.emit("reject", { error, retryAfterMs: remainingTime });
      this.emitStateChange();
      return this.applyFallbackOrThrow<T>(error);
    }

    if (this.state === "HALF-OPEN" && this.halfOpenProbeActive) {
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

    const holdingHalfOpenProbe = this.state === "HALF-OPEN";
    if (holdingHalfOpenProbe) {
      this.halfOpenProbeActive = true;
    }

    this.activeRequests++;
    this.emitStateChange();
    let attempt = 0;

    try {
      while (true) {
        this.throwIfAborted(externalSignal);
        const attemptStarted = Date.now();
        try {
          const result = await this.runAttempt<T>(fn, externalSignal);
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
            await this.sleep(jitteredDelay, externalSignal);
            continue;
          }

          this.onFailure(error);
          this.emit("failure", { error, durationMs, attempt });
          return this.applyFallbackOrThrow<T>(error);
        }
      }
    } finally {
      this.activeRequests--;
      if (holdingHalfOpenProbe) {
        this.halfOpenProbeActive = false;
      }
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
    const status = this.getStatus();
    return {
      ...status,
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

  /**
   * Force the circuit back to CLOSED and clear consecutive failure counters.
   *
   * @remarks Dangerous in production UI — ops, admin tools, and tests only.
   * Do not bind this to a public end-user control.
   */
  public reset(): void {
    const previousState = this.state;
    const previousFailureCount = this.failureCount;
    const previousHalfOpenSuccessCount = this.halfOpenSuccessCount;

    this.state = "CLOSED";
    this.failureCount = 0;
    this.halfOpenSuccessCount = 0;
    this.nextAttemptTime = 0;
    this.buckets = [];
    this.halfOpenProbeActive = false;

    if (
      previousState !== "CLOSED" ||
      previousFailureCount > 0 ||
      previousHalfOpenSuccessCount > 0
    ) {
      this.emit("close", {});
      this.emitStateChange();
    }
  }

  public on(event: CircuitEvent, handler: CircuitEventHandler): () => void {
    let handlers = this.eventHandlers.get(event);
    if (!handlers) {
      handlers = new Set();
      this.eventHandlers.set(event, handlers);
    }
    handlers.add(handler);
    return () => {
      this.off(event, handler);
    };
  }

  public off(event: CircuitEvent, handler: CircuitEventHandler): void {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      handlers.delete(handler);
    }
  }

  public subscribe(
    listener: (state: CircuitState, details: { failureCount: number }) => void,
  ): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
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
    fn: (ctx: ExecuteContext & AbortSignal) => Promise<T>,
    externalSignal?: AbortSignal,
  ): Promise<T> {
    this.throwIfAborted(externalSignal);

    const controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let settled = false;

    const onExternalAbort = () => {
      controller.abort();
    };

    const cleanup = () => {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
        timeoutId = undefined;
      }
      externalSignal?.removeEventListener("abort", onExternalAbort);
    };

    try {
      if (externalSignal) {
        if (externalSignal.aborted) {
          throw new CircuitAbortedError();
        }
        externalSignal.addEventListener("abort", onExternalAbort, {
          once: true,
        });
      }

      if (this.timeout !== undefined) {
        const timeoutMs = this.timeout;
        timeoutId = setTimeout(() => {
          controller.abort();
        }, timeoutMs);
      }

      return await new Promise<T>((resolve, reject) => {
        const finishReject = (error: unknown) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        };

        const finishResolve = (value: T) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(value);
        };

        const onAttemptAbort = () => {
          if (externalSignal?.aborted) {
            finishReject(new CircuitAbortedError());
            return;
          }
          finishReject(new CircuitTimeoutError(this.timeout ?? 0));
        };

        if (controller.signal.aborted) {
          onAttemptAbort();
          return;
        }

        controller.signal.addEventListener("abort", onAttemptAbort, {
          once: true,
        });

        const ctxArg = Object.assign(controller.signal, {
          signal: controller.signal,
        }) as ExecuteContext & AbortSignal;

        try {
          const resultPromise = fn(ctxArg);
          Promise.resolve(resultPromise)
            .then((value) => {
              controller.signal.removeEventListener("abort", onAttemptAbort);
              finishResolve(value);
            })
            .catch((err: unknown) => {
              controller.signal.removeEventListener("abort", onAttemptAbort);
              if (controller.signal.aborted) {
                onAttemptAbort();
                return;
              }
              finishReject(err);
            });
        } catch (err) {
          controller.signal.removeEventListener("abort", onAttemptAbort);
          if (controller.signal.aborted) {
            onAttemptAbort();
            return;
          }
          finishReject(err);
        }
      });
    } finally {
      cleanup();
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
