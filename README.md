# ts-retry-circuit

TypeScript-first isomorphic resilience kit for Node.js, Next.js, and React — circuit breaker + retry + AbortSignal in one API, with UI-aware hooks and optional OpenTelemetry.

[![NPM Version](https://img.shields.io/npm/v/ts-retry-circuit.svg)](https://www.npmjs.com/package/ts-retry-circuit)
[![CI](https://github.com/TitleKung-01/ts-retry-circuit/actions/workflows/ci.yml/badge.svg)](https://github.com/TitleKung-01/ts-retry-circuit/actions/workflows/ci.yml)
[![License](https://img.shields.io/npm/l/ts-retry-circuit.svg)](https://github.com/TitleKung-01/ts-retry-circuit/blob/main/LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-Ready-blue.svg)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org/)

---

## Features

- **Isomorphic**: Node.js, Next.js (SSR & API routes), and React (client).
- **Auto-Retry with Jitter**: Exponential backoff + full jitter in `CLOSED`.
- **Trip strategies**: Consecutive failures (default) or rolling error-rate window.
- **Bulkhead `capacity`**: Limit concurrent executions.
- **Timeout & AbortSignal**: Per-attempt timeout aborts the attempt signal so `fetch`/work can cancel.
- **Fallback + typed errors**: Stable `code` values for open/throttle/timeout/abort/capacity.
- **Typed event bus**: `on("open" | "success" | ...)`
- **Named registry**: Share breakers across a process via `CircuitBreaker.get(name)`.
- **React**: `useCircuitBreaker`, `CircuitProvider`, richer metrics.
- **Helpers**: `withCircuit`, `createCircuitFetch`, optional `ts-retry-circuit/otel`.

---

## Installation

```bash
npm install ts-retry-circuit
```

Requires **Node.js >= 20**.

---

## Quick Start

```typescript
import { CircuitBreaker, CircuitOpenError } from "ts-retry-circuit";

const breaker = new CircuitBreaker({
  name: "payments-api",
  failureThreshold: 3,
  cooldownPeriod: 5000,
  maxRetries: 2,
  timeout: 3000,
  capacity: 50,
  fallback: (error) => {
    if (error instanceof CircuitOpenError) {
      return { degraded: true, retryAfterMs: error.retryAfterMs };
    }
    throw error;
  },
});

const data = await breaker.execute(async (signal) => {
  const res = await fetch("https://api.example.com/user", { signal });
  if (!res.ok) throw new Error("upstream error");
  return res.json();
});
```

### Rolling window strategy

```typescript
const breaker = new CircuitBreaker({
  failureThreshold: 100, // ignored for open decision when strategy is rolling
  cooldownPeriod: 30_000,
  strategy: "rolling",
  volumeThreshold: 20,
  errorThresholdPercentage: 50,
  rollingWindowMs: 10_000,
  maxRetries: 0,
});
```

### React + provider (SSR-safe scoping)

```tsx
import { CircuitProvider, useCircuitBreaker } from "ts-retry-circuit/react";

export function App() {
  return (
    <CircuitProvider>
      <CheckoutButton />
    </CircuitProvider>
  );
}

function CheckoutButton() {
  const { state, execute, isOpened, metrics } = useCircuitBreaker({
    instanceKey: "checkout",
    failureThreshold: 2,
    cooldownPeriod: 10_000,
  });

  return (
    <button
      disabled={isOpened}
      onClick={() => execute(async (signal) => processPayment(signal))}
    >
      Pay ({state}, fails={metrics.failureCount})
    </button>
  );
}
```

**SSR:** Create a **new** `CircuitProvider` registry per request. Do not share mutable breakers across RSC requests. Module-level `instanceKey` registry is fine for client-only / long-lived Node processes.

### Fetch helper

```typescript
import { CircuitBreaker, createCircuitFetch } from "ts-retry-circuit";

const breaker = new CircuitBreaker({
  failureThreshold: 5,
  cooldownPeriod: 10_000,
  timeout: 3000,
  maxRetries: 1,
});
const circuitFetch = createCircuitFetch(breaker);

const res = await circuitFetch("https://api.example.com/items", {
  expectedStatuses: [404],
});
```

### OpenTelemetry

```typescript
import { CircuitBreaker } from "ts-retry-circuit";
import { instrumentCircuitBreaker } from "ts-retry-circuit/otel";

const breaker = new CircuitBreaker({
  name: "inventory",
  failureThreshold: 5,
  cooldownPeriod: 10_000,
});

const stop = instrumentCircuitBreaker(breaker, {
  meter, // from @opentelemetry/api
});
```

---

## Migrating from v1 / v2.0

See [CHANGELOG.md](./CHANGELOG.md). v2.1 is additive for v2.0 callers: `execute` now passes an `AbortSignal` as the first argument to your function (`async (signal) => ...`). Existing `async () => ...` callbacks remain valid.

---

## Comparison

| Capability | ts-retry-circuit | opossum | cockatiel |
| :--- | :--- | :--- | :--- |
| TypeScript-native + isomorphic | Yes | Node-focused | Yes |
| Circuit + consecutive **or** rolling % | Yes | Rolling % | Policies |
| Built-in retry + full jitter | Yes (`CLOSED`) | Limited | Separate |
| Native React hook + `CircuitProvider` | Yes | No | No |
| Timeout aborts attempt `AbortSignal` | Yes | Yes | Yes |
| Bulkhead capacity | Yes | Yes | Yes |
| Typed events + OTel helper | Yes | Events + prom plugin | Limited |
| Policy composition framework | No (by design) | No | Yes |

More recipes: [docs/COOKBOOK.md](./docs/COOKBOOK.md) · Versioning: [SEMVER.md](./SEMVER.md) · Security: [SECURITY.md](./SECURITY.md)

---

## API (summary)

### `CircuitConfig` (new / notable)

| Property | Default | Description |
| :--- | :--- | :--- |
| `strategy` | `"consecutive"` | `"rolling"` uses error % window |
| `capacity` | unlimited | Max concurrent `execute` calls |
| `name` | — | Registers in `CircuitRegistry` |
| `errorThresholdPercentage` | `50` | Rolling only |
| `volumeThreshold` | `5` | Rolling only |
| `rollingWindowMs` / `rollingBuckets` | `10000` / `10` | Rolling window |

### Events

`open` · `close` · `halfOpen` · `success` · `failure` · `reject` · `timeout` · `fallback` · `retry`

### Typed errors

`CircuitOpenError` · `CircuitHalfOpenThrottledError` · `CircuitTimeoutError` · `CircuitAbortedError` · `CircuitCapacityRejectedError`

---

## Development

```bash
npm install
npm run validate
npm run test:coverage
npm run build
npm run bench
```

---

## License

MIT © [TitleKung-01](https://github.com/TitleKung-01)
