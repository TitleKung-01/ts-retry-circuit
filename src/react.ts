// src/react.ts
import { useState, useEffect, useCallback, useRef } from "react";
import {
  CircuitBreaker,
  CircuitConfig,
  CircuitState,
  ExecuteOptions,
} from "./core.js";

export interface UseCircuitBreakerOptions extends CircuitConfig {
  /**
   * Share one CircuitBreaker across components.
   * Config is frozen at the first registration for a given key;
   * later mounts with the same key reuse that instance and ignore new config.
   */
  instanceKey?: string;
}

export interface UseCircuitBreakerResult {
  state: CircuitState;
  failureCount: number;
  activeRequests: number;
  execute: <T>(fn: () => Promise<T>, options?: ExecuteOptions) => Promise<T>;
  reset: () => void;
  isOpened: boolean;
  isHalfOpen: boolean;
}

const breakerRegistry = new Map<string, CircuitBreaker>();

/** Remove a shared instance from the registry (tests / SPA teardown). */
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
    if (instanceKey) {
      if (!breakerRegistry.has(instanceKey)) {
        breakerRegistry.set(
          instanceKey,
          new CircuitBreaker({
            failureThreshold,
            cooldownPeriod,
            maxRetries,
            initialRetryDelay,
            isExpectedError,
            timeout,
            fallback,
            halfOpenSuccessThreshold,
          }),
        );
      }
      breakerRef.current = breakerRegistry.get(instanceKey)!;
    } else {
      breakerRef.current = new CircuitBreaker({
        failureThreshold,
        cooldownPeriod,
        maxRetries,
        initialRetryDelay,
        isExpectedError,
        timeout,
        fallback,
        halfOpenSuccessThreshold,
      });
    }
  }

  useEffect(() => {
    const breaker = breakerRef.current;
    if (!breaker) return;

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
    };
  }, [instanceKey]);

  const execute = useCallback(
    async <T>(
      fn: () => Promise<T>,
      execOptions?: ExecuteOptions,
    ): Promise<T> => {
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
