// src/react.ts
import { useState, useEffect, useCallback, useRef } from "react";
import {
  CircuitBreaker,
  CircuitConfig,
  CircuitState,
  ExecuteOptions,
  ExecuteWork,
} from "./core.js";

const INSTANCE_KEY_PATTERN = /^[a-zA-Z0-9:_./-]+$/;
const INSTANCE_KEY_MAX_LENGTH = 128;

export function assertInstanceKey(instanceKey: string): void {
  if (
    instanceKey.length === 0 ||
    instanceKey.length > INSTANCE_KEY_MAX_LENGTH ||
    !INSTANCE_KEY_PATTERN.test(instanceKey)
  ) {
    throw new Error(
      `instanceKey must be 1..${INSTANCE_KEY_MAX_LENGTH} chars matching ${INSTANCE_KEY_PATTERN}`,
    );
  }
}

export interface UseCircuitBreakerOptions extends CircuitConfig {
  /**
   * Share one CircuitBreaker across components.
   * Config is frozen at the first registration for a given key;
   * later mounts with the same key reuse that instance and ignore new config.
   *
   * Use a stable dependency name (e.g. `"payments"`). Do not derive keys from
   * end-user ids.
   */
  instanceKey?: string;
}

export interface UseCircuitBreakerResult {
  state: CircuitState;
  failureCount: number;
  activeRequests: number;
  execute: <T>(fn: ExecuteWork<T>, options?: ExecuteOptions) => Promise<T>;
  /**
   * Force CLOSED and clear consecutive failures.
   *
   * @remarks Dangerous in production UI — ops, admin tools, and tests only.
   */
  reset: () => void;
  isOpened: boolean;
  isHalfOpen: boolean;
}

type RegistryEntry = {
  breaker: CircuitBreaker;
  refCount: number;
};

const breakerRegistry = new Map<string, RegistryEntry>();

function ensureSharedBreaker(
  instanceKey: string,
  config: CircuitConfig,
): CircuitBreaker {
  assertInstanceKey(instanceKey);

  const existing = breakerRegistry.get(instanceKey);
  if (existing) {
    return existing.breaker;
  }

  const breaker = new CircuitBreaker(config);
  breakerRegistry.set(instanceKey, { breaker, refCount: 0 });
  return breaker;
}

function retainSharedBreaker(
  instanceKey: string,
  breaker: CircuitBreaker,
): void {
  const entry = breakerRegistry.get(instanceKey);
  if (entry) {
    entry.refCount += 1;
    return;
  }
  // Re-insert after Strict Mode cleanup deleted a zero-ref entry.
  breakerRegistry.set(instanceKey, { breaker, refCount: 1 });
}

function releaseSharedBreaker(instanceKey: string): void {
  const entry = breakerRegistry.get(instanceKey);
  if (!entry) return;

  entry.refCount -= 1;
  if (entry.refCount <= 0) {
    breakerRegistry.delete(instanceKey);
  }
}

/** Force-remove a shared instance from the registry (tests / SPA teardown). */
export function releaseInstance(instanceKey: string): boolean {
  return breakerRegistry.delete(instanceKey);
}

export function useCircuitBreaker(
  options: UseCircuitBreakerOptions,
): UseCircuitBreakerResult {
  const {
    failureThreshold,
    cooldownPeriod,
    maxRetries,
    initialRetryDelay,
    isExpectedError,
    timeout,
    fallback,
    halfOpenSuccessThreshold,
    instanceKey,
  } = options;

  const breakerRef = useRef<CircuitBreaker | null>(null);

  const [circuitState, setCircuitState] = useState<CircuitState>("CLOSED");
  const [metrics, setMetrics] = useState({
    failureCount: 0,
    activeRequests: 0,
  });

  if (!breakerRef.current) {
    const config: CircuitConfig = {
      failureThreshold,
      cooldownPeriod,
      maxRetries,
      initialRetryDelay,
      isExpectedError,
      timeout,
      fallback,
      halfOpenSuccessThreshold,
    };

    if (instanceKey) {
      breakerRef.current = ensureSharedBreaker(instanceKey, config);
    } else {
      breakerRef.current = new CircuitBreaker(config);
    }
  }

  useEffect(() => {
    const breaker = breakerRef.current;
    if (!breaker) return;

    if (instanceKey) {
      retainSharedBreaker(instanceKey, breaker);
    }

    const currentStatus = breaker.getStatus();
    setCircuitState(currentStatus.state);
    setMetrics({
      failureCount: currentStatus.failureCount,
      activeRequests: currentStatus.activeRequests,
    });

    const unsubscribe = breaker.subscribe((newState, details) => {
      setCircuitState(newState);
      setMetrics({
        failureCount: details.failureCount,
        activeRequests: breaker.getStatus().activeRequests,
      });
    });

    return () => {
      unsubscribe();
      if (instanceKey) {
        releaseSharedBreaker(instanceKey);
      }
    };
  }, [instanceKey]);

  const execute = useCallback(
    async <T>(fn: ExecuteWork<T>, execOptions?: ExecuteOptions): Promise<T> => {
      const breaker = breakerRef.current;
      if (!breaker) {
        throw new Error(
          "[useCircuitBreaker] CircuitBreaker instance is not initialized.",
        );
      }
      return breaker.execute(fn, execOptions);
    },
    [],
  );

  const reset = useCallback(() => {
    const breaker = breakerRef.current;
    if (!breaker) {
      throw new Error(
        "[useCircuitBreaker] CircuitBreaker instance is not initialized.",
      );
    }
    breaker.reset();
  }, []);

  return {
    state: circuitState,
    failureCount: metrics.failureCount,
    activeRequests: metrics.activeRequests,
    execute,
    reset,
    isOpened: circuitState === "OPEN",
    isHalfOpen: circuitState === "HALF-OPEN",
  };
}
