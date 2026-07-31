import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  CircuitBreaker,
  CircuitOpenError,
  CircuitHalfOpenThrottledError,
  CircuitTimeoutError,
  CircuitAbortedError,
} from "../core.js";

describe("CircuitBreaker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should successfully execute a function when CLOSED", async () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 2,
      cooldownPeriod: 1000,
    });
    const fn = vi.fn().mockResolvedValue("success");
    const result = await breaker.execute(fn);
    expect(result).toBe("success");
    expect(breaker.getStatus().state).toBe("CLOSED");
    expect(breaker.getStatus().failureCount).toBe(0);
    expect(breaker.getMetrics().successCount).toBe(1);
  });

  it("should transition to OPEN after failureThreshold is reached", async () => {
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
    expect(breaker.getMetrics().openedCount).toBe(1);

    await expect(breaker.execute(fn)).rejects.toBeInstanceOf(CircuitOpenError);
  });

  it("should expose retryAfterMs on CircuitOpenError", async () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      cooldownPeriod: 5000,
      maxRetries: 0,
    });
    const fn = vi.fn().mockRejectedValue(new Error("fail"));
    await expect(breaker.execute(fn)).rejects.toThrow("fail");

    try {
      await breaker.execute(fn);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(CircuitOpenError);
      expect((error as CircuitOpenError).code).toBe("CIRCUIT_OPEN");
      expect((error as CircuitOpenError).retryAfterMs).toBeGreaterThan(0);
      expect((error as CircuitOpenError).retryAfterMs).toBeLessThanOrEqual(
        5000,
      );
    }

    expect(breaker.getMetrics().rejectedCount).toBe(1);
  });

  it("should retry when failing in CLOSED state", async () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 2,
      cooldownPeriod: 1000,
      maxRetries: 2,
      initialRetryDelay: 10,
    });

    let calls = 0;
    const fn = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls < 3) {
        throw new Error("fail");
      }
      return "success";
    });

    const promise = breaker.execute(fn);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(breaker.getStatus().state).toBe("CLOSED");
    expect(breaker.getStatus().failureCount).toBe(0);
  });

  it("should bypass failures if error is expected", async () => {
    const isExpectedError = (err: unknown) => {
      return err instanceof Error && err.message === "expected";
    };

    const breaker = new CircuitBreaker({
      failureThreshold: 2,
      cooldownPeriod: 1000,
      isExpectedError,
      maxRetries: 0,
    });

    const fn = vi.fn().mockRejectedValue(new Error("expected"));

    await expect(breaker.execute(fn)).rejects.toThrow("expected");
    expect(breaker.getStatus().state).toBe("CLOSED");
    expect(breaker.getStatus().failureCount).toBe(0);
  });

  it("should not use fallback for expected errors", async () => {
    const fallback = vi.fn().mockResolvedValue("fallback");
    const breaker = new CircuitBreaker({
      failureThreshold: 2,
      cooldownPeriod: 1000,
      maxRetries: 0,
      isExpectedError: () => true,
      fallback,
    });

    await expect(
      breaker.execute(async () => {
        throw new Error("expected");
      }),
    ).rejects.toThrow("expected");
    expect(fallback).not.toHaveBeenCalled();
  });

  it("should enter HALF-OPEN after cooldown and close on success", async () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      cooldownPeriod: 1000,
      maxRetries: 0,
    });

    await expect(
      breaker.execute(async () => {
        throw new Error("fail");
      }),
    ).rejects.toThrow("fail");
    expect(breaker.getStatus().state).toBe("OPEN");

    await vi.advanceTimersByTimeAsync(1001);
    expect(breaker.getStatus().state).toBe("HALF-OPEN");

    const result = await breaker.execute(async () => "recovered");
    expect(result).toBe("recovered");
    expect(breaker.getStatus().state).toBe("CLOSED");
  });

  it("should re-open on HALF-OPEN failure", async () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      cooldownPeriod: 1000,
      maxRetries: 0,
    });

    await expect(
      breaker.execute(async () => {
        throw new Error("fail");
      }),
    ).rejects.toThrow("fail");

    await vi.advanceTimersByTimeAsync(1001);
    expect(breaker.getStatus().state).toBe("HALF-OPEN");

    await expect(
      breaker.execute(async () => {
        throw new Error("still down");
      }),
    ).rejects.toThrow("still down");

    expect(breaker.getStatus().state).toBe("OPEN");
    expect(breaker.getMetrics().openedCount).toBe(2);
  });

  it("should throttle concurrent HALF-OPEN probes", async () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      cooldownPeriod: 1000,
      maxRetries: 0,
    });

    await expect(
      breaker.execute(async () => {
        throw new Error("fail");
      }),
    ).rejects.toThrow("fail");

    await vi.advanceTimersByTimeAsync(1001);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = breaker.execute(async () => {
      await gate;
      return "ok";
    });

    await Promise.resolve();
    await expect(breaker.execute(async () => "second")).rejects.toBeInstanceOf(
      CircuitHalfOpenThrottledError,
    );

    expect(breaker.getMetrics().rejectedCount).toBe(1);

    release();
    await expect(first).resolves.toBe("ok");
    expect(breaker.getStatus().state).toBe("CLOSED");
  });

  it("should not retry in HALF-OPEN", async () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      cooldownPeriod: 1000,
      maxRetries: 3,
      initialRetryDelay: 10,
    });

    const openPromise = breaker.execute(async () => {
      throw new Error("fail");
    });
    const openExpectation = expect(openPromise).rejects.toThrow("fail");
    await vi.runAllTimersAsync();
    await openExpectation;

    await vi.advanceTimersByTimeAsync(1001);

    const fn = vi.fn().mockRejectedValue(new Error("probe fail"));
    await expect(breaker.execute(fn)).rejects.toThrow("probe fail");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(breaker.getStatus().state).toBe("OPEN");
  });

  it("should timeout and count as failure", async () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      cooldownPeriod: 1000,
      maxRetries: 0,
      timeout: 50,
    });

    const promise = breaker.execute(
      () => new Promise((resolve) => setTimeout(() => resolve("late"), 200)),
    );

    const assertion =
      expect(promise).rejects.toBeInstanceOf(CircuitTimeoutError);
    await vi.advanceTimersByTimeAsync(50);
    await assertion;

    expect(breaker.getStatus().state).toBe("OPEN");
  });

  it("should use fallback when OPEN", async () => {
    const fallback = vi.fn((error: unknown) => {
      if (error instanceof CircuitOpenError) return "cached";
      throw error;
    });
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      cooldownPeriod: 5000,
      maxRetries: 0,
      fallback,
    });

    await expect(
      breaker.execute(async () => {
        throw new Error("fail");
      }),
    ).rejects.toThrow("fail");

    const result = await breaker.execute(async () => "should-not-run");
    expect(result).toBe("cached");
    expect(fallback).toHaveBeenCalledTimes(2);
    expect(fallback.mock.calls[1][0]).toBeInstanceOf(CircuitOpenError);
  });

  it("should use fallback after final failure", async () => {
    const fallback = vi.fn().mockReturnValue("degraded");
    const breaker = new CircuitBreaker({
      failureThreshold: 5,
      cooldownPeriod: 1000,
      maxRetries: 0,
      fallback,
    });

    const result = await breaker.execute(async () => {
      throw new Error("boom");
    });

    expect(result).toBe("degraded");
    expect(fallback.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(breaker.getStatus().failureCount).toBe(1);
  });

  it("should abort during retry sleep when signal aborts", async () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 5,
      cooldownPeriod: 1000,
      maxRetries: 2,
      initialRetryDelay: 1000,
    });

    const controller = new AbortController();
    const promise = breaker.execute(
      async () => {
        throw new Error("transient");
      },
      { signal: controller.signal },
    );

    await vi.advanceTimersByTimeAsync(1);
    controller.abort();

    await expect(promise).rejects.toBeInstanceOf(CircuitAbortedError);
  });

  it("should reject immediately when signal is already aborted", async () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 2,
      cooldownPeriod: 1000,
    });
    const controller = new AbortController();
    controller.abort();

    await expect(
      breaker.execute(async () => "ok", { signal: controller.signal }),
    ).rejects.toBeInstanceOf(CircuitAbortedError);
  });

  it("should require halfOpenSuccessThreshold successes before CLOSED", async () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      cooldownPeriod: 1000,
      maxRetries: 0,
      halfOpenSuccessThreshold: 2,
    });

    await expect(
      breaker.execute(async () => {
        throw new Error("fail");
      }),
    ).rejects.toThrow("fail");

    await vi.advanceTimersByTimeAsync(1001);

    await expect(breaker.execute(async () => "one")).resolves.toBe("one");
    expect(breaker.getStatus().state).toBe("HALF-OPEN");
    expect(breaker.getMetrics().halfOpenSuccessCount).toBe(1);

    await expect(breaker.execute(async () => "two")).resolves.toBe("two");
    expect(breaker.getStatus().state).toBe("CLOSED");
    expect(breaker.getMetrics().halfOpenSuccessCount).toBe(0);
  });

  it("should notify subscribers and support unsubscribe", async () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      cooldownPeriod: 1000,
      maxRetries: 0,
    });

    const listener = vi.fn();
    const unsubscribe = breaker.subscribe(listener);

    await expect(
      breaker.execute(async () => {
        throw new Error("fail");
      }),
    ).rejects.toThrow("fail");

    expect(listener).toHaveBeenCalled();
    const callsBefore = listener.mock.calls.length;
    unsubscribe();

    await expect(breaker.execute(async () => "x")).rejects.toBeInstanceOf(
      CircuitOpenError,
    );
    expect(listener.mock.calls.length).toBe(callsBefore);
  });

  it("should reset state and counters", async () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      cooldownPeriod: 1000,
      maxRetries: 0,
    });

    await expect(
      breaker.execute(async () => {
        throw new Error("fail");
      }),
    ).rejects.toThrow("fail");
    expect(breaker.getStatus().state).toBe("OPEN");

    breaker.reset();
    expect(breaker.getStatus().state).toBe("CLOSED");
    expect(breaker.getStatus().failureCount).toBe(0);
    expect(breaker.getStatus().nextAttemptTime).toBe(0);

    await expect(breaker.execute(async () => "ok")).resolves.toBe("ok");
  });
});
