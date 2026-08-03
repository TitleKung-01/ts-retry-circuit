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
  ExecuteContext,
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
    fn: (ctx: ExecuteContext & AbortSignal) => Promise<T>,
    options?: ExecuteOptions,
  ) => Promise<T>;
  reset: () => void;
  isOpened: boolean;
  isHalfOpen: boolean;
  breaker: CircuitBreaker;
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
  const existing = breakerRegistry.get(instanceKey);
  if (existing) {
    existing.refCount++;
    return;
  }
  breakerRegistry.set(instanceKey, { breaker, refCount: 1 });
}

function releaseSharedBreaker(instanceKey: string): void {
  const existing = breakerRegistry.get(instanceKey);
  if (!existing) return;

  existing.refCount--;
  if (existing.refCount <= 0) {
    breakerRegistry.delete(instanceKey);
  }
}

/** Remove a shared instance from the module registry (tests / SPA teardown). */
export function releaseInstance(instanceKey: string): boolean {
  return breakerRegistry.delete(instanceKey);
}

export interface CircuitRegistryLike {
  get(name: string): CircuitBreaker | undefined;
  getOrCreate(name: string, config: CircuitConfig): CircuitBreaker;
  release?(name: string): boolean;
}

export const CircuitContext = createContext<CircuitRegistryLike | null>(null);

export interface CircuitProviderProps {
  registry?: Map<string, CircuitBreaker> | CircuitRegistryLike;
  children: ReactNode;
}

export function CircuitProvider({ registry, children }: CircuitProviderProps) {
  const adapter = useMemo<CircuitRegistryLike>(() => {
    if (!registry) {
      const map = new Map<string, CircuitBreaker>();
      return {
        get: (name) => map.get(name),
        getOrCreate: (name, config) => {
          let b = map.get(name);
          if (!b) {
            b = new CircuitBreaker({ ...config, name });
            map.set(name, b);
          }
          return b;
        },
        release: (name) => map.delete(name),
      };
    }
    if ("getOrCreate" in registry) return registry;
    return {
      get: (name) => registry.get(name),
      getOrCreate: (name, config) => {
        let b = (registry as Map<string, CircuitBreaker>).get(name);
        if (!b) {
          b = new CircuitBreaker({ ...config, name });
          (registry as Map<string, CircuitBreaker>).set(name, b);
        }
        return b;
      },
      release: (name) => (registry as Map<string, CircuitBreaker>).delete(name),
    };
  }, [registry]);

  return createElement(CircuitContext.Provider, { value: adapter, children });
}

function createConfig(options: UseCircuitBreakerOptions): CircuitConfig {
  const {
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
        breakerRef.current = ensureSharedBreaker(instanceKey, config);
      }
    } else {
      breakerRef.current = new CircuitBreaker(config);
    }
  }

  useEffect(() => {
    const breaker = breakerRef.current;
    if (!breaker) return;

    if (instanceKey && !ctx) {
      retainSharedBreaker(instanceKey, breaker);
    }

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
      if (instanceKey && !ctx) {
        releaseSharedBreaker(instanceKey);
      }
    };
  }, [instanceKey, ctx]);

  const execute = useCallback(
    async <T>(
      fn: (ctx: ExecuteContext & AbortSignal) => Promise<T>,
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
