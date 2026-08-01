# Cookbook

Production-oriented recipes for `ts-retry-circuit`.

## When to use consecutive vs rolling

| Strategy | Use when |
| --- | --- |
| `consecutive` (default) | Low-volume calls, or you want “N failures in a row” semantics |
| `rolling` | Higher traffic; open when a **percentage** of a volume window fails |

## Payments / checkout API

```ts
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

export const paymentsFetch = createCircuitFetch(payments);
```

## Third-party webhooks (egress)

Protect outbound calls so one bad vendor does not exhaust your workers:

```ts
const webhooks = CircuitBreaker.get("webhooks-egress", {
  failureThreshold: 10,
  cooldownPeriod: 60_000,
  maxRetries: 2,
  initialRetryDelay: 200,
  timeout: 5_000,
  capacity: 20,
});

export async function deliver(url: string, body: unknown) {
  return webhooks.execute(async (signal) => {
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

```ts
import { CircuitBreaker } from "ts-retry-circuit";

const catalog = CircuitBreaker.get("catalog-api", {
  failureThreshold: 3,
  cooldownPeriod: 10_000,
  timeout: 3000,
  maxRetries: 1,
});

export async function GET() {
  try {
    const data = await catalog.execute(async (signal) => {
      const res = await fetch(process.env.CATALOG_URL!, { signal });
      if (!res.ok) throw new Error("catalog down");
      return res.json();
    });
    return Response.json(data);
  } catch {
    return Response.json({ error: "unavailable" }, { status: 503 });
  }
}
```

## SSR anti-patterns

1. **Do not** put a shared `CircuitBreaker` in a module singleton used from React Server Components across requests — state leaks between users.
2. **Do** use `CircuitProvider` with a fresh `Map` per request on the server, or keep breakers only in client components / Node long-lived processes.
3. **Do** call `releaseInstance` in tests / SPA teardown when using module `instanceKey` without a provider.

## Observability

```ts
import { instrumentCircuitBreaker } from "ts-retry-circuit/otel";

instrumentCircuitBreaker(breaker, { meter, prefix: "resilience" });
breaker.on("open", ({ name, retryAfterMs }) => {
  console.warn("circuit open", name, retryAfterMs);
});
```

## vs opossum / cockatiel (short)

- Prefer **ts-retry-circuit** for TypeScript + React/Next DX and a single opinionated API.
- Prefer **opossum** if you already standardize on its Prometheus/Hystrix plugins in Node-only services.
- Prefer **cockatiel** if you need arbitrary policy composition graphs.
