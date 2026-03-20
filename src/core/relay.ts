import { Logger } from "../utils/logger";

export interface RelayNode {
  url: string;
  region: string;
  latencyMs: number;
  healthy: boolean;
  lastCheck: number;
}

export interface RelayConfig {
  healthCheckIntervalMs: number;
  maxLatencyMs: number;
  minHealthyNodes: number;
}

const DEFAULT_RELAY_CONFIG: RelayConfig = {
  healthCheckIntervalMs: 30_000,
  maxLatencyMs: 5_000,
  minHealthyNodes: 2,
};

const logger = new Logger("relay");

export class RelayNetwork {
  private nodes: Map<string, RelayNode> = new Map();
  private config: RelayConfig;
  private healthCheckTimer?: NodeJS.Timeout;

  constructor(nodeUrls: string[], config?: Partial<RelayConfig>) {
    this.config = { ...DEFAULT_RELAY_CONFIG, ...config };

    for (const url of nodeUrls) {
      this.nodes.set(url, {
        url,
        region: this.inferRegion(url),
        latencyMs: 0,
        healthy: true,
        lastCheck: 0,
      });
    }
  }

  start(): void {
    this.healthCheckTimer = setInterval(
      () => this.healthCheck(),
      this.config.healthCheckIntervalMs
    );
    logger.info(`Relay network started with ${this.nodes.size} nodes`);
  }

  stop(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
    }
  }

  getHealthyNodes(): RelayNode[] {
    return [...this.nodes.values()].filter(
      (n) => n.healthy && n.latencyMs < this.config.maxLatencyMs
    );
  }

  getBestNode(): RelayNode | null {
    const healthy = this.getHealthyNodes();
    if (healthy.length === 0) return null;
    return healthy.sort((a, b) => a.latencyMs - b.latencyMs)[0];
  }

  private async healthCheck(): Promise<void> {
    for (const [url, node] of this.nodes) {
      const start = Date.now();
      try {
        // Ping relay health endpoint
        const controller = new AbortController();
        setTimeout(() => controller.abort(), this.config.maxLatencyMs);

        await fetch(`${url}/health`, { signal: controller.signal });

        node.latencyMs = Date.now() - start;
        node.healthy = true;
      } catch {
        node.healthy = false;
        node.latencyMs = Infinity;
        logger.warn(`Relay ${url} unhealthy`);
      }
      node.lastCheck = Date.now();
    }

    const healthyCount = this.getHealthyNodes().length;
    if (healthyCount < this.config.minHealthyNodes) {
      logger.error(
        `Only ${healthyCount} healthy relay nodes (min: ${this.config.minHealthyNodes})`
      );
    }
  }

  private inferRegion(url: string): string {
    if (url.includes("relay-1")) return "us-east";
    if (url.includes("relay-2")) return "eu-west";
    if (url.includes("relay-3")) return "ap-southeast";
    return "unknown";
  }
}
// refactor: catch network errors in health probe
