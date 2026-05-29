/**
 * VANTA Metrics Collection
 *
 * Centralized metrics collection for all Vanta subsystems.
 * Provides counters, gauges, histograms, and rate computations.
 *
 * Metrics are exposed via a simple JSON API for monitoring
 * dashboards (Grafana, Datadog, etc.).
 */

import { Logger } from "../utils/logger";

const logger = new Logger("metrics");

// --- Types ---

export type MetricType = "counter" | "gauge" | "histogram";

export interface MetricDefinition {
  name: string;
  type: MetricType;
  description: string;
  labels?: string[];
  unit?: string;
}

export interface CounterValue {
  type: "counter";
  value: number;
  labels: Record<string, string>;
  createdAt: number;
}

export interface GaugeValue {
  type: "gauge";
  value: number;
  labels: Record<string, string>;
  updatedAt: number;
}

export interface HistogramValue {
  type: "histogram";
  count: number;
  sum: number;
  min: number;
  max: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  labels: Record<string, string>;
  updatedAt: number;
}

export type MetricValue = CounterValue | GaugeValue | HistogramValue;

export interface MetricSnapshot {
  name: string;
  type: MetricType;
  description: string;
  values: MetricValue[];
  timestamp: number;
}

export interface MetricsExport {
  timestamp: string;
  uptime: number;
  version: string;
  metrics: MetricSnapshot[];
}

// --- Histogram Bucket Helpers ---

function computePercentile(sorted: number[], percentile: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.ceil((percentile / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)];
}

// --- Metrics Collector ---

export class MetricsCollector {
  private definitions: Map<string, MetricDefinition> = new Map();
  private counters: Map<string, CounterValue[]> = new Map();
  private gauges: Map<string, GaugeValue[]> = new Map();
  private histograms: Map<string, { samples: number[]; labels: Record<string, string> }[]> =
    new Map();
  private startTime: number = Date.now();
  private version: string;

  constructor(version: string = "0.5.0") {
    this.version = version;
    this.registerDefaultMetrics();
    logger.info("Metrics collector initialized");
  }

  // --- Registration ---

  /**
   * Register a new metric definition.
   */
  register(definition: MetricDefinition): void {
    if (this.definitions.has(definition.name)) {
      logger.warn(`Metric ${definition.name} already registered, skipping`);
      return;
    }
    this.definitions.set(definition.name, definition);

    switch (definition.type) {
      case "counter":
        this.counters.set(definition.name, []);
        break;
      case "gauge":
        this.gauges.set(definition.name, []);
        break;
      case "histogram":
        this.histograms.set(definition.name, []);
        break;
    }
  }

  // --- Counter Operations ---

  /**
   * Increment a counter.
   */
  increment(name: string, labels: Record<string, string> = {}, value: number = 1): void {
    const counters = this.counters.get(name);
    if (!counters) {
      logger.warn(`Counter ${name} not registered`);
      return;
    }

    const existing = this.findByLabels(counters, labels);
    if (existing) {
      existing.value += value;
    } else {
      counters.push({
        type: "counter",
        value,
        labels,
        createdAt: Date.now(),
      });
    }
  }

  /**
   * Get a counter value.
   */
  getCounter(name: string, labels: Record<string, string> = {}): number {
    const counters = this.counters.get(name);
    if (!counters) return 0;
    const found = this.findByLabels(counters, labels);
    return found?.value ?? 0;
  }

  // --- Gauge Operations ---

  /**
   * Set a gauge value.
   */
  setGauge(name: string, value: number, labels: Record<string, string> = {}): void {
    const gauges = this.gauges.get(name);
    if (!gauges) {
      logger.warn(`Gauge ${name} not registered`);
      return;
    }

    const existing = this.findByLabels(gauges, labels);
    if (existing) {
      existing.value = value;
      existing.updatedAt = Date.now();
    } else {
      gauges.push({
        type: "gauge",
        value,
        labels,
        updatedAt: Date.now(),
      });
    }
  }

  /**
   * Increment a gauge value.
   */
  incrementGauge(name: string, delta: number = 1, labels: Record<string, string> = {}): void {
    const gauges = this.gauges.get(name);
    if (!gauges) return;

    const existing = this.findByLabels(gauges, labels);
    if (existing) {
      existing.value += delta;
      existing.updatedAt = Date.now();
    } else {
      this.setGauge(name, delta, labels);
    }
  }

  /**
   * Get a gauge value.
   */
  getGauge(name: string, labels: Record<string, string> = {}): number {
    const gauges = this.gauges.get(name);
    if (!gauges) return 0;
    const found = this.findByLabels(gauges, labels);
    return found?.value ?? 0;
  }

  // --- Histogram Operations ---

  /**
   * Record a value in a histogram.
   */
  observe(name: string, value: number, labels: Record<string, string> = {}): void {
    const histograms = this.histograms.get(name);
    if (!histograms) {
      logger.warn(`Histogram ${name} not registered`);
      return;
    }

    const existing = histograms.find(
      (h) => this.labelsMatch(h.labels, labels)
    );

    if (existing) {
      existing.samples.push(value);
      // Keep last 10000 samples to prevent unbounded growth
      if (existing.samples.length > 10_000) {
        existing.samples = existing.samples.slice(-5_000);
      }
    } else {
      histograms.push({ samples: [value], labels });
    }
  }

