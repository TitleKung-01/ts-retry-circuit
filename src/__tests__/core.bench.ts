import { bench, describe } from "vitest";
import { CircuitBreaker } from "../core.js";

describe("CircuitBreaker overhead", () => {
  bench("execute success path", async () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 5,
      cooldownPeriod: 1000,
      maxRetries: 0,
    });
    await breaker.execute(async () => 1);
  });

  bench("execute with events subscribed", async () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 5,
      cooldownPeriod: 1000,
      maxRetries: 0,
    });
    breaker.on("success", () => undefined);
    await breaker.execute(async () => 1);
  });
});
