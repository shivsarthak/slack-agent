const SENSITIVE_KEYS = /^(?:authorization|cookie|content|credential|password|prompt|request|response|secret|token|userCode)$/i;

export const OPERATIONAL_METRICS = [
  "queue.admitted", "queue.denied", "lease.claimed", "lease.lost", "job.retry",
  "job.dead-letter", "session.started", "session.resumed", "tool.allowed", "tool.denied",
] as const;
export type OperationalMetricName = typeof OPERATIONAL_METRICS[number];
export interface Correlation { tenantId: string; jobId: string; outcome: string }
export interface MetricSample extends Correlation { name: OperationalMetricName; value: number }
export interface OperationalMetrics {
  increment(name: OperationalMetricName, correlation: Correlation, value?: number): void;
}

export function createInMemoryMetrics(): OperationalMetrics & { snapshot(): MetricSample[] } {
  const samples = new Map<string, MetricSample>();
  return {
    increment(name, correlation, value = 1) {
      const key = JSON.stringify([name, correlation.tenantId, correlation.jobId, correlation.outcome]);
      const current = samples.get(key);
      samples.set(key, { name, ...correlation, value: (current?.value ?? 0) + value });
    },
    snapshot: () => [...samples.values()],
  };
}

export interface TelemetryEvent extends Correlation {
  event: string;
  occurredAt: string;
  details?: unknown;
}

/** Emits JSON-safe structured events; content and credentials are removed recursively. */
export function createStructuredTelemetry(
  write: (entry: TelemetryEvent) => void,
  options: { now?: () => Date } = {},
) {
  const now = options.now ?? (() => new Date());
  return {
    emit(event: string, input: Correlation & { details?: unknown }): void {
      if (!event || !input.tenantId || !input.jobId) throw new Error("Telemetry requires event, Tenant, and Job correlation");
      write({ event, tenantId: input.tenantId, jobId: input.jobId, outcome: input.outcome,
        occurredAt: now().toISOString(), ...(input.details === undefined ? {} : { details: redact(input.details) }) });
    },
  };
}

export function redact(value: unknown, key = ""): unknown {
  if (SENSITIVE_KEYS.test(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redact(item, name)]));
  if (typeof value === "string")
    return value.replace(/\b(Bearer|Basic)\s+[^\s]+/gi, "$1 [REDACTED]")
      .replace(/\b(token|password|secret)([ =:]+)[^\s]+/gi, "$1$2[REDACTED]");
  return value;
}

export function createHealthHandler(input: { readiness(): Promise<void> }) {
  return async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    if (path === "/health") return Response.json({ status: "ok" });
    if (path !== "/ready") return Response.json({ error: "not found" }, { status: 404 });
    try {
      await input.readiness();
      return Response.json({ status: "ready" });
    } catch {
      return Response.json({ status: "not-ready" }, { status: 503 });
    }
  };
}
