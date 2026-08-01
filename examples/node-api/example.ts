/**
 * Minimal Node API-style usage example (not a runnable server).
 * Copy into a route handler or worker.
 */
import {
  CircuitBreaker,
  CircuitOpenError,
  createCircuitFetch,
} from "ts-retry-circuit";

const upstream = new CircuitBreaker({
  name: "upstream-api",
  failureThreshold: 3,
  cooldownPeriod: 10_000,
  timeout: 3000,
  maxRetries: 1,
  capacity: 25,
  strategy: "rolling",
  volumeThreshold: 10,
  errorThresholdPercentage: 50,
});

const circuitFetch = createCircuitFetch(upstream);

export async function getUser(id: string) {
  try {
    const res = await circuitFetch(`https://api.example.com/users/${id}`, {
      expectedStatuses: [404],
    });
    if (res.status === 404) return null;
    return res.json();
  } catch (error) {
    if (error instanceof CircuitOpenError) {
      return { degraded: true, retryAfterMs: error.retryAfterMs };
    }
    throw error;
  }
}

upstream.on("open", (payload) => {
  console.warn("[circuit:open]", payload.name, payload.retryAfterMs);
});
