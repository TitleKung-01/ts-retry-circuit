import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useCircuitBreaker, releaseInstance } from "../react.js";

describe("useCircuitBreaker", () => {
  afterEach(() => {
    releaseInstance("shared-key");
    releaseInstance("release-key");
    releaseInstance("reuse-key");
  });

  it("should initialize hook with correct default values", () => {
    const { result } = renderHook(() =>
      useCircuitBreaker({
        failureThreshold: 2,
        cooldownPeriod: 1000,
      }),
    );

    expect(result.current.state).toBe("CLOSED");
    expect(result.current.failureCount).toBe(0);
    expect(result.current.activeRequests).toBe(0);
    expect(result.current.isOpened).toBe(false);
    expect(result.current.isHalfOpen).toBe(false);
  });

  it("should successfully execute a promise-returning function", async () => {
    const { result } = renderHook(() =>
      useCircuitBreaker({
        failureThreshold: 2,
        cooldownPeriod: 1000,
      }),
    );

    const fn = vi.fn().mockResolvedValue("ok");
    let output: string | undefined;

    await act(async () => {
      output = await result.current.execute(fn);
    });

    expect(output).toBe("ok");
    expect(result.current.state).toBe("CLOSED");
    expect(result.current.failureCount).toBe(0);
  });

  it("should track failure count and open status upon failures", async () => {
    const { result } = renderHook(() =>
      useCircuitBreaker({
        failureThreshold: 2,
        cooldownPeriod: 1000,
        maxRetries: 0,
      }),
    );

    const fn = vi.fn().mockRejectedValue(new Error("fail"));

    await act(async () => {
      await expect(result.current.execute(fn)).rejects.toThrow("fail");
    });

    expect(result.current.failureCount).toBe(1);
    expect(result.current.state).toBe("CLOSED");

    await act(async () => {
      await expect(result.current.execute(fn)).rejects.toThrow("fail");
    });

    expect(result.current.failureCount).toBe(2);
    expect(result.current.state).toBe("OPEN");
    expect(result.current.isOpened).toBe(true);
  });

  it("should share state and trigger updates across multiple hooks sharing the same instanceKey", async () => {
    const { result: hook1 } = renderHook(() =>
      useCircuitBreaker({
        failureThreshold: 2,
        cooldownPeriod: 1000,
        maxRetries: 0,
        instanceKey: "shared-key",
      }),
    );

    const { result: hook2 } = renderHook(() =>
      useCircuitBreaker({
        failureThreshold: 2,
        cooldownPeriod: 1000,
        maxRetries: 0,
        instanceKey: "shared-key",
      }),
    );

    expect(hook1.current.state).toBe("CLOSED");
    expect(hook2.current.state).toBe("CLOSED");

    const fn = vi.fn().mockRejectedValue(new Error("fail"));

    await act(async () => {
      await expect(hook1.current.execute(fn)).rejects.toThrow("fail");
    });

    expect(hook1.current.failureCount).toBe(1);
    expect(hook2.current.failureCount).toBe(1);

    await act(async () => {
      await expect(hook2.current.execute(fn)).rejects.toThrow("fail");
    });

    expect(hook1.current.state).toBe("OPEN");
    expect(hook2.current.state).toBe("OPEN");
    expect(hook1.current.isOpened).toBe(true);
    expect(hook2.current.isOpened).toBe(true);
  });

  it("should reset shared circuit state from the hook", async () => {
    const { result } = renderHook(() =>
      useCircuitBreaker({
        failureThreshold: 1,
        cooldownPeriod: 1000,
        maxRetries: 0,
      }),
    );

    await act(async () => {
      await expect(
        result.current.execute(async () => {
          throw new Error("fail");
        }),
      ).rejects.toThrow("fail");
    });

    expect(result.current.isOpened).toBe(true);

    act(() => {
      result.current.reset();
    });

    expect(result.current.state).toBe("CLOSED");
    expect(result.current.isOpened).toBe(false);
    expect(result.current.failureCount).toBe(0);
  });

  it("should remove shared instances via releaseInstance", () => {
    const { unmount } = renderHook(() =>
      useCircuitBreaker({
        failureThreshold: 1,
        cooldownPeriod: 1000,
        instanceKey: "release-key",
      }),
    );

    expect(releaseInstance("release-key")).toBe(true);
    expect(releaseInstance("release-key")).toBe(false);
    unmount();
  });

  it("should reuse registry instance for the same key after remount", async () => {
    const first = renderHook(() =>
      useCircuitBreaker({
        failureThreshold: 1,
        cooldownPeriod: 5000,
        maxRetries: 0,
        instanceKey: "reuse-key",
      }),
    );

    await act(async () => {
      await expect(
        first.result.current.execute(async () => {
          throw new Error("fail");
        }),
      ).rejects.toThrow("fail");
    });

    expect(first.result.current.isOpened).toBe(true);
    first.unmount();

    const second = renderHook(() =>
      useCircuitBreaker({
        failureThreshold: 99,
        cooldownPeriod: 1,
        maxRetries: 0,
        instanceKey: "reuse-key",
      }),
    );

    expect(second.result.current.isOpened).toBe(true);
    expect(second.result.current.state).toBe("OPEN");
    second.unmount();
  });
});
