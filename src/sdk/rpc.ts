/**
 * VANTA RPC Client
 *
 * Provides a resilient JSON-RPC client for communicating with Solana
 * validators and Vanta relay nodes. Features:
 *   - Automatic failover across multiple endpoints
 *   - Request retry with exponential backoff
 *   - Connection health monitoring
 *   - Rate limiting per endpoint
 *   - Response caching for read-only calls
 */

import { Logger } from "../utils/logger";

const logger = new Logger("rpc");

// --- Types ---

export interface RpcEndpoint {
  /** RPC endpoint URL */
  url: string;
  /** Human-readable label */
  label: string;
  /** Weight for load balancing (higher = more traffic) */
  weight: number;
  /** Whether this endpoint is currently healthy */
  healthy: boolean;
  /** Current latency in ms */
  latencyMs: number;
  /** Number of errors in the current window */
  errorsInWindow: number;
  /** Number of successful requests in the current window */
  successesInWindow: number;
  /** Last health check timestamp */
  lastHealthCheck: number;
  /** Whether this is a premium/paid endpoint */
  premium: boolean;
  /** Rate limit: requests per second */
  rateLimit: number;
  /** Current request count in the rate limit window */
  requestCount: number;
  /** Rate limit window start */
  windowStart: number;
}

export interface RpcConfig {
  /** Primary RPC endpoints */
  endpoints: Array<{ url: string; label?: string; weight?: number; premium?: boolean }>;
  /** Maximum number of retries per request */
  maxRetries: number;
  /** Base delay for exponential backoff (ms) */
  baseRetryDelayMs: number;
  /** Maximum retry delay (ms) */
  maxRetryDelayMs: number;
  /** Request timeout (ms) */
  timeoutMs: number;
  /** Health check interval (ms) */
  healthCheckIntervalMs: number;
  /** Error threshold to mark endpoint unhealthy */
  errorThreshold: number;
  /** Window size for error counting (ms) */
  errorWindowMs: number;
  /** Enable response caching for read-only calls */
  enableCache: boolean;
  /** Cache TTL (ms) */
  cacheTTLMs: number;
  /** Maximum cache entries */
  maxCacheEntries: number;
  /** Commitment level for Solana RPC calls */
  commitment: "processed" | "confirmed" | "finalized";
}

export interface RpcRequest {
  method: string;
  params?: unknown[];
  id?: number;
}

export interface RpcResponse<T = unknown> {
  result: T;
  error?: { code: number; message: string; data?: unknown };
  id: number;
  /** Which endpoint handled the request */
  endpoint: string;
  /** Response time in ms */
  latencyMs: number;
  /** Whether the response was from cache */
  cached: boolean;
}

export interface RpcStats {
  totalRequests: number;
  totalErrors: number;
  totalRetries: number;
  cacheHits: number;
  cacheMisses: number;
  averageLatencyMs: number;
  endpointStats: Map<string, { requests: number; errors: number; avgLatencyMs: number }>;
}

// --- Default Config ---

const DEFAULT_RPC_CONFIG: RpcConfig = {
  endpoints: [
    { url: "https://api.mainnet-beta.solana.com", label: "Solana Public", weight: 1 },
  ],
  maxRetries: 3,
  baseRetryDelayMs: 500,
  maxRetryDelayMs: 10_000,
  timeoutMs: 30_000,
  healthCheckIntervalMs: 60_000,
  errorThreshold: 5,
  errorWindowMs: 60_000,
  enableCache: true,
  cacheTTLMs: 5_000,
  maxCacheEntries: 500,
  commitment: "confirmed",
};

/** Methods that can be safely cached */
const CACHEABLE_METHODS = new Set([
  "getBalance",
  "getAccountInfo",
  "getTokenAccountsByOwner",
  "getSlot",
  "getBlockHeight",
  "getRecentBlockhash",
  "getMinimumBalanceForRentExemption",
  "getVersion",
  "getEpochInfo",
  "getInflationRate",
]);

// --- RPC Client ---

