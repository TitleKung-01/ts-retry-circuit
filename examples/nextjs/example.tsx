/**
 * Minimal Next.js / React usage sketch.
 * Wire CircuitProvider at the app root (client). For SSR, pass a fresh registry Map per request.
 */
import { createElement, type ReactNode } from "react";
import {
  CircuitProvider,
  useCircuitBreaker,
} from "ts-retry-circuit/react";

export function Providers({ children }: { children: ReactNode }) {
  return createElement(CircuitProvider, null, children);
}

export function PayButton({ pay }: { pay: (signal: AbortSignal) => Promise<void> }) {
  const { execute, isOpened, state, metrics } = useCircuitBreaker({
    instanceKey: "checkout",
    failureThreshold: 2,
    cooldownPeriod: 15_000,
    maxRetries: 1,
    timeout: 8000,
  });

  return createElement(
    "button",
    {
      disabled: isOpened,
      onClick: () => {
        void execute(pay).catch(() => undefined);
      },
    },
    isOpened ? `Unavailable (${state})` : `Pay (fails=${metrics.failureCount})`,
  );
}
