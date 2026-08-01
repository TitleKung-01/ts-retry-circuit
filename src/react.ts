// src/react.ts
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  CircuitBreaker,
  CircuitConfig,
  CircuitMetrics,
  CircuitState,
  ExecuteOptions,
} from "./core.js";

export interface UseCircuitBreakerOptions extends CircuitConfig {
  /**
   * Share one CircuitBreaker across components.
   * Config is frozen at the first registration for a given key;
   * later mounts with the same key reuse that instance and ignore new config.
   *
   * Prefer CircuitProvider for SSR-safe scoping instead of the module registry.
   */
  instanceKey?: string;
}

export interface UseCircuitBreakerResult {
  state: CircuitState;
  failureCount: number;
  activeRequests: number;
  nextAttemptTime: number;
  metrics: CircuitMetrics;
  execute: <T>(
    fn: (signal: AbortSignal) => Promise<T>,
    options?: ExecuteOptions,
  ) => Promise<T>;
  reset: () => void;
  isOpened: boolean;
  isHalfOpen: boolean;
  breaker: CircuitBreaker;
}

const fallbackRegistry = new Map<string, CircuitBreaker>();

/** Remove a shared instance from the module registry (tests / SPA teardown). */
export function releaseInstance(instanceKey: string): boolean {
  return fallbackRegistry.delete(instanceKey);
}

interface CircuitContextValue {
  registry: Map<string, CircuitBreaker>;
  getOrCreate: (key: string, config: CircuitConfig) => CircuitBreaker;
  release: (key: string) => boolean;
}

const CircuitContext = createContext<CircuitContextValue | null>(null);

export interface CircuitProviderProps {
  children: ReactNode;
  /**
   * Optional initial registry. Defaults to a fresh Map scoped to this provider
   * (safe for per-request SSR trees).
   */
  registry?: Map<string, CircuitBreaker>;
}

/**
 * Scopes shared circuit instances to a React tree.
 * Use one provider per SSR request / app root — do not reuse the Map across requests.
 */
export function CircuitProvider({ children, registry }: CircuitProviderProps) {
  const mapRef = useRef(registry ?? new Map<string, CircuitBreaker>());

  const value = useMemo<CircuitContextValue>(
    () => ({
      registry: mapRef.current,
      getOrCreate(key, config) {
        const existing = mapRef.current.get(key);
        if (existing) return existing;
        const breaker = new CircuitBreaker(config);
        mapRef.current.set(key, breaker);
        return breaker;
      },
      release(key) {
        return mapRef.current.delete(key);
      },
    }),
    [],
  );

  return createElement(CircuitContext.Provider, { value }, children);
}

export function useCircuitRegistry(): CircuitContextValue | null {
  return useContext(CircuitContext);
}

function createConfig(options: UseCircuitBreakerOptions): CircuitConfig {
  const {
    instanceKey: _key,
    failureThreshold,
    cooldownPeriod,
    maxRetries,
    initialRetryDelay,
    isExpectedError,
    timeout,
    fallback,
    halfOpenSuccessThreshold,
    name,
    capacity,
    strategy,
    errorThresholdPercentage,
    volumeThreshold,
    rollingWindowMs,
    rollingBuckets,
  } = options;

  return {
    failureThreshold,
    cooldownPeriod,
    maxRetries,
    initialRetryDelay,
    isExpectedError,
    timeout,
    fallback,
    halfOpenSuccessThreshold,
    name,
    capacity,
    strategy,
    errorThresholdPercentage,
    volumeThreshold,
    rollingWindowMs,
    rollingBuckets,
  };
}

export function useCircuitBreaker(
  options: UseCircuitBreakerOptions,
): UseCircuitBreakerResult {
  const { instanceKey } = options;
  const ctx = useContext(CircuitContext);
  const breakerRef = useRef<CircuitBreaker | null>(null);

  const [circuitState, setCircuitState] = useState<CircuitState>("CLOSED");
  const [snapshot, setSnapshot] = useState({
    failureCount: 0,
    activeRequests: 0,
    nextAttemptTime: 0,
  });
  const [metrics, setMetrics] = useState<CircuitMetrics | null>(null);

  if (!breakerRef.current) {
    const config = createConfig(options);
    if (instanceKey) {
      if (ctx) {
        breakerRef.current = ctx.getOrCreate(instanceKey, config);
      } else {
        if (!fallbackRegistry.has(instanceKey)) {
          fallbackRegistry.set(instanceKey, new CircuitBreaker(config));
        }
        breakerRef.current = fallbackRegistry.get(instanceKey)!;
      }
    } else {
      breakerRef.current = new CircuitBreaker(config);
    }
  }

  useEffect(() => {
    const breaker = breakerRef.current;
    if (!breaker) return;

    const sync = () => {
      const status = breaker.getStatus();
      setCircuitState(status.state);
      setSnapshot({
        failureCount: status.failureCount,
        activeRequests: status.activeRequests,
        nextAttemptTime: status.nextAttemptTime,
      });
      setMetrics(breaker.getMetrics());
    };

    sync();
    const unsubscribe = breaker.subscribe(() => {
      sync();
    });

    return () => {
      unsubscribe();
    };
  }, [instanceKey]);

  const execute = useCallback(
    async <T>(
      fn: (signal: AbortSignal) => Promise<T>,
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

  const breaker = breakerRef.current!;
  const resolvedMetrics = metrics ?? breaker.getMetrics();

  return {
    state: circuitState,
    failureCount: snapshot.failureCount,
    activeRequests: snapshot.activeRequests,
    nextAttemptTime: snapshot.nextAttemptTime,
    metrics: resolvedMetrics,
    execute,
    reset,
    isOpened: circuitState === "OPEN",
    isHalfOpen: circuitState === "HALF-OPEN",
    breaker,
  };
}
