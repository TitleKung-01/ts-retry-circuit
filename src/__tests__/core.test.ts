import { describe, it, expect, vi } from "vitest";
import { CircuitBreaker } from "../core.js";

describe("CircuitBreaker", () => {
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

    // Subsequent requests should fail immediately
    await expect(breaker.execute(fn)).rejects.toThrow("Circuit is OPEN");
  });

  it("should retry when failing in CLOSED state", async () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 2,
      cooldownPeriod: 1000,
      maxRetries: 2,
      initialRetryDelay: 1,
    });

    let calls = 0;
    const fn = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls < 3) {
        throw new Error("fail");
      }
      return "success";
    });

    const result = await breaker.execute(fn);
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
});
