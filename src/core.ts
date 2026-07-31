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

export interface CircuitConfig {
  /** Consecutive failures required to transition to OPEN */
  failureThreshold: number;
  /** Milliseconds to stay OPEN before entering HALF-OPEN */
  cooldownPeriod: number;
  /** Max retries while CLOSED (default: 3) */
  maxRetries?: number;
  /** Initial delay in ms for exponential full-jitter backoff (default: 500) */
  initialRetryDelay?: number;
  /** Errors returning true are rethrown without counting as circuit failures */
  isExpectedError?: (error: unknown) => boolean;
  /** Per-attempt timeout in ms; timed-out attempts count as failures */
  timeout?: number;
  /**
   * Invoked when the circuit rejects (OPEN / HALF-OPEN throttle) or after
   * final counted failure. Not used for expected errors.
   */
  fallback?: (
    error: unknown,
    context: CircuitFallbackContext,
  ) => unknown | Promise<unknown>;
  /** Successes required in HALF-OPEN before returning to CLOSED (default: 1) */
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

export class CircuitBreaker {
  private state: CircuitState = "CLOSED";
  private failureCount: number = 0;
  private halfOpenSuccessCount: number = 0;
  private nextAttemptTime: number = 0;
  private activeRequests: number = 0;
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

    this.failureThreshold = config.failureThreshold;
    this.cooldownPeriod = config.cooldownPeriod;
    this.maxRetries = config.maxRetries ?? 3;
    this.initialRetryDelay = config.initialRetryDelay ?? 500;
    this.isExpectedError = config.isExpectedError;
    this.timeout = config.timeout;
    this.fallback = config.fallback;
    this.halfOpenSuccessThreshold = config.halfOpenSuccessThreshold ?? 1;
  }

  async execute<T>(fn: () => Promise<T>, options?: ExecuteOptions): Promise<T> {
    const signal = options?.signal;
    this.throwIfAborted(signal);
    this.updateState();

    if (this.state === "OPEN") {
      const remainingTime = Math.max(0, this.nextAttemptTime - Date.now());
      const error = new CircuitOpenError(remainingTime);
      this.rejectedCount++;
      this.emitStateChange();
      return this.applyFallbackOrThrow<T>(error);
    }

    if (this.state === "HALF-OPEN" && this.activeRequests > 0) {
      const error = new CircuitHalfOpenThrottledError();
      this.rejectedCount++;
      this.emitStateChange();
      return this.applyFallbackOrThrow<T>(error);
    }

    this.activeRequests++;
    this.emitStateChange();
    let attempt = 0;

    try {
      while (true) {
        this.throwIfAborted(signal);
        try {
          const result = await this.runAttempt(fn, signal);
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
            await this.sleep(jitteredDelay, signal);
            continue;
          }

          this.onFailure();
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
      return (await this.fallback(error, { state: this.state })) as T;
    }
    throw error;
  }

  private async runAttempt<T>(
    fn: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    this.throwIfAborted(signal);

    if (this.timeout === undefined) {
      return this.raceWithAbort(fn(), signal);
    }

    const timeoutMs = this.timeout;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    try {
      return await new Promise<T>((resolve, reject) => {
        const onAbort = () => {
          cleanup();
          reject(new CircuitAbortedError());
        };

        const cleanup = () => {
          if (timeoutId !== undefined) clearTimeout(timeoutId);
          signal?.removeEventListener("abort", onAbort);
        };

        timeoutId = setTimeout(() => {
          cleanup();
          reject(new CircuitTimeoutError(timeoutMs));
        }, timeoutMs);

        if (signal) {
          if (signal.aborted) {
            cleanup();
            reject(new CircuitAbortedError());
            return;
          }
          signal.addEventListener("abort", onAbort, { once: true });
        }

        fn()
          .then((value) => {
            cleanup();
            resolve(value);
          })
          .catch((err: unknown) => {
            cleanup();
            reject(err);
          });
      });
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
  }

  private raceWithAbort<T>(
    promise: Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (!signal) return promise;

    return new Promise<T>((resolve, reject) => {
      if (signal.aborted) {
        reject(new CircuitAbortedError());
        return;
      }

      const onAbort = () => {
        signal.removeEventListener("abort", onAbort);
        reject(new CircuitAbortedError());
      };

      signal.addEventListener("abort", onAbort, { once: true });

      promise
        .then((value) => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        })
        .catch((err: unknown) => {
          signal.removeEventListener("abort", onAbort);
          reject(err);
        });
    });
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
