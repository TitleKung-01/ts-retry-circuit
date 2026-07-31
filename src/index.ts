export {
  CircuitBreaker,
  CircuitAbortedError,
  CircuitHalfOpenThrottledError,
  CircuitOpenError,
  CircuitTimeoutError,
  isCircuitError,
} from "./core.js";

export type {
  CircuitConfig,
  CircuitFallbackContext,
  CircuitMetrics,
  CircuitState,
  CircuitStatus,
  ExecuteOptions,
} from "./core.js";

export type { CircuitErrorCode } from "./errors.js";
