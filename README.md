# ts-retry-circuit

A production-grade, isomorphic, zero-dependency Circuit Breaker and Auto-Retry library with native React support. Designed for Node.js, Next.js, and React applications.

[![NPM Version](https://img.shields.io/npm/v/ts-retry-circuit.svg)](https://www.npmjs.com/package/ts-retry-circuit)
[![License](https://img.shields.io/npm/l/ts-retry-circuit.svg)](https://github.com/TitleKung-01/ts-retry-circuit/blob/main/LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-Ready-blue.svg)](https://www.typescriptlang.org/)
[![Vitest](https://img.shields.io/badge/Tested%20with-Vitest-yellow.svg)](https://vitest.dev/)

---

## Features

- **Isomorphic**: Runs in Node.js, Next.js (SSR & API routes), and React (client-side).
- **Auto-Retry with Jitter**: Exponential backoff + full jitter in the `CLOSED` state.
- **HALF-OPEN concurrency guard**: Exactly one probe request while recovering.
- **Timeout & AbortSignal**: Per-attempt timeout and cooperative cancellation.
- **Fallback**: Degrade gracefully when the circuit rejects or a request finally fails.
- **Typed errors**: Stable `code` values instead of string-matching messages.
- **Native React hook**: Bind circuit state to UI; share instances via `instanceKey`.
- **Error filtering**: Exclude expected errors (e.g. `401`, `404`) from tripping the circuit.

---

## Installation

```bash
npm install ts-retry-circuit
```

```bash
yarn add ts-retry-circuit
pnpm add ts-retry-circuit
bun add ts-retry-circuit
```

---

## Migrating from v1 to v2

Breaking changes:

1. Rejects when the circuit is open or throttled are typed errors (`CircuitOpenError`, `CircuitHalfOpenThrottledError`), not plain `Error` strings with emoji.
2. Prefer `instanceof` / `.code` instead of matching `error.message`.
3. New optional APIs: `timeout`, `fallback`, `halfOpenSuccessThreshold`, `execute(fn, { signal })`, `reset()`, `getMetrics()`.

```typescript
import { CircuitOpenError } from "ts-retry-circuit";

try {
  await breaker.execute(fn);
} catch (error) {
  if (error instanceof CircuitOpenError) {
    console.log(`Retry after ${error.retryAfterMs}ms`);
  }
}
```

---

## Quick Start

### 1. Core API (Node.js, Next.js, TypeScript)

```typescript
import { CircuitBreaker, CircuitOpenError } from "ts-retry-circuit";

const breaker = new CircuitBreaker({
  failureThreshold: 3,
  cooldownPeriod: 5000,
  maxRetries: 2,
  initialRetryDelay: 1000,
  timeout: 3000,
  halfOpenSuccessThreshold: 1,
  isExpectedError: (error) => error instanceof ValidationError,
  fallback: (error, { state }) => {
    if (error instanceof CircuitOpenError) {
      return { degraded: true, retryAfterMs: error.retryAfterMs, state };
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

### 2. React Integration (`useCircuitBreaker`)

```tsx
import React from "react";
import { useCircuitBreaker } from "ts-retry-circuit/react";

function PaymentForm() {
  const {
    state,
    execute,
    reset,
    isOpened,
    isHalfOpen,
    activeRequests,
    failureCount,
  } = useCircuitBreaker({
    failureThreshold: 2,
    cooldownPeriod: 10000,
    maxRetries: 1,
  });

  const handleCheckout = async () => {
    try {
      await execute(async () => processPayment());
    } catch (error) {
      console.error("Payment failed:", error);
    }
  };

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

const paymentBreaker = useCircuitBreaker({
  instanceKey: "stripe-gateway-circuit",
  failureThreshold: 3,
  cooldownPeriod: 5000,
});

// later / in tests
releaseInstance("stripe-gateway-circuit");
```

---

## Comparison

| Capability | ts-retry-circuit | opossum | cockatiel |
| :--- | :--- | :--- | :--- |
| Circuit + consecutive failures | Yes | Rolling % window | Consecutive or sampling |
| Built-in retry + full jitter | Yes (`CLOSED` only) | Limited | Separate policy |
| Native React hook + shared `instanceKey` | Yes | No | No |
| Timeout / AbortSignal | Yes | Yes | Yes |
| Fallback | Yes | Yes | Yes |
| Typed reject reasons | Yes | Events mostly | Error codes |
| Bulkhead / policy compose / Prometheus | No (out of scope) | Partial / plugin | Yes / no native prom |

---

## API Reference

### `CircuitConfig`

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

| Class | `code` | When |
| :--- | :--- | :--- |
| `CircuitOpenError` | `CIRCUIT_OPEN` | Circuit is `OPEN` (`retryAfterMs` included) |
| `CircuitHalfOpenThrottledError` | `CIRCUIT_HALF_OPEN_THROTTLED` | Extra probe while `HALF-OPEN` |
| `CircuitTimeoutError` | `CIRCUIT_TIMEOUT` | Attempt exceeded `timeout` |
| `CircuitAbortedError` | `CIRCUIT_ABORTED` | `AbortSignal` aborted |

### `useCircuitBreaker` result

| Property | Type | Description |
| :--- | :--- | :--- |
| `state` | `CircuitState` | `'CLOSED' \| 'OPEN' \| 'HALF-OPEN'` |
| `failureCount` | `number` | Consecutive failures in the current cycle |
| `activeRequests` | `number` | In-flight requests through this breaker |
| `execute` | `(fn, options?) => Promise<T>` | Run work through the breaker |
| `reset` | `() => void` | Force `CLOSED` and clear counters |
| `isOpened` | `boolean` | `state === 'OPEN'` |
| `isHalfOpen` | `boolean` | `state === 'HALF-OPEN'` |

---

## Development & Testing

```bash
npm install
npm run validate
npm run test:run
npm run build
```

---

## License

MIT © [TitleKung-01](https://github.com/TitleKung-01)
