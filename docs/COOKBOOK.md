# Cookbook

Practical patterns for `ts-retry-circuit` in Node.js, Next.js, and React.

## Wrap a fetch client

```typescript
import { CircuitBreaker, CircuitOpenError, isCircuitError } from "ts-retry-circuit";

const apiBreaker = new CircuitBreaker({
  failureThreshold: 5,
  cooldownPeriod: 30_000,
  maxRetries: 2,
  initialRetryDelay: 300,
  timeout: 5_000,
  isExpectedError: (error) =>
    error instanceof Error &&
    /^(401|403|404|422)$/.test((error as Error & { status?: number }).status?.toString() ?? ""),
});

export async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  try {
    return await apiBreaker.execute(async ({ signal }) => {
      const response = await fetch(url, { ...init, signal });
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`);
        (error as Error & { status: number }).status = response.status;
        throw error;
      }
      return response.json() as Promise<T>;
    });
  } catch (error) {
    if (error instanceof CircuitOpenError) {
      throw new Error(`Upstream unavailable. Retry in ${error.retryAfterMs}ms`);
    }
    if (isCircuitError(error)) throw error;
    throw error;
  }
}
```

## Next.js Route Handler

Share one breaker per dependency (module scope), not per request:

```typescript
// lib/payment-breaker.ts
import { CircuitBreaker } from "ts-retry-circuit";

export const paymentBreaker = new CircuitBreaker({
  failureThreshold: 3,
  cooldownPeriod: 15_000,
  maxRetries: 1,
  timeout: 8_000,
  fallback: () => ({ ok: false as const, deferred: true as const }),
});
```

```typescript
// app/api/checkout/route.ts
import { paymentBreaker } from "@/lib/payment-breaker";

export async function POST(request: Request) {
  const body = await request.json();

  const result = await paymentBreaker.execute(async ({ signal }) => {
    const res = await fetch(process.env.PAYMENT_URL!, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) throw new Error(`Payment failed: ${res.status}`);
    return res.json();
  });

  return Response.json(result);
}
```

## Fallback with Retry-After

```typescript
import { CircuitBreaker, CircuitOpenError } from "ts-retry-circuit";

const breaker = new CircuitBreaker({
  failureThreshold: 3,
  cooldownPeriod: 10_000,
  maxRetries: 0,
  fallback: (error) => {
    if (error instanceof CircuitOpenError) {
      return {
        data: null,
        degraded: true,
        retryAfterMs: error.retryAfterMs,
      };
    }
    throw error;
  },
});
```

## Cancel in-flight work with AbortSignal

Always forward the attempt signal into I/O so timeout/abort stops real work:

```typescript
await breaker.execute(({ signal }) => fetch(url, { signal }));
```

You can also link a caller-owned signal:

```typescript
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 2_000);

try {
  await breaker.execute(
    ({ signal }) => fetch("/slow", { signal }).then((r) => r.json()),
    { signal: controller.signal },
  );
} finally {
  clearTimeout(timeout);
}
```

| Client | Pass signal? |
| :--- | :--- |
| `fetch` | Yes — `{ signal }` |
| Axios | Yes — `{ signal }` (v0.22+) |
| Many DB drivers | Only if the API accepts AbortSignal; otherwise timeout still fails the attempt but may not cancel the driver |

## React: disable UI while open

```tsx
import { useCircuitBreaker } from "ts-retry-circuit/react";

export function SaveButton({ onSave }: { onSave: () => Promise<void> }) {
  const { execute, isOpened, isHalfOpen, activeRequests, state } = useCircuitBreaker({
    failureThreshold: 3,
    cooldownPeriod: 8_000,
    maxRetries: 1,
    timeout: 4_000,
  });

  return (
    <button
      disabled={isOpened || activeRequests > 0}
      title={isHalfOpen ? "Probing recovery…" : state}
      onClick={() => void execute(onSave)}
    >
      {isOpened ? "Temporarily unavailable" : "Save"}
    </button>
  );
}
```

## React: share one circuit across components

Config is frozen at the first registration for a given `instanceKey`.
Keys must match `^[a-zA-Z0-9:_./-]+$` (max 128). Use a stable dependency name — never an end-user id.
The registry ref-counts subscribers and drops the entry when the last hook unmounts.

```tsx
import { useCircuitBreaker, releaseInstance } from "ts-retry-circuit/react";

function usePaymentsCircuit() {
  return useCircuitBreaker({
    instanceKey: "payments",
    failureThreshold: 3,
    cooldownPeriod: 10_000,
  });
}

// Force-remove in tests / SPA teardown if needed:
releaseInstance("payments");
```

## Observe metrics without an exporter

```typescript
setInterval(() => {
  const m = breaker.getMetrics();
  console.info("circuit", {
    state: m.state,
    failures: m.failureCount,
    successes: m.successCount,
    opened: m.openedCount,
    rejected: m.rejectedCount,
    active: m.activeRequests,
  });
}, 30_000);
```

## Subscribe to state changes

```typescript
const unsubscribe = breaker.subscribe((state, { failureCount }) => {
  if (state === "OPEN") {
    console.warn("circuit opened", { failureCount });
  }
});

// later
unsubscribe();
```

## Filter validation / auth errors

Only infrastructure-like failures should trip the circuit:

```typescript
new CircuitBreaker({
  failureThreshold: 5,
  cooldownPeriod: 20_000,
  isExpectedError: (error) => {
    if (!(error instanceof Error)) return false;
    const status = (error as Error & { status?: number }).status;
    return status === 400 || status === 401 || status === 404 || status === 422;
  },
});
```

## Manual reset (ops / admin)

```typescript
breaker.reset(); // force CLOSED and clear consecutive failure counters
```

Prefer letting cooldown + HALF-OPEN recover automatically in production.
Do **not** bind `reset()` to a public end-user button; keep it for admin tools or tests.
