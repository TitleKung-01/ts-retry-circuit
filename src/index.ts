export {
  CircuitBreaker,
  CircuitRegistry,
  CircuitAbortedError,
  CircuitCapacityRejectedError,
  CircuitHalfOpenThrottledError,
  CircuitOpenError,
  CircuitTimeoutError,
  isCircuitError,
} from "./core.js";

export type {
  CircuitConfig,
  CircuitEvent,
  CircuitEventHandler,
  CircuitEventPayload,
  CircuitFallbackContext,
  CircuitMetrics,
  CircuitState,
  CircuitStatus,
  CircuitTripStrategy,
  ExecuteOptions,
} from "./core.js";

export type { CircuitErrorCode } from "./errors.js";

export {
  withCircuit,
  createCircuitFetch,
  circuitFetchFromConfig,
} from "./fetch.js";

export type { WithCircuitOptions, CircuitFetchInit } from "./fetch.js";
