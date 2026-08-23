/**
 * The engine metrics plane (the P-4 blocker): a dependency-free,
 * line-auditable Prometheus registry — same posture as the JWS verifier:
 * the exposition surface is tiny, so it is implemented, not installed.
 *
 * Semantics:
 *  - Counters are monotonically increasing (delta from zero at boot).
 *  - Gauges may carry a `collect` callback, evaluated AT SCRAPE TIME (pool
 *    sizes, queue depths — values that must not be polled on a timer).
 *  - Histograms are fixed-bucket cumulative (Prometheus classic format)
 *    with a +Inf bucket and sum/count.
 *  - Every series is label-keyed; label VALUES are escaped per the
 *    exposition spec (backslash, quote, newline).
 *
 * Concurrency: increments are synchronous single-process operations on
 * plain numbers — Node's run-to-completion makes them race-free without
 * atomics. The registry is a process singleton exported as `metrics`.
 */

export type LabelValues = Record<string, string | number>;

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function formatLabels(labels: string[], values: LabelValues): string {
  if (labels.length === 0) {
    return '';
  }
  const parts = labels.map((name) => `${name}="${escapeLabelValue(String(values[name] ?? ''))}"`);
  return `{${parts.join(',')}}`;
}

class MetricBase {
  readonly series = new Map<string, { labels: LabelValues; value: number; buckets?: number[]; bucketCounts?: number[]; sum?: number; count?: number }>();

  constructor(
    readonly name: string,
    readonly help: string,
    readonly labelNames: string[],
  ) {}

  protected key(values: LabelValues): string {
    return this.labelNames.map((n) => `${n}=${String(values[n] ?? '')}`).join('|');
  }
}

export class Counter extends MetricBase {
  inc(values: LabelValues = {}, delta = 1): void {
    if (delta < 0) {
      throw new Error('counters only increase');
    }
    const key = this.key(values);
    const entry = this.series.get(key) ?? { labels: values, value: 0 };
    entry.value += delta;
    this.series.set(key, entry);
  }

  expose(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    if (this.series.size === 0) {
      lines.push(`${this.name} 0`);
    }
    for (const entry of this.series.values()) {
      lines.push(`${this.name}${formatLabels(this.labelNames, entry.labels)} ${entry.value}`);
    }
    return lines.join('\n');
  }
}

export class Gauge extends MetricBase {
  constructor(
    name: string,
    help: string,
    labelNames: string[],
    /** Evaluated at scrape time — no polling timers. */
    private readonly collect?: () => Array<{ labels: LabelValues; value: number }>,
  ) {
    super(name, help, labelNames);
  }

  set(values: LabelValues, value: number): void {
    this.series.set(this.key(values), { labels: values, value });
  }

  expose(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
    const snapshots = this.collect ? this.collect() : [];
    for (const snap of snapshots) {
      lines.push(`${this.name}${formatLabels(this.labelNames, snap.labels)} ${snap.value}`);
    }
    for (const entry of this.series.values()) {
      lines.push(`${this.name}${formatLabels(this.labelNames, entry.labels)} ${entry.value}`);
    }
    return lines.join('\n');
  }
}

const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export class Histogram extends MetricBase {
  private readonly buckets: number[];

  constructor(name: string, help: string, labelNames: string[], buckets: number[] = DEFAULT_BUCKETS) {
    super(name, help, [...labelNames, 'le']);
    this.buckets = [...buckets].sort((a, b) => a - b);
  }

  observe(values: LabelValues, seconds: number): void {
    const key = this.key(values);
    let entry = this.series.get(key);
    if (!entry) {
      entry = { labels: values, value: 0, buckets: this.buckets, bucketCounts: new Array(this.buckets.length + 1).fill(0), sum: 0, count: 0 };
      this.series.set(key, entry);
    }
    entry.sum = (entry.sum ?? 0) + seconds;
    entry.count = (entry.count ?? 0) + 1;
    let placed = false;
    for (let i = 0; i < this.buckets.length; i += 1) {
      if (!placed && seconds <= this.buckets[i]) {
        placed = true;
      }
      if (placed) {
        entry.bucketCounts![i] += 1;
      }
    }
    entry.bucketCounts![this.buckets.length] += 1; // +Inf
  }

  expose(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const entry of this.series.values()) {
      const base = this.labelNames.slice(0, -1); // drop 'le' — formatted per bucket
      const cumulative = entry.bucketCounts!;
      for (let i = 0; i < this.buckets.length; i += 1) {
        lines.push(`${this.name}_bucket${formatLabels([...base, 'le'], { ...entry.labels, le: this.buckets[i] })} ${cumulative[i]}`);
      }
      lines.push(`${this.name}_bucket${formatLabels([...base, 'le'], { ...entry.labels, le: '+Inf' })} ${cumulative[this.buckets.length]}`);
      lines.push(`${this.name}_sum${formatLabels(base, entry.labels)} ${entry.sum}`);
      lines.push(`${this.name}_count${formatLabels(base, entry.labels)} ${entry.count}`);
    }
    return lines.join('\n');
  }
}

/** The engine registry. Kernel-owned; modules import and increment. */
export class MetricsRegistry {
  private readonly counters = new Map<string, Counter>();
  private readonly gauges = new Map<string, Gauge>();
  private readonly histograms = new Map<string, Histogram>();

  counter(name: string, help: string, labels: string[] = []): Counter {
    let c = this.counters.get(name);
    if (!c) {
      c = new Counter(name, help, labels);
      this.counters.set(name, c);
    }
    return c;
  }

  gauge(name: string, help: string, labels: string[] = [], collect?: () => Array<{ labels: LabelValues; value: number }>): Gauge {
    let g = this.gauges.get(name);
    if (!g) {
      g = new Gauge(name, help, labels, collect);
      this.gauges.set(name, g);
    }
    return g;
  }

  histogram(name: string, help: string, labels: string[] = [], buckets?: number[]): Histogram {
    let h = this.histograms.get(name);
    if (!h) {
      h = new Histogram(name, help, labels, buckets);
      this.histograms.set(name, h);
    }
    return h;
  }

  /** The full exposition document (Prometheus text format, escaped). */
  expose(): string {
    return [
      ...[...this.counters.values()].map((c) => c.expose()),
      ...[...this.gauges.values()].map((g) => g.expose()),
      ...[...this.histograms.values()].map((h) => h.expose()),
    ].join('\n');
  }
}

/** Process singleton. */
export const metrics = new MetricsRegistry();

// ── the engine's standard instrument set (created once, shared names) ────────
export const httpRequestsTotal = metrics.counter('neryva_engine_http_requests_total', 'HTTP requests by route, method, status', ['route', 'method', 'status']);
export const httpRequestDuration = metrics.histogram('neryva_engine_http_request_duration_seconds', 'HTTP request latency by route', ['route', 'method']);
export const authFailuresTotal = metrics.counter('neryva_engine_auth_failures_total', 'Authentication failures by layer', ['layer', 'reason']);
export const meteringIngestRows = metrics.counter('neryva_engine_metering_ingest_rows_total', 'Spend rows accepted / duplicated / rejected', ['outcome']);
export const deploymentTransitions = metrics.counter('neryva_engine_deployment_transitions_total', 'Deployment status transitions', ['from', 'to']);
export const webhooksDelivered = metrics.counter('neryva_engine_webhook_deliveries_total', 'Webhook delivery attempts by outcome', ['outcome']);
