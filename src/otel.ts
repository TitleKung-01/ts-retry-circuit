import type {
  CircuitBreaker,
  CircuitEvent,
  CircuitEventPayload,
} from "./core.js";

export interface CircuitOtelMeter {
  createCounter(
    name: string,
    options?: { description?: string },
  ): { add: (value: number, attributes?: Record<string, string>) => void };
  createHistogram(
    name: string,
    options?: { description?: string; unit?: string },
  ): { record: (value: number, attributes?: Record<string, string>) => void };
}

export interface CircuitOtelSpan {
  setAttribute: (key: string, value: string | number | boolean) => void;
  recordException: (error: unknown) => void;
  setStatus: (status: { code: number; message?: string }) => void;
  end: () => void;
}

export interface CircuitOtelTracer {
  startActiveSpan<T>(
    name: string,
    fn: (span: CircuitOtelSpan) => Promise<T>,
  ): Promise<T>;
}

export interface InstrumentCircuitOptions {
  meter?: CircuitOtelMeter;
  tracer?: CircuitOtelTracer;
  /** Attribute prefix (default: circuit) */
  prefix?: string;
}

const SPAN_ERROR = 2;

/**
 * Attach OpenTelemetry-style metrics (and optional execute tracing) to a breaker.
 * Pass meter/tracer from `@opentelemetry/api` — optional peer, no hard dependency.
 *
 * @returns unsubscribe / restore function
 */
export function instrumentCircuitBreaker(
  breaker: CircuitBreaker,
  options: InstrumentCircuitOptions = {},
): () => void {
  const prefix = options.prefix ?? "circuit";
  const name = breaker.name ?? "default";
  const baseAttrs = { [`${prefix}.name`]: name };

  const counter = options.meter?.createCounter(`${prefix}.events`, {
    description: "Circuit breaker lifecycle and outcome events",
  });
  const latency = options.meter?.createHistogram(`${prefix}.attempt.duration`, {
    description: "Per-attempt duration",
    unit: "ms",
  });

  const events: CircuitEvent[] = [
    "open",
    "close",
    "halfOpen",
    "success",
    "failure",
    "reject",
    "timeout",
    "fallback",
    "retry",
  ];

  const offs = events.map((event) =>
    breaker.on(event, (payload: CircuitEventPayload) => {
      counter?.add(1, {
        ...baseAttrs,
        [`${prefix}.event`]: event,
        [`${prefix}.state`]: payload.state,
      });
      if (payload.durationMs !== undefined) {
        latency?.record(payload.durationMs, {
          ...baseAttrs,
          [`${prefix}.event`]: event,
        });
      }
    }),
  );

  return () => {
    for (const off of offs) off();
  };
}

/**
 * Execute work inside an active OTel span bound to the circuit name/state.
 */
export async function tracedExecute<T>(
  breaker: CircuitBreaker,
  tracer: CircuitOtelTracer,
  fn: (signal: AbortSignal) => Promise<T>,
  execOptions?: { signal?: AbortSignal },
  prefix = "circuit",
): Promise<T> {
  const name = breaker.name ?? "default";
  return tracer.startActiveSpan(`${prefix}.execute`, async (span) => {
    span.setAttribute(`${prefix}.name`, name);
    span.setAttribute(`${prefix}.state`, breaker.getStatus().state);
    try {
      const result = await breaker.execute(fn, execOptions);
      span.setAttribute(`${prefix}.outcome`, "success");
      return result;
    } catch (error) {
      span.recordException(error);
      span.setStatus({ code: SPAN_ERROR, message: String(error) });
      span.setAttribute(`${prefix}.outcome`, "error");
      throw error;
    } finally {
      span.setAttribute(`${prefix}.state`, breaker.getStatus().state);
      span.end();
    }
  });
}
