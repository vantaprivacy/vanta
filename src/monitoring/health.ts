/**
 * VANTA Health Check System
 *
 * Monitors the health of all Vanta subsystems and exposes
 * a unified health endpoint for load balancers and monitoring.
 *
 * Health checks:
 *   - RPC connectivity
 *   - Relay network availability
 *   - Encryption subsystem
 *   - Memory/resource usage
 *   - Agent executor status
 */

import { Logger } from "../utils/logger";

const logger = new Logger("health");

// --- Types ---

export type HealthStatus = "healthy" | "degraded" | "unhealthy" | "unknown";

export interface ComponentHealth {
  name: string;
  status: HealthStatus;
  latencyMs: number;
  message?: string;
  lastChecked: number;
  metadata?: Record<string, unknown>;
}

export interface SystemHealth {
  status: HealthStatus;
  version: string;
  uptime: number;
  timestamp: string;
  components: ComponentHealth[];
  summary: {
    healthy: number;
    degraded: number;
    unhealthy: number;
    unknown: number;
  };
}

export interface HealthCheckConfig {
  /** How often to run health checks (ms) */
  intervalMs: number;
  /** Timeout for individual checks (ms) */
  checkTimeoutMs: number;
  /** Number of consecutive failures to mark unhealthy */
  failureThreshold: number;
  /** Number of consecutive successes to recover */
  recoveryThreshold: number;
  /** Whether to include detailed metadata in reports */
  includeMetadata: boolean;
}

export type HealthCheckFn = () => Promise<{
  status: HealthStatus;
  message?: string;
  metadata?: Record<string, unknown>;
}>;

interface RegisteredCheck {
  name: string;
  fn: HealthCheckFn;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  lastResult: ComponentHealth | null;
}

// --- Default Config ---

const DEFAULT_HEALTH_CONFIG: HealthCheckConfig = {
  intervalMs: 30_000,
  checkTimeoutMs: 5_000,
  failureThreshold: 3,
  recoveryThreshold: 2,
  includeMetadata: true,
};

// --- Health Monitor ---

export class HealthMonitor {
  private checks: Map<string, RegisteredCheck> = new Map();
  private config: HealthCheckConfig;
  private timer?: NodeJS.Timeout;
  private startTime: number = Date.now();
  private version: string;
  private lastSystemHealth: SystemHealth | null = null;

  constructor(version: string = "0.5.0", config?: Partial<HealthCheckConfig>) {
    this.version = version;
    this.config = { ...DEFAULT_HEALTH_CONFIG, ...config };
  }

  /**
   * Register a health check.
   */
  registerCheck(name: string, fn: HealthCheckFn): void {
    this.checks.set(name, {
      name,
      fn,
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
      lastResult: null,
    });
    logger.debug(`Registered health check: ${name}`);
  }

  /**
   * Remove a health check.
   */
  removeCheck(name: string): boolean {
    return this.checks.delete(name);
  }

  /**
   * Start periodic health checking.
   */
  start(): void {
    // Run immediately
    this.runAllChecks().catch((err) =>
      logger.error(`Initial health check failed: ${err}`)
    );

    this.timer = setInterval(
      () => this.runAllChecks().catch(() => {}),
      this.config.intervalMs
    );

    logger.info(
      `Health monitor started (${this.checks.size} checks, ` +
      `interval: ${this.config.intervalMs}ms)`
    );
  }

  /**
   * Stop periodic health checking.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    logger.info("Health monitor stopped");
  }

  /**
   * Run all health checks and return system health.
   */
  async runAllChecks(): Promise<SystemHealth> {
    const components: ComponentHealth[] = [];

    const checkPromises = [...this.checks.values()].map(async (check) => {
      const result = await this.runCheck(check);
      components.push(result);
    });

    await Promise.allSettled(checkPromises);

    const summary = {
      healthy: components.filter((c) => c.status === "healthy").length,
      degraded: components.filter((c) => c.status === "degraded").length,
      unhealthy: components.filter((c) => c.status === "unhealthy").length,
      unknown: components.filter((c) => c.status === "unknown").length,
    };

    // Determine overall status
    let overallStatus: HealthStatus = "healthy";
    if (summary.unhealthy > 0) {
      overallStatus = "unhealthy";
    } else if (summary.degraded > 0) {
      overallStatus = "degraded";
    } else if (summary.unknown > 0 && summary.healthy === 0) {
      overallStatus = "unknown";
    }

    const systemHealth: SystemHealth = {
      status: overallStatus,
      version: this.version,
      uptime: (Date.now() - this.startTime) / 1000,
      timestamp: new Date().toISOString(),
      components,
      summary,
    };

    this.lastSystemHealth = systemHealth;

    if (overallStatus !== "healthy") {
      logger.warn(
        `System health: ${overallStatus} ` +
        `(${summary.healthy}H/${summary.degraded}D/${summary.unhealthy}U)`
      );
    }

    return systemHealth;
  }

