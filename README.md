# ts-retry-circuit 🚀

A production-grade, isomorphic, zero-dependency Circuit Breaker and Auto-Retry library with native React support. Designed for Node.js, Next.js, and React applications.

[![NPM Version](https://img.shields.io/npm/v/ts-retry-circuit.svg)](https://www.npmjs.com/package/ts-retry-circuit)
[![License](https://img.shields.io/npm/l/ts-retry-circuit.svg)](https://github.com/mryos/ts-retry-circuit/blob/main/LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-Ready-blue.svg)](https://www.typescriptlang.org/)
[![Vitest](https://img.shields.io/badge/Tested%20with-Vitest-yellow.svg)](https://vitest.dev/)

---

## Features 🌟

- 🛡️ **Isomorphic**: Runs seamlessly in any environment—Node.js, Next.js (SSR & API routes), and React (Client-side).
- ⚙️ **Auto-Retry with Jitter**: Automatically retries failed operations using Exponential Backoff and Full Jitter to prevent the "Thundering Herd" problem.
- 🛑 **Concurrency Guard in HALF-OPEN**: Limits execution to exactly one request while testing a recovering system in the `HALF-OPEN` state, immediately throttling any concurrent calls.
- 🔌 **Native React Hook**: Seamlessly bind circuit state to React components with the `useCircuitBreaker` hook.
- 🔗 **Shared Circuit State**: Share a single circuit breaker instance across multiple independent components using a unique `instanceKey`.
- 🎛️ **Error Filtering**: Exclude expected errors (e.g., `401 Unauthorized`, `404 Not Found`, validation errors) so they don't count towards tripping the circuit.

---

## Installation 📦

```bash
npm install ts-retry-circuit
```

Or using other package managers:

```bash
yarn add ts-retry-circuit
pnpm add ts-retry-circuit
bun add ts-retry-circuit
```

---

## Quick Start 🚀

### 1. Core API (Node.js, Next.js, Pure TypeScript)

Create a circuit breaker and wrap your network or database calls:

```typescript
import { CircuitBreaker } from "ts-retry-circuit";

// 1. Initialize the Circuit Breaker configuration
const breaker = new CircuitBreaker({
  failureThreshold: 3,       // Trip the circuit to OPEN after 3 consecutive failures
  cooldownPeriod: 5000,      // Wait 5 seconds before entering HALF-OPEN state to test the system
  maxRetries: 2,             // Retry up to 2 times for transient errors in CLOSED state
  initialRetryDelay: 1000,   // Wait 1 second before first retry (using exponential jitter backoff)
  isExpectedError: (error) => {
    // Ignore validation or expected business errors from tripping the circuit
    return error instanceof ValidationError;
  }
});

// 2. Execute your function securely
async function fetchUserData() {
  return breaker.execute(async () => {
    const response = await fetch("https://api.example.com/user");
    if (!response.ok) throw new Error("Internal Server Error");
    return response.json();
  });
}
```

### 2. React Integration (`useCircuitBreaker` Hook)

Use the hook to bind the circuit state directly to your UI elements:

```tsx
import React from "react";
import { useCircuitBreaker } from "ts-retry-circuit/react";

function PaymentForm() {
  const { state, execute, isOpened, activeRequests, failureCount } = useCircuitBreaker({
    failureThreshold: 2,
    cooldownPeriod: 10000, // Stay open for 10 seconds on failure
    maxRetries: 1,
  });

  const handleCheckout = async () => {
    try {
      const receipt = await execute(async () => {
        return await processPayment();
      });
      alert("Payment Successful!");
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
        disabled={isOpened || activeRequests > 0}
      >
        {activeRequests > 0 ? "Processing..." : isOpened ? "Service Temporarily Unavailable" : "Pay Now"}
      </button>
    </div>
  );
}
```

### 3. Sharing Circuit State Across Components

You can synchronize the circuit state of multiple components (e.g., payment button and cart status indicators) by providing a unique `instanceKey`. The state changes will automatically sync between them:

```tsx
// Both hooks share the same underlying instance and will transition states in sync
const paymentBreaker = useCircuitBreaker({
  instanceKey: "stripe-gateway-circuit",
  failureThreshold: 3,
  cooldownPeriod: 5000,
});
```

---

## API Reference 📖

### 1. `CircuitConfig` Options

| Property | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `failureThreshold` | `number` | **Required** | The number of consecutive errors needed to transition the state to `OPEN`. |
| `cooldownPeriod` | `number` | **Required** | The duration (in milliseconds) the circuit stays `OPEN` before trying to recover in `HALF-OPEN` state. |
| `maxRetries` | `number` | `3` | Maximum retry attempts for failed requests while in the `CLOSED` state. |
| `initialRetryDelay` | `number` | `500` | Initial delay (in milliseconds) for the exponential backoff calculation. |
| `isExpectedError` | `(err: unknown) => boolean` | `undefined` | A filter function. Errors returning `true` won't increment the failure counter. |

---

### 2. `CircuitBreaker` Class

#### Methods:
- `execute<T>(fn: () => Promise<T>): Promise<T>`: Wraps and executes your asynchronous function under the circuit breaker & retry rules.
- `getStatus(): CircuitStatus`: Returns current metrics and state (`state`, `failureCount`, `nextAttemptTime`, `activeRequests`).
- `subscribe(listener): () => void`: Subscribes to state change events. Returns an unsubscribe function.

---

### 3. `useCircuitBreaker` Hook Result

| Property | Type | Description |
| :--- | :--- | :--- |
| `state` | `CircuitState` | Current state: `'CLOSED' \| 'OPEN' \| 'HALF-OPEN'`. |
| `failureCount` | `number` | Total consecutive failures accumulated in the current cycle. |
| `activeRequests` | `number` | Number of concurrent requests actively running through this hook instance. |
| `execute` | `<T>(fn: () => Promise<T>) => Promise<T>` | Wraps the given async function execution in the circuit breaker rules. |
| `isOpened` | `boolean` | Helper flag that is `true` if the circuit is `OPEN` (useful for disabling UI action buttons). |

---

## Development & Testing 🛠️

Feel free to fork, open issues, or submit PRs!

```bash
# 1. Install dependencies
npm install

# 2. Run lint, formatting check, type checking, and unit tests
npm run validate

# 3. Run unit tests directly (powered by Vitest)
npm run test:run

# 4. Build package bundles (CJS & ESM formats)
npm run build
```

---

## License 📄

MIT © [mryos](https://github.com/mryos)
