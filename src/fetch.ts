import {
  CircuitBreaker,
  type CircuitConfig,
  type ExecuteOptions,
} from "./core.js";

export interface WithCircuitOptions extends ExecuteOptions {
  breaker: CircuitBreaker;
}

/**
 * Run an async function through a circuit breaker, forwarding AbortSignal.
 */
export async function withCircuit<T>(
  breaker: CircuitBreaker,
  fn: (signal: AbortSignal) => Promise<T>,
  options?: ExecuteOptions,
): Promise<T> {
  return breaker.execute(fn, options);
}

export interface CircuitFetchInit extends RequestInit {
  /** Treat these HTTP statuses as expected (do not trip the circuit) */
  expectedStatuses?: number[];
  /** Treat statuses outside ok as failures (default true) */
  failOnHttpError?: boolean;
}

/**
 * Create a fetch wrapper bound to a CircuitBreaker.
 * The attempt AbortSignal is merged into the Request so timeouts cancel in-flight HTTP.
 */
export function createCircuitFetch(breaker: CircuitBreaker) {
  return async function circuitFetch(
    input: RequestInfo | URL,
    init?: CircuitFetchInit,
  ): Promise<Response> {
    const {
      expectedStatuses = [],
      failOnHttpError = true,
      signal: userSignal,
      ...rest
    } = init ?? {};

    return breaker.execute(
      async (signal) => {
        const merged: AbortSignal =
          typeof AbortSignal.any === "function" && userSignal
            ? AbortSignal.any([signal, userSignal])
            : signal;

        const response = await fetch(input, { ...rest, signal: merged });

        if (!response.ok && failOnHttpError) {
          if (expectedStatuses.includes(response.status)) {
            return response;
          }
          throw new Error(`HTTP ${response.status} ${response.statusText}`);
        }

        return response;
      },
      { signal: userSignal ?? undefined },
    );
  };
}

/**
 * One-shot helper: build a breaker from config and return a circuit-aware fetch.
 */
export function circuitFetchFromConfig(config: CircuitConfig) {
  return createCircuitFetch(new CircuitBreaker(config));
}
