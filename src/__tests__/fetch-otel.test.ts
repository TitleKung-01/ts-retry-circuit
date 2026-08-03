import { describe, it, expect, vi, afterEach } from "vitest";
import { CircuitBreaker, CircuitRegistry } from "../core.js";
import {
  withCircuit,
  createCircuitFetch,
  circuitFetchFromConfig,
} from "../fetch.js";
import { instrumentCircuitBreaker, tracedExecute } from "../otel.js";

describe("fetch helpers", () => {
  afterEach(() => {
    CircuitRegistry.clear();
    vi.unstubAllGlobals();
  });

  it("withCircuit forwards to breaker.execute", async () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 2,
      cooldownPeriod: 1000,
    });
    const result = await withCircuit(breaker, async () => "ok");
    expect(result).toBe("ok");
  });

  it("createCircuitFetch fails on HTTP errors and passes signal", async () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 2,
      cooldownPeriod: 1000,
      maxRetries: 0,
    });

    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "ERR",
    });
    vi.stubGlobal("fetch", fetchMock);

    const circuitFetch = createCircuitFetch(breaker);
    await expect(circuitFetch("https://example.com")).rejects.toThrow(
      /HTTP 500/,
    );
    expect(fetchMock).toHaveBeenCalled();
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it("createCircuitFetch allows expected statuses", async () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      cooldownPeriod: 1000,
      maxRetries: 0,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: "Not Found",
      }),
    );

    const circuitFetch = createCircuitFetch(breaker);
    const res = await circuitFetch("https://example.com/missing", {
      expectedStatuses: [404],
    });
    expect(res.status).toBe(404);
    expect(breaker.getStatus().state).toBe("CLOSED");
  });
});

describe("otel helpers", () => {
  it("instrumentCircuitBreaker records counters", async () => {
    const add = vi.fn();
    const record = vi.fn();
    const breaker = new CircuitBreaker({
      failureThreshold: 2,
      cooldownPeriod: 1000,
      name: "otel-test",
    });

    const stop = instrumentCircuitBreaker(breaker, {
      meter: {
        createCounter: () => ({ add }),
        createHistogram: () => ({ record }),
      },
    });

    await breaker.execute(async () => "ok");
    expect(add).toHaveBeenCalled();
    stop();
  });

  it("tracedExecute wraps spans", async () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 2,
      cooldownPeriod: 1000,
      name: "traced",
    });
    const span = {
      setAttribute: vi.fn(),
      recordException: vi.fn(),
      setStatus: vi.fn(),
      end: vi.fn(),
    };
    const tracer = {
      startActiveSpan: vi.fn(async (_name, fn) => fn(span)),
    };

    const result = await tracedExecute(breaker, tracer, async () => "ok");
    expect(result).toBe("ok");
    expect(span.end).toHaveBeenCalled();
    expect(span.setAttribute).toHaveBeenCalled();
  });

  it("tracedExecute handles errors and records span exceptions", async () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 2,
      cooldownPeriod: 1000,
      name: "traced-err",
    });
    const span = {
      setAttribute: vi.fn(),
      recordException: vi.fn(),
      setStatus: vi.fn(),
      end: vi.fn(),
    };
    const tracer = {
      startActiveSpan: vi.fn(async (_name, fn) => fn(span)),
    };

    await expect(
      tracedExecute(breaker, tracer, async () => {
        throw new Error("traced fail");
      }),
    ).rejects.toThrow("traced fail");

    expect(span.recordException).toHaveBeenCalled();
    expect(span.setStatus).toHaveBeenCalledWith({
      code: 2,
      message: "Error: traced fail",
    });
    expect(span.end).toHaveBeenCalled();
  });

  it("circuitFetchFromConfig creates fetch helper from config", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
      }),
    );

    const circuitFetch = circuitFetchFromConfig({
      name: "config-fetch",
      failureThreshold: 2,
      cooldownPeriod: 1000,
    });

    const res = await circuitFetch("https://example.com/test");
    expect(res.ok).toBe(true);
  });
});
