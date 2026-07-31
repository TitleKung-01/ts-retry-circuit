export type CircuitErrorCode =
  | "CIRCUIT_OPEN"
  | "CIRCUIT_HALF_OPEN_THROTTLED"
  | "CIRCUIT_TIMEOUT"
  | "CIRCUIT_ABORTED";

export class CircuitOpenError extends Error {
  readonly code = "CIRCUIT_OPEN" as const;
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super(
      `[CircuitBreaker] Circuit is OPEN. Request blocked. Retry available in ${retryAfterMs}ms.`,
    );
    this.name = "CircuitOpenError";
    this.retryAfterMs = retryAfterMs;
  }
}

export class CircuitHalfOpenThrottledError extends Error {
  readonly code = "CIRCUIT_HALF_OPEN_THROTTLED" as const;

  constructor() {
    super(
      "[CircuitBreaker] Circuit is HALF-OPEN and testing. Request throttled.",
    );
    this.name = "CircuitHalfOpenThrottledError";
  }
}

export class CircuitTimeoutError extends Error {
  readonly code = "CIRCUIT_TIMEOUT" as const;
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`[CircuitBreaker] Operation timed out after ${timeoutMs}ms.`);
    this.name = "CircuitTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export class CircuitAbortedError extends Error {
  readonly code = "CIRCUIT_ABORTED" as const;

  constructor() {
    super("[CircuitBreaker] Operation was aborted.");
    this.name = "CircuitAbortedError";
  }
}

export function isCircuitError(
  error: unknown,
): error is
  | CircuitOpenError
  | CircuitHalfOpenThrottledError
  | CircuitTimeoutError
  | CircuitAbortedError {
  return (
    error instanceof CircuitOpenError ||
    error instanceof CircuitHalfOpenThrottledError ||
    error instanceof CircuitTimeoutError ||
    error instanceof CircuitAbortedError
  );
}
