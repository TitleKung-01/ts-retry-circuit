import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  CircuitBreaker,
  CircuitRegistry,
  CircuitOpenError,
  CircuitTimeoutError,
  CircuitAbortedError,
  isCircuitError,
} from "../core.js";

describe("CircuitBreaker Core", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should initialize in CLOSED state", () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 3,
      cooldownPeriod: 1000,
    });
    const status = breaker.getStatus();

    expect(status.state).toBe("CLOSED");
    expect(status.failureCount).toBe(0);
    expect(status.activeRequests).toBe(0);
  });

  it("should return result when executed function succeeds", async () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 3,
      cooldownPeriod: 1000,
    });
    const fn = vi.fn().mockResolvedValue("success");

    const result = await breaker.execute(fn);

    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(breaker.getStatus().failureCount).toBe(0);
  });

  it("should retry up to maxRetries on failure while CLOSED", async () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 3,
      cooldownPeriod: 1000,
      maxRetries: 2,
      initialRetryDelay: 100,
    });
    const fn = vi.fn().mockRejectedValue(new Error("fail"));

    const promise = breaker.execute(fn);
    const assertion = expect(promise).rejects.toThrow("fail");

    await vi.runAllTimersAsync();
    await assertion;

    expect(fn).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
    expect(breaker.getStatus().failureCount).toBe(1);
  });

  it("should transition to OPEN after failureThreshold reached", async () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 2,
      cooldownPeriod: 1000,
      maxRetries: 0,
    });
    const fn = vi.fn().mockRejectedValue(new Error("fail"));

    await expect(breaker.execute(fn)).rejects.toThrow("fail");
    expect(breaker.getStatus().state).toBe("CLOSED");
    expect(breaker.getStatus().failureCount).toBe(1);

    await expect(breaker.execute(fn)).rejects.toThrow("fail");
    expect(breaker.getStatus().state).toBe("OPEN");
    expect(breaker.getStatus().failureCount).toBe(2);

    await expect(breaker.execute(fn)).rejects.toBeInstanceOf(CircuitOpenError);
  });

  it("should execute fallback when OPEN", async () => {
    const fallbackFn = vi.fn().mockReturnValue("fallback-val");
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      cooldownPeriod: 1000,
      maxRetries: 0,
      fallback: fallbackFn,
    });

    const fn = vi.fn().mockRejectedValue(new Error("fail"));

    // First attempt fails, trips circuit, executes fallback
    const result1 = await breaker.execute(fn);
    expect(result1).toBe("fallback-val");
    expect(breaker.getStatus().state).toBe("OPEN");

    // Second attempt directly executes fallback without calling fn
    const result2 = await breaker.execute(fn);
    expect(result2).toBe("fallback-val");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("should transition from OPEN to HALF-OPEN after cooldownPeriod", async () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      cooldownPeriod: 1000,
      maxRetries: 0,
    });
    const fn = vi.fn().mockRejectedValue(new Error("fail"));

    await expect(breaker.execute(fn)).rejects.toThrow("fail");
    expect(breaker.getStatus().state).toBe("OPEN");

    vi.advanceTimersByTime(1001);

    expect(breaker.getStatus().state).toBe("HALF-OPEN");
  });

  it("should transition from HALF-OPEN back to CLOSED after halfOpenSuccessThreshold is met", async () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      cooldownPeriod: 1000,
      maxRetries: 0,
      halfOpenSuccessThreshold: 2,
    });
    const failFn = vi.fn().mockRejectedValue(new Error("fail"));
    const successFn = vi.fn().mockResolvedValue("ok");

    await expect(breaker.execute(failFn)).rejects.toThrow("fail");
    expect(breaker.getStatus().state).toBe("OPEN");

    vi.advanceTimersByTime(1001);
    expect(breaker.getStatus().state).toBe("HALF-OPEN");

    await breaker.execute(successFn);
    expect(breaker.getStatus().state).toBe("HALF-OPEN");

    await breaker.execute(successFn);
    expect(breaker.getStatus().state).toBe("CLOSED");
  });

  it("should re-open immediately on failure while HALF-OPEN", async () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      cooldownPeriod: 1000,
      maxRetries: 0,
    });
    const fn = vi.fn().mockRejectedValue(new Error("fail"));

    await expect(breaker.execute(fn)).rejects.toThrow("fail");
    expect(breaker.getStatus().state).toBe("OPEN");

    vi.advanceTimersByTime(1001);
    expect(breaker.getStatus().state).toBe("HALF-OPEN");

    await expect(breaker.execute(fn)).rejects.toThrow("fail");
    expect(breaker.getStatus().state).toBe("OPEN");
  });

  it("should ignore expected errors when isExpectedError returns true", async () => {
    const isExpectedError = vi.fn().mockImplementation((err: unknown) => {
      return err instanceof Error && err.message === "expected";
    });

    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      cooldownPeriod: 1000,
      maxRetries: 0,
      isExpectedError,
    });

    const fn = vi.fn().mockRejectedValue(new Error("expected"));

    await expect(breaker.execute(fn)).rejects.toThrow("expected");
    expect(breaker.getStatus().failureCount).toBe(0);
    expect(breaker.getStatus().state).toBe("CLOSED");
  });

  it("should handle per-attempt timeout", async () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      cooldownPeriod: 1000,
      maxRetries: 0,
      timeout: 500,
    });

    const slowFn = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve("slow"), 1000);
        }),
    );

    const promise = breaker.execute(slowFn);
    const assertion =
      expect(promise).rejects.toBeInstanceOf(CircuitTimeoutError);

    await vi.advanceTimersByTimeAsync(500);
    await assertion;

    expect(breaker.getStatus().failureCount).toBe(1);
  });

  it("should handle external abort signal", async () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 3,
      cooldownPeriod: 1000,
    });

    const controller = new AbortController();
    controller.abort();

    const fn = vi.fn().mockResolvedValue("ok");

    await expect(
      breaker.execute(fn, { signal: controller.signal }),
    ).rejects.toBeInstanceOf(CircuitAbortedError);
    expect(fn).not.toHaveBeenCalled();
  });

  it("should notify state change listeners", async () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      cooldownPeriod: 1000,
      maxRetries: 0,
    });

    const listener = vi.fn();
    const unsubscribe = breaker.subscribe(listener);

    const fn = vi.fn().mockRejectedValue(new Error("fail"));
    await expect(breaker.execute(fn)).rejects.toThrow("fail");

    expect(listener).toHaveBeenCalledWith("OPEN", expect.anything());

    unsubscribe();
  });

  it("should support reset() to return to CLOSED state", async () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      cooldownPeriod: 1000,
      maxRetries: 0,
    });

    const fn = vi.fn().mockRejectedValue(new Error("fail"));
    await expect(breaker.execute(fn)).rejects.toThrow("fail");
    expect(breaker.getStatus().state).toBe("OPEN");

    breaker.reset();
    expect(breaker.getStatus().state).toBe("CLOSED");
    expect(breaker.getStatus().failureCount).toBe(0);
    expect(breaker.getStatus().nextAttemptTime).toBe(0);

    await expect(breaker.execute(async () => "ok")).resolves.toBe("ok");
  });

  it("should validate constructor options", () => {
    expect(
      () => new CircuitBreaker({ failureThreshold: 0, cooldownPeriod: 1 }),
    ).toThrow(/failureThreshold/);
    expect(
      () => new CircuitBreaker({ failureThreshold: 1, cooldownPeriod: 0 }),
    ).toThrow(/cooldownPeriod/);
    expect(
      () =>
        new CircuitBreaker({
          failureThreshold: 1,
          cooldownPeriod: 1,
          timeout: 0,
        }),
    ).toThrow(/timeout/);
    expect(
      () =>
        new CircuitBreaker({
          failureThreshold: 1,
          cooldownPeriod: 1,
          capacity: 0,
        }),
    ).toThrow(/capacity/);
  });

  it("isCircuitError recognizes typed errors", () => {
    expect(isCircuitError(new CircuitOpenError(10))).toBe(true);
  });

  it("should pass abort signal to attempt and abort on timeout", async () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      cooldownPeriod: 1000,
      maxRetries: 0,
      timeout: 50,
    });

    let sawAbort = false;
    const promise = breaker.execute(({ signal }) => {
      return new Promise((resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            sawAbort = true;
            reject(new Error("aborted by signal"));
          },
          { once: true },
        );
        setTimeout(() => resolve("late"), 200);
      });
    });

    const assertion =
      expect(promise).rejects.toBeInstanceOf(CircuitTimeoutError);
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
    expect(sawAbort).toBe(true);
    expect(breaker.getMetrics().timeoutCount).toBe(1);
  });

  it("should track richer metrics", async () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 5,
      cooldownPeriod: 1000,
      maxRetries: 1,
      initialRetryDelay: 10,
    });

    let calls = 0;
    const promise = breaker.execute(async () => {
      calls++;
      if (calls === 1) throw new Error("once");
      return "ok";
    });
    await vi.runAllTimersAsync();
    await promise;

    const metrics = breaker.getMetrics();
    expect(metrics.successCount).toBe(1);
    expect(metrics.retryCount).toBe(1);
    expect(metrics.attemptCount).toBe(2);
    expect(metrics.totalDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("should support concurrent CLOSED executions", async () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 5,
      cooldownPeriod: 1000,
      maxRetries: 0,
    });

    const results = await Promise.all([
      breaker.execute(async () => "a"),
      breaker.execute(async () => "b"),
      breaker.execute(async () => "c"),
    ]);
    expect(results).toEqual(["a", "b", "c"]);
    expect(breaker.getStatus().activeRequests).toBe(0);
  });

  it("should abort work when the caller signal aborts mid-flight", async () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 2,
      cooldownPeriod: 1000,
      maxRetries: 0,
    });

    const controller = new AbortController();
    let sawAbort = false;

    const promise = breaker.execute(
      ({ signal }) =>
        new Promise((resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              sawAbort = true;
              reject(new Error("aborted"));
            },
            { once: true },
          );
          setTimeout(() => resolve("done"), 5_000);
        }),
      { signal: controller.signal },
    );

    const assertion =
      expect(promise).rejects.toBeInstanceOf(CircuitAbortedError);
    controller.abort();
    await assertion;
    expect(sawAbort).toBe(true);
  });

  it("should support rolling strategy and open when failure percentage threshold is met", async () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 10,
      cooldownPeriod: 1000,
      maxRetries: 0,
      strategy: "rolling",
      volumeThreshold: 4,
      errorThresholdPercentage: 50,
      rollingWindowMs: 10000,
      rollingBuckets: 5,
    });

    const successFn = vi.fn().mockResolvedValue("ok");
    const failFn = vi.fn().mockRejectedValue(new Error("fail"));

    // 2 successes, 1 failure -> 33% fail (volume 3 < volumeThreshold 4) -> stays CLOSED
    await breaker.execute(successFn);
    await breaker.execute(successFn);
    await expect(breaker.execute(failFn)).rejects.toThrow("fail");
    expect(breaker.getStatus().state).toBe("CLOSED");

    // 2nd failure -> 2 successes + 2 failures = 4 total, 50% fail -> trips OPEN
    await expect(breaker.execute(failFn)).rejects.toThrow("fail");
    expect(breaker.getStatus().state).toBe("OPEN");
  });

  it("should enforce capacity bulkhead limits", async () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 5,
      cooldownPeriod: 1000,
      maxRetries: 0,
      capacity: 1,
    });

    let releaseFirst: () => void = () => {};
    const firstPromise = breaker.execute(
      () =>
        new Promise((resolve) => {
          releaseFirst = () => resolve("done");
        }),
    );

    expect(breaker.getStatus().activeRequests).toBe(1);

    // Second execution should be rejected by capacity
    await expect(breaker.execute(async () => "blocked")).rejects.toThrow(
      /Capacity limit/,
    );

    releaseFirst();
    await firstPromise;
    expect(breaker.getStatus().activeRequests).toBe(0);
  });

  it("should throttle concurrent requests in HALF-OPEN state", async () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      cooldownPeriod: 1000,
      maxRetries: 0,
    });

    const failFn = vi.fn().mockRejectedValue(new Error("fail"));
    await expect(breaker.execute(failFn)).rejects.toThrow("fail");
    expect(breaker.getStatus().state).toBe("OPEN");

    vi.advanceTimersByTime(1001);
    expect(breaker.getStatus().state).toBe("HALF-OPEN");

    let resolveProbe: () => void = () => {};
    const probePromise = breaker.execute(
      () =>
        new Promise((resolve) => {
          resolveProbe = () => resolve("ok");
        }),
    );

    // Second request while probe is active in HALF-OPEN should be throttled
    await expect(breaker.execute(async () => "concurrent")).rejects.toThrow(
      /HALF-OPEN/,
    );

    resolveProbe();
    await probePromise;
  });

  it("should manage breakers via CircuitRegistry and static helpers", () => {
    const breaker1 = new CircuitBreaker({
      name: "payment-service",
      failureThreshold: 3,
      cooldownPeriod: 1000,
    });

    expect(CircuitBreaker.get("payment-service")).toBe(breaker1);
    expect(
      CircuitRegistry.getOrCreate("payment-service", {
        failureThreshold: 3,
        cooldownPeriod: 1000,
      }),
    ).toBe(breaker1);

    const created = CircuitRegistry.getOrCreate("user-service", {
      failureThreshold: 2,
      cooldownPeriod: 500,
    });
    expect(created.getStatus().name).toBe("user-service");

    expect(CircuitBreaker.release("user-service")).toBe(true);
    expect(() => CircuitBreaker.get("user-service")).toThrow(/not registered/);

    CircuitBreaker.release("payment-service");
  });

  it("should support lifecycle event registration and removal", async () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      cooldownPeriod: 1000,
      maxRetries: 0,
    });

    const openHandler = vi.fn();
    const closeHandler = vi.fn();
    const offOpen = breaker.on("open", openHandler);
    const offClose = breaker.on("close", closeHandler);

    await expect(
      breaker.execute(async () => {
        throw new Error("fail");
      }),
    ).rejects.toThrow("fail");
    expect(openHandler).toHaveBeenCalledTimes(1);

    breaker.reset();
    expect(closeHandler).toHaveBeenCalledTimes(1);

    offOpen();
    offClose();
  });

  it("should validate all invalid configuration bounds", () => {
    expect(
      () =>
        new CircuitBreaker({
          failureThreshold: 1,
          cooldownPeriod: 1000,
          strategy: "rolling",
          errorThresholdPercentage: 150,
        }),
    ).toThrow(/errorThresholdPercentage/);

    expect(
      () =>
        new CircuitBreaker({
          failureThreshold: 1,
          cooldownPeriod: 1000,
          strategy: "rolling",
          volumeThreshold: 0,
        }),
    ).toThrow(/volumeThreshold/);

    expect(
      () =>
        new CircuitBreaker({
          failureThreshold: 1,
          cooldownPeriod: 1000,
          strategy: "rolling",
          rollingWindowMs: 0,
        }),
    ).toThrow(/rollingWindowMs/);

    expect(
      () =>
        new CircuitBreaker({
          failureThreshold: 1,
          cooldownPeriod: 1000,
          strategy: "rolling",
          rollingBuckets: 0,
        }),
    ).toThrow(/rollingBuckets/);
  });
});