  /**
   * Get the last health check result without running new checks.
   */
  getLastHealth(): SystemHealth | null {
    return this.lastSystemHealth;
  }

  /**
   * Get health for a specific component.
   */
  getComponentHealth(name: string): ComponentHealth | null {
    const check = this.checks.get(name);
    return check?.lastResult ?? null;
  }

  /**
   * Check if the system is healthy.
   */
  isHealthy(): boolean {
    return this.lastSystemHealth?.status === "healthy";
  }

  // --- Private ---

  private async runCheck(check: RegisteredCheck): Promise<ComponentHealth> {
    const startTime = performance.now();

    try {
      const result = await Promise.race([
        check.fn(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("Health check timeout")),
            this.config.checkTimeoutMs
          )
        ),
      ]);

      const latencyMs = performance.now() - startTime;

      // Handle status transitions with hysteresis
      if (result.status === "healthy") {
        check.consecutiveSuccesses++;
        check.consecutiveFailures = 0;
      } else {
        check.consecutiveFailures++;
        check.consecutiveSuccesses = 0;
      }

      // Apply thresholds
      let effectiveStatus = result.status;
      if (
        result.status !== "healthy" &&
        check.consecutiveFailures < this.config.failureThreshold
      ) {
        effectiveStatus = "degraded"; // Not yet unhealthy
      }

      const component: ComponentHealth = {
        name: check.name,
        status: effectiveStatus,
        latencyMs,
        message: result.message,
        lastChecked: Date.now(),
        metadata: this.config.includeMetadata ? result.metadata : undefined,
      };

      check.lastResult = component;
      return component;
    } catch (error) {
      const latencyMs = performance.now() - startTime;
      check.consecutiveFailures++;
      check.consecutiveSuccesses = 0;

      const component: ComponentHealth = {
        name: check.name,
        status:
          check.consecutiveFailures >= this.config.failureThreshold
            ? "unhealthy"
            : "degraded",
        latencyMs,
        message: error instanceof Error ? error.message : "Unknown error",
        lastChecked: Date.now(),
      };

      check.lastResult = component;
      return component;
    }
  }
}

// --- Built-in Health Checks ---

/**
 * Create a health check for RPC connectivity.
 */
export function createRpcHealthCheck(rpcUrl: string): HealthCheckFn {
  return async () => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getHealth",
          params: [],
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (response.ok) {
        return { status: "healthy" as const, message: "RPC responding" };
      }
      return {
        status: "degraded" as const,
        message: `RPC returned ${response.status}`,
      };
    } catch (error) {
      return {
        status: "unhealthy" as const,
        message: `RPC unreachable: ${error instanceof Error ? error.message : "unknown"}`,
      };
    }
  };
}

/**
 * Create a health check for memory usage.
 */
export function createMemoryHealthCheck(
  maxHeapMB: number = 512
): HealthCheckFn {
  return async () => {
    const usage = process.memoryUsage();
    const heapMB = usage.heapUsed / (1024 * 1024);
    const rssMB = usage.rss / (1024 * 1024);

    const status: HealthStatus =
      heapMB > maxHeapMB ? "unhealthy" :
      heapMB > maxHeapMB * 0.8 ? "degraded" : "healthy";

    return {
      status,
      message: `Heap: ${heapMB.toFixed(1)}MB / ${maxHeapMB}MB`,
      metadata: {
        heapUsedMB: Math.round(heapMB),
        heapTotalMB: Math.round(usage.heapTotal / (1024 * 1024)),
        rssMB: Math.round(rssMB),
        externalMB: Math.round(usage.external / (1024 * 1024)),
      },
    };
  };
}

/**
 * Create a health check for event loop lag.
 */
export function createEventLoopHealthCheck(
  maxLagMs: number = 100
): HealthCheckFn {
  return async () => {
    const start = performance.now();

    await new Promise<void>((resolve) => setImmediate(resolve));

    const lag = performance.now() - start;

    const status: HealthStatus =
      lag > maxLagMs ? "unhealthy" :
      lag > maxLagMs * 0.5 ? "degraded" : "healthy";

    return {
      status,
      message: `Event loop lag: ${lag.toFixed(1)}ms`,
      metadata: { lagMs: lag },
    };
  };
}
