// src/core.ts

import {
  CircuitAbortedError,
  CircuitHalfOpenThrottledError,
  CircuitOpenError,
  CircuitTimeoutError,
} from "./errors.js";

export type CircuitState = "CLOSED" | "OPEN" | "HALF-OPEN";

export interface CircuitFallbackContext {
  state: CircuitState;
}

export interface ExecuteContext {
  signal: AbortSignal;
}

export type ExecuteWork<T> = (ctx: ExecuteContext) => Promise<T>;

export interface CircuitConfig {
  /** Consecutive failures required to transition to OPEN (1..1000) */
  failureThreshold: number;
  /** Milliseconds to stay OPEN before entering HALF-OPEN (1..86400000) */
  cooldownPeriod: number;
  /** Max retries while CLOSED (0..20, default: 3) */
  maxRetries?: number;
  /** Initial delay in ms for exponential full-jitter backoff (1..60000, default: 500) */
  initialRetryDelay?: number;
  /** Errors returning true are rethrown without counting as circuit failures */
  isExpectedError?: (error: unknown) => boolean;
  /** Per-attempt timeout in ms (1..300000); timed-out attempts count as failures */
  timeout?: number;
  /**
   * Invoked when the circuit rejects (OPEN / HALF-OPEN throttle) or after
   * final counted failure. Not used for expected errors.
   * Consumer is responsible for returning a value matching the expected T.
   */
  fallback?: (
    error: unknown,
    context: CircuitFallbackContext,
  ) => unknown | Promise<unknown>;
  /** Successes required in HALF-OPEN before returning to CLOSED (1..100, default: 1) */
  halfOpenSuccessThreshold?: number;
}

export interface CircuitStatus {
  state: CircuitState;
  failureCount: number;
  nextAttemptTime: number;
  activeRequests: number;
}

export interface CircuitMetrics extends CircuitStatus {
  successCount: number;
  halfOpenSuccessCount: number;
  openedCount: number;
  rejectedCount: number;
}

export interface ExecuteOptions {
  signal?: AbortSignal;
}

const CONFIG_BOUNDS = {
  failureThreshold: { min: 1, max: 1000 },
  cooldownPeriod: { min: 1, max: 86_400_000 },
  maxRetries: { min: 0, max: 20 },
  initialRetryDelay: { min: 1, max: 60_000 },
  timeout: { min: 1, max: 300_000 },
  halfOpenSuccessThreshold: { min: 1, max: 100 },
} as const;

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

  private readonly failureThreshold: number;
  private readonly cooldownPeriod: number;
  private readonly maxRetries: number;
  private readonly initialRetryDelay: number;
  private readonly isExpectedError?: (error: unknown) => boolean;
  private readonly timeout?: number;
  private readonly fallback?: CircuitConfig["fallback"];
  private readonly halfOpenSuccessThreshold: number;

  private readonly listeners = new Set<
    (state: CircuitState, details: { failureCount: number }) => void
  >();

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
  }

  async execute<T>(fn: ExecuteWork<T>, options?: ExecuteOptions): Promise<T> {
    const externalSignal = options?.signal;
    this.throwIfAborted(externalSignal);
    this.updateState();

    if (this.state === "OPEN") {
      const remainingTime = Math.max(0, this.nextAttemptTime - Date.now());
      const error = new CircuitOpenError(remainingTime);
      this.rejectedCount++;
      this.emitStateChange();
      return this.applyFallbackOrThrow<T>(error);
    }

    if (this.state === "HALF-OPEN" && this.halfOpenProbeActive) {
      const error = new CircuitHalfOpenThrottledError();
      this.rejectedCount++;
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
        try {
          const result = await this.runAttempt(fn, externalSignal);
          this.onSuccess();
          return result;
        } catch (error) {
          if (error instanceof CircuitAbortedError) {
            throw error;
          }

          if (this.isExpectedError && this.isExpectedError(error)) {
            throw error;
          }

          attempt++;

          if (attempt <= this.maxRetries && this.state === "CLOSED") {
            const backoffLimit =
              this.initialRetryDelay * Math.pow(2, attempt - 1);
            const jitteredDelay = Math.random() * backoffLimit;
            await this.sleep(jitteredDelay, externalSignal);
            continue;
          }

          this.onFailure();
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
    this.halfOpenProbeActive = false;

    if (
      previousState !== "CLOSED" ||
      previousFailureCount > 0 ||
      previousHalfOpenSuccessCount > 0
    ) {
      this.emitStateChange();
    }
  }

  private async applyFallbackOrThrow<T>(error: unknown): Promise<T> {
    if (this.fallback) {
      // Consumer owns the returned shape; cast is intentional at this boundary.
      return (await this.fallback(error, { state: this.state })) as T;
    }
    throw error;
  }

  private async runAttempt<T>(
    fn: ExecuteWork<T>,
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

        fn({ signal: controller.signal })
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
      });
    } finally {
      cleanup();
    }
  }

  private onSuccess() {
    const previousState = this.state;
    const previousFailureCount = this.failureCount;
    this.successCount++;

    if (this.state === "HALF-OPEN") {
      this.halfOpenSuccessCount++;
      this.failureCount = 0;

      if (this.halfOpenSuccessCount >= this.halfOpenSuccessThreshold) {
        this.halfOpenSuccessCount = 0;
        this.state = "CLOSED";
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

  private onFailure() {
    this.failureCount++;
    this.halfOpenSuccessCount = 0;

    if (
      this.state === "HALF-OPEN" ||
      this.failureCount >= this.failureThreshold
    ) {
      this.openedCount++;
      this.changeState("OPEN", Date.now() + this.cooldownPeriod);
    } else {
      this.emitStateChange();
    }
  }

  private updateState() {
    if (this.state === "OPEN" && Date.now() > this.nextAttemptTime) {
      this.halfOpenSuccessCount = 0;
      this.changeState("HALF-OPEN", 0);
    }
  }

  private changeState(newState: CircuitState, nextAttemptTime: number) {
    this.state = newState;
    this.nextAttemptTime = nextAttemptTime;
    this.emitStateChange();
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
  CircuitHalfOpenThrottledError,
  CircuitOpenError,
  CircuitTimeoutError,
  isCircuitError,
} from "./errors.js";