export class RpcClient {
  private endpoints: Map<string, RpcEndpoint> = new Map();
  private config: RpcConfig;
  private cache: Map<string, { response: RpcResponse; expiry: number }> = new Map();
  private healthCheckTimer?: NodeJS.Timeout;
  private requestIdCounter: number = 1;
  private stats: RpcStats = {
    totalRequests: 0,
    totalErrors: 0,
    totalRetries: 0,
    cacheHits: 0,
    cacheMisses: 0,
    averageLatencyMs: 0,
    endpointStats: new Map(),
  };
  private latencySamples: number[] = [];

  constructor(config?: Partial<RpcConfig>) {
    this.config = { ...DEFAULT_RPC_CONFIG, ...config };
    this.initializeEndpoints();
  }

  /**
   * Start health monitoring for all endpoints.
   */
  start(): void {
    this.healthCheckTimer = setInterval(
      () => this.healthCheckAll(),
      this.config.healthCheckIntervalMs
    );
    logger.info(
      `RPC client started with ${this.endpoints.size} endpoints ` +
      `(cache: ${this.config.enableCache ? "on" : "off"})`
    );
  }

  /**
   * Stop health monitoring and clear cache.
   */
  stop(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = undefined;
    }
    this.cache.clear();
    logger.info("RPC client stopped");
  }

  /**
   * Send an RPC request with automatic failover and retry.
   */
  async call<T>(method: string, params: unknown[] = []): Promise<RpcResponse<T>> {
    this.stats.totalRequests++;

    // Check cache for read-only methods
    if (this.config.enableCache && CACHEABLE_METHODS.has(method)) {
      const cacheKey = this.buildCacheKey(method, params);
      const cached = this.getFromCache(cacheKey);
      if (cached) {
        this.stats.cacheHits++;
        return { ...cached, cached: true } as RpcResponse<T>;
      }
      this.stats.cacheMisses++;
    }

    const request: RpcRequest = {
      method,
      params,
      id: this.requestIdCounter++,
    };

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      const endpoint = this.selectEndpoint();
      if (!endpoint) {
        throw new RpcError("No healthy endpoints available", "NO_ENDPOINTS");
      }

      // Rate limiting
      if (!this.checkRateLimit(endpoint)) {
        logger.warn(`Rate limited on ${endpoint.label}, trying next`);
        continue;
      }

      try {
        if (attempt > 0) {
          const delay = this.computeBackoff(attempt);
          await this.sleep(delay);
          this.stats.totalRetries++;
        }

        const response = await this.sendRequest<T>(endpoint, request);

        // Cache successful read-only responses
        if (this.config.enableCache && CACHEABLE_METHODS.has(method)) {
          const cacheKey = this.buildCacheKey(method, params);
          this.setCache(cacheKey, response);
        }

        return response;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        this.recordEndpointError(endpoint);
        logger.warn(
          `RPC call ${method} failed on ${endpoint.label} ` +
          `(attempt ${attempt + 1}/${this.config.maxRetries + 1}): ${lastError.message}`
        );
      }
    }

    this.stats.totalErrors++;
    throw new RpcError(
      `RPC call ${method} failed after ${this.config.maxRetries + 1} attempts: ` +
      `${lastError?.message ?? "unknown error"}`,
      "MAX_RETRIES_EXCEEDED"
    );
  }

  // --- Convenience methods for common Solana RPC calls ---

  async getBalance(publicKey: string): Promise<bigint> {
    const response = await this.call<{ value: number }>("getBalance", [
      publicKey,
      { commitment: this.config.commitment },
    ]);
    return BigInt(response.result.value);
  }

  async getSlot(): Promise<number> {
    const response = await this.call<number>("getSlot", [
      { commitment: this.config.commitment },
    ]);
    return response.result;
  }

  async getBlockHeight(): Promise<number> {
    const response = await this.call<number>("getBlockHeight", [
      { commitment: this.config.commitment },
    ]);
    return response.result;
  }

  async getRecentBlockhash(): Promise<string> {
    const response = await this.call<{ value: { blockhash: string } }>(
      "getRecentBlockhash",
      [{ commitment: this.config.commitment }]
    );
    return response.result.value.blockhash;
  }

  async sendTransaction(serializedTx: string): Promise<string> {
    const response = await this.call<string>("sendTransaction", [
      serializedTx,
      { encoding: "base64", preflightCommitment: this.config.commitment },
    ]);
    return response.result;
  }

  async getTransaction(
    signature: string
  ): Promise<{ slot: number; meta: { err: unknown } | null } | null> {
    const response = await this.call<{
      slot: number;
      meta: { err: unknown } | null;
    } | null>("getTransaction", [
      signature,
      { encoding: "jsonParsed", commitment: this.config.commitment },
    ]);
    return response.result;
  }

  async getSignatureStatuses(
    signatures: string[]
  ): Promise<Array<{ slot: number; confirmationStatus: string } | null>> {
    const response = await this.call<{
      value: Array<{ slot: number; confirmationStatus: string } | null>;
    }>("getSignatureStatuses", [signatures]);
    return response.result.value;
  }

  // --- Stats & health ---

  /**
   * Get RPC client statistics.
   */
  getStats(): Readonly<RpcStats> {
    return { ...this.stats };
  }

  /**
   * Get all endpoint statuses.
   */
  getEndpoints(): RpcEndpoint[] {
    return [...this.endpoints.values()];
  }

  /**
   * Get healthy endpoint count.
   */
  getHealthyCount(): number {
    return [...this.endpoints.values()].filter((e) => e.healthy).length;
  }

  /**
   * Add a new endpoint dynamically.
   */
  addEndpoint(
    url: string,
    label?: string,
    weight?: number,
    premium?: boolean
  ): void {
    const endpoint: RpcEndpoint = {
      url,
      label: label ?? url,
      weight: weight ?? 1,
      healthy: true,
      latencyMs: 0,
      errorsInWindow: 0,
      successesInWindow: 0,
      lastHealthCheck: 0,
      premium: premium ?? false,
      rateLimit: premium ? 100 : 25,
      requestCount: 0,
      windowStart: Date.now(),
    };
    this.endpoints.set(url, endpoint);
    logger.info(`Added RPC endpoint: ${endpoint.label}`);
  }

  /**
   * Remove an endpoint.
   */
  removeEndpoint(url: string): boolean {
    return this.endpoints.delete(url);
  }

  // --- Private ---

  private initializeEndpoints(): void {
    for (const ep of this.config.endpoints) {
      const endpoint: RpcEndpoint = {
        url: ep.url,
        label: ep.label ?? ep.url,
        weight: ep.weight ?? 1,
        healthy: true,
        latencyMs: 0,
        errorsInWindow: 0,
        successesInWindow: 0,
        lastHealthCheck: 0,
        premium: ep.premium ?? false,
        rateLimit: ep.premium ? 100 : 25,
        requestCount: 0,
        windowStart: Date.now(),
      };
      this.endpoints.set(ep.url, endpoint);
    }
  }

  private selectEndpoint(): RpcEndpoint | null {
    const healthy = [...this.endpoints.values()].filter((e) => e.healthy);
    if (healthy.length === 0) return null;

    // Weighted random selection
    const totalWeight = healthy.reduce((s, e) => s + e.weight, 0);
    let random = Math.random() * totalWeight;

    for (const endpoint of healthy) {
      random -= endpoint.weight;
      if (random <= 0) return endpoint;
    }

    return healthy[0];
  }

  private checkRateLimit(endpoint: RpcEndpoint): boolean {
    const now = Date.now();
    if (now - endpoint.windowStart > 1000) {
      endpoint.requestCount = 0;
      endpoint.windowStart = now;
    }

    if (endpoint.requestCount >= endpoint.rateLimit) {
      return false;
    }

    endpoint.requestCount++;
    return true;
  }

  private async sendRequest<T>(
    endpoint: RpcEndpoint,
    request: RpcRequest
  ): Promise<RpcResponse<T>> {
    const startTime = performance.now();

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.config.timeoutMs
    );

    try {
      const response = await fetch(endpoint.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          method: request.method,
          params: request.params,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new RpcError(
          `HTTP ${response.status}: ${response.statusText}`,
          "HTTP_ERROR"
        );
      }

      const json = (await response.json()) as {
        result?: T;
        error?: { code: number; message: string };
        id: number;
      };

      if (json.error) {
        throw new RpcError(
          `RPC error ${json.error.code}: ${json.error.message}`,
          "RPC_ERROR"
        );
      }

      const latencyMs = performance.now() - startTime;
      endpoint.latencyMs = latencyMs;
      endpoint.successesInWindow++;
      this.recordLatency(latencyMs);
      this.recordEndpointSuccess(endpoint);

      return {
        result: json.result as T,
        id: json.id,
        endpoint: endpoint.label,
        latencyMs,
        cached: false,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async healthCheckAll(): Promise<void> {
    for (const endpoint of this.endpoints.values()) {
      await this.healthCheck(endpoint);
    }
  }

  private async healthCheck(endpoint: RpcEndpoint): Promise<void> {
    try {
      const startTime = performance.now();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5_000);

      try {
        const response = await fetch(endpoint.url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 0,
            method: "getHealth",
            params: [],
          }),
          signal: controller.signal,
        });

        endpoint.latencyMs = performance.now() - startTime;
        endpoint.healthy = response.ok;
        endpoint.lastHealthCheck = Date.now();
      } finally {
        clearTimeout(timeout);
      }
    } catch {
      endpoint.healthy = false;
      endpoint.lastHealthCheck = Date.now();
    }

    // Reset error window
    const now = Date.now();
    if (now - endpoint.windowStart > this.config.errorWindowMs) {
      endpoint.errorsInWindow = 0;
      endpoint.successesInWindow = 0;
      endpoint.windowStart = now;
    }
  }

  private recordEndpointError(endpoint: RpcEndpoint): void {
    endpoint.errorsInWindow++;
    if (endpoint.errorsInWindow >= this.config.errorThreshold) {
      endpoint.healthy = false;
      logger.warn(
        `Endpoint ${endpoint.label} marked unhealthy ` +
        `(${endpoint.errorsInWindow} errors in window)`
      );
    }
  }

  private recordEndpointSuccess(endpoint: RpcEndpoint): void {
    // Track per-endpoint stats
    const stats = this.stats.endpointStats.get(endpoint.url) ?? {
      requests: 0,
      errors: 0,
      avgLatencyMs: 0,
    };
    stats.requests++;
    stats.avgLatencyMs =
      (stats.avgLatencyMs * (stats.requests - 1) + endpoint.latencyMs) /
      stats.requests;
    this.stats.endpointStats.set(endpoint.url, stats);
  }

  private recordLatency(ms: number): void {
    this.latencySamples.push(ms);
    if (this.latencySamples.length > 1000) {
      this.latencySamples = this.latencySamples.slice(-500);
    }
    this.stats.averageLatencyMs =
      this.latencySamples.reduce((a, b) => a + b, 0) /
      this.latencySamples.length;
  }

  private buildCacheKey(method: string, params: unknown[]): string {
    return `${method}:${JSON.stringify(params)}`;
  }

  private getFromCache(key: string): RpcResponse | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiry) {
      this.cache.delete(key);
      return null;
    }
    return entry.response;
  }

  private setCache(key: string, response: RpcResponse): void {
    // Evict oldest if at capacity
    if (this.cache.size >= this.config.maxCacheEntries) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) this.cache.delete(firstKey);
    }

    this.cache.set(key, {
      response,
      expiry: Date.now() + this.config.cacheTTLMs,
    });
  }

  private computeBackoff(attempt: number): number {
    const delay = this.config.baseRetryDelayMs * Math.pow(2, attempt - 1);
    const jitter = Math.random() * delay * 0.3;
    return Math.min(delay + jitter, this.config.maxRetryDelayMs);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// --- Error class ---

export class RpcError extends Error {
  readonly code: string;

  constructor(message: string, code: string = "RPC_ERROR") {
    super(message);
    this.name = "RpcError";
    this.code = code;
  }
}