  /**
   * Get histogram statistics.
   */
  getHistogram(
    name: string,
    labels: Record<string, string> = {}
  ): HistogramValue | null {
    const histograms = this.histograms.get(name);
    if (!histograms) return null;

    const found = histograms.find(
      (h) => this.labelsMatch(h.labels, labels)
    );
    if (!found || found.samples.length === 0) return null;

    const sorted = [...found.samples].sort((a, b) => a - b);
    const sum = sorted.reduce((s, v) => s + v, 0);

    return {
      type: "histogram",
      count: sorted.length,
      sum,
      min: sorted[0],
      max: sorted[sorted.length - 1],
      mean: sum / sorted.length,
      p50: computePercentile(sorted, 50),
      p95: computePercentile(sorted, 95),
      p99: computePercentile(sorted, 99),
      labels,
      updatedAt: Date.now(),
    };
  }

  // --- Export ---

  /**
   * Export all metrics as a JSON-serializable object.
   */
  export(): MetricsExport {
    const metrics: MetricSnapshot[] = [];

    for (const [name, def] of this.definitions) {
      const snapshot: MetricSnapshot = {
        name,
        type: def.type,
        description: def.description,
        values: [],
        timestamp: Date.now(),
      };

      switch (def.type) {
        case "counter": {
          const counters = this.counters.get(name) ?? [];
          snapshot.values = counters;
          break;
        }
        case "gauge": {
          const gauges = this.gauges.get(name) ?? [];
          snapshot.values = gauges;
          break;
        }
        case "histogram": {
          const histograms = this.histograms.get(name) ?? [];
          for (const h of histograms) {
            const value = this.getHistogram(name, h.labels);
            if (value) snapshot.values.push(value);
          }
          break;
        }
      }

      metrics.push(snapshot);
    }

    return {
      timestamp: new Date().toISOString(),
      uptime: (Date.now() - this.startTime) / 1000,
      version: this.version,
      metrics,
    };
  }

  /**
   * Reset all metric values.
   */
  reset(): void {
    for (const counters of this.counters.values()) {
      counters.length = 0;
    }
    for (const gauges of this.gauges.values()) {
      gauges.length = 0;
    }
    for (const histograms of this.histograms.values()) {
      histograms.length = 0;
    }
    this.startTime = Date.now();
    logger.info("Metrics reset");
  }

  /**
   * Get uptime in seconds.
   */
  getUptime(): number {
    return (Date.now() - this.startTime) / 1000;
  }

  // --- Private ---

  private registerDefaultMetrics(): void {
    this.register({
      name: "vanta_intents_total",
      type: "counter",
      description: "Total number of intents processed",
      labels: ["status", "type"],
    });

    this.register({
      name: "vanta_intents_active",
      type: "gauge",
      description: "Number of currently active intents",
    });

    this.register({
      name: "vanta_intent_latency_ms",
      type: "histogram",
      description: "Intent processing latency in milliseconds",
      labels: ["type"],
      unit: "ms",
    });

    this.register({
      name: "vanta_relay_connections",
      type: "gauge",
      description: "Number of active relay connections",
    });

    this.register({
      name: "vanta_encryption_ops",
      type: "counter",
      description: "Number of encryption/decryption operations",
      labels: ["operation"],
    });

    this.register({
      name: "vanta_encryption_latency_us",
      type: "histogram",
      description: "Encryption operation latency in microseconds",
      labels: ["operation"],
      unit: "us",
    });

    this.register({
      name: "vanta_mev_blocked",
      type: "counter",
      description: "Number of MEV attacks blocked",
      labels: ["type"],
    });

    this.register({
      name: "vanta_mev_savings_lamports",
      type: "counter",
      description: "Total MEV savings in lamports",
    });

    this.register({
      name: "vanta_peer_count",
      type: "gauge",
      description: "Number of connected peers",
      labels: ["state"],
    });

    this.register({
      name: "vanta_agent_executions",
      type: "counter",
      description: "Number of agent strategy executions",
      labels: ["strategy", "status"],
    });

    this.register({
      name: "vanta_agent_execution_time_ms",
      type: "histogram",
      description: "Agent execution time in milliseconds",
      labels: ["strategy"],
      unit: "ms",
    });

    this.register({
      name: "vanta_rpc_requests",
      type: "counter",
      description: "Number of RPC requests",
      labels: ["method", "status"],
    });

    this.register({
      name: "vanta_rpc_latency_ms",
      type: "histogram",
      description: "RPC request latency in milliseconds",
      labels: ["endpoint"],
      unit: "ms",
    });
  }

  private findByLabels<T extends { labels: Record<string, string> }>(
    items: T[],
    labels: Record<string, string>
  ): T | undefined {
    return items.find((item) => this.labelsMatch(item.labels, labels));
  }

  private labelsMatch(
    a: Record<string, string>,
    b: Record<string, string>
  ): boolean {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    return keysA.every((key) => a[key] === b[key]);
  }
}

// --- Singleton for global metrics ---

let globalCollector: MetricsCollector | null = null;

export function getMetrics(): MetricsCollector {
  if (!globalCollector) {
    globalCollector = new MetricsCollector();
  }
  return globalCollector;
}

export function resetMetrics(): void {
  globalCollector = null;
}
