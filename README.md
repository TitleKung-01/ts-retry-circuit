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

async function fetchUserData() {
  return breaker.execute(async () => {
    const response = await fetch("https://api.example.com/user");
    if (!response.ok) throw new Error("Internal Server Error");
    return response.json();
  });
}
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
    <div>
      <p>System State: <strong>{state}</strong></p>
      <p>Consecutive Failures: {failureCount}</p>

      <button
        onClick={handleCheckout}
        disabled={isOpened || isHalfOpen || activeRequests > 0}
      >
        {activeRequests > 0
          ? "Processing..."
          : isOpened
            ? "Service Temporarily Unavailable"
            : "Pay Now"}
      </button>

      {isOpened ? (
        <button type="button" onClick={reset}>
          Reset circuit
        </button>
      ) : null}
    </div>
  );
}
```

### 3. Sharing Circuit State Across Components

Config is frozen at the first registration for a given `instanceKey`. Later mounts reuse that instance and ignore new config. Call `releaseInstance(key)` for tests or SPA teardown.

```tsx
import { useCircuitBreaker, releaseInstance } from "ts-retry-circuit/react";

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

| Property | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `failureThreshold` | `number` | **Required** | Consecutive failures to open the circuit. |
| `cooldownPeriod` | `number` | **Required** | Ms to stay `OPEN` before `HALF-OPEN`. |
| `maxRetries` | `number` | `3` | Retries while `CLOSED`. |
| `initialRetryDelay` | `number` | `500` | Initial backoff delay (ms). |
| `timeout` | `number` | `undefined` | Per-attempt timeout (ms). |
| `halfOpenSuccessThreshold` | `number` | `1` | Successes in `HALF-OPEN` before `CLOSED`. |
| `isExpectedError` | `(err) => boolean` | `undefined` | Errors that do not count as failures. |
| `fallback` | `(err, ctx) => unknown` | `undefined` | Used on OPEN/throttle/final failure (not expected errors). |

### `CircuitBreaker`

- `execute<T>(fn, options?: { signal?: AbortSignal }): Promise<T>`
- `getStatus(): CircuitStatus`
- `getMetrics(): CircuitMetrics`
- `reset(): void`
- `subscribe(listener): () => void`

### Typed errors

`CircuitOpenError` · `CircuitHalfOpenThrottledError` · `CircuitTimeoutError` · `CircuitAbortedError` · `CircuitCapacityRejectedError`

---

## Performance & Reliability

- **High Test Coverage**: **>94% Line & Statement Coverage** across core logic, React hooks, and OpenTelemetry instrumentation.
- **High Throughput**: **>500,000 ops/sec** with **< 0.002ms** execution overhead per call.

```bash
npm install
npm run validate
npm run test:coverage
npm run build
npm run bench
```

---

## Further reading

- [Cookbook](docs/COOKBOOK.md) — fetch, Next.js, React, fallback, metrics patterns
- [Versioning (SemVer)](SEMVER.md) — what counts as major / minor / patch
- [Security](SECURITY.md) — supported versions and vulnerability reporting

---

## License

MIT © [TitleKung-01](https://github.com/TitleKung-01)
