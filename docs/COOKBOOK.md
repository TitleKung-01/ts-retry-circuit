# Cookbook

Practical patterns and recipes for `ts-retry-circuit` in Node.js, Next.js, and React.

## When to use consecutive vs rolling

| Strategy | Use when |
| --- | --- |
| `consecutive` (default) | Low-volume calls, or you want “N failures in a row” semantics |
| `rolling` | Higher traffic; open when a **percentage** of a volume window fails |

## Wrap a fetch client

```typescript
import { CircuitBreaker, CircuitOpenError, isCircuitError, createCircuitFetch } from "ts-retry-circuit";

const apiBreaker = new CircuitBreaker({
  name: "api-client",
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

// Or use the built-in fetch wrapper helper:
export const paymentsFetch = createCircuitFetch(apiBreaker);
```

## Payments / checkout API (Rolling strategy)

```typescript
import { CircuitBreaker, CircuitOpenError, createCircuitFetch } from "ts-retry-circuit";

const payments = new CircuitBreaker({
  name: "stripe-like",
  failureThreshold: 5,
  cooldownPeriod: 30_000,
  timeout: 8_000,
  maxRetries: 1,
  capacity: 100,
  strategy: "rolling",
  volumeThreshold: 20,
  errorThresholdPercentage: 40,
  isExpectedError: (err) =>
    err instanceof Error && /card_declined|validation/i.test(err.message),
  fallback: (error) => {
    if (error instanceof CircuitOpenError) {
      return { ok: false as const, reason: "upstream_unavailable" as const };
    }
    throw error;
  },
});
```

## Third-party webhooks (egress)

Protect outbound calls so one bad vendor does not exhaust your workers:

```typescript
const webhooks = CircuitBreaker.get("webhooks-egress", {
  failureThreshold: 10,
  cooldownPeriod: 60_000,
  maxRetries: 2,
  initialRetryDelay: 200,
  timeout: 5_000,
  capacity: 20,
});

export async function deliver(url: string, body: unknown) {
  return webhooks.execute(async ({ signal }) => {
    const res = await fetch(url, {
      method: "POST",
      body: JSON.stringify(body),
      signal,
      headers: { "content-type": "application/json" },
    });
    if (!res.ok) throw new Error(`webhook ${res.status}`);
  });
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

## SSR anti-patterns

1. **Do not** put a shared `CircuitBreaker` in a module singleton used from React Server Components across requests — state leaks between users.
2. **Do** use `CircuitProvider` with a fresh `Map` per request on the server, or keep breakers only in client components / Node long-lived processes.
3. **Do** call `releaseInstance` in tests / SPA teardown when using module `instanceKey` without a provider.

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

## Observability & OpenTelemetry

```typescript
import { instrumentCircuitBreaker } from "ts-retry-circuit/otel";

instrumentCircuitBreaker(breaker, { meter, prefix: "resilience" });
breaker.on("open", ({ name, retryAfterMs }) => {
  console.warn("circuit open", name, retryAfterMs);
});
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

## vs opossum / cockatiel

- Prefer **ts-retry-circuit** for TypeScript + React/Next DX and a single opinionated API.
- Prefer **opossum** if you already standardize on its Prometheus/Hystrix plugins in Node-only services.
- Prefer **cockatiel** if you need arbitrary policy composition graphs.
