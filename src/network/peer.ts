/**
 * VANTA Peer Manager
 *
 * Manages peer discovery, connection lifecycle, and reputation
 * for the Vanta relay network. Peers are relay nodes that forward
 * encrypted intents to solvers.
 *
 * Discovery mechanisms:
 *   - Static seed peers (bootstrap)
 *   - DNS-based peer discovery
 *   - Gossip protocol (peer exchange)
 */

import { EventEmitter } from "events";
import { Logger } from "../utils/logger";
import { sha256 } from "../utils/crypto";

const logger = new Logger("peer");

// --- Types ---

export interface PeerInfo {
  /** Unique peer identifier (SHA-256 of public key) */
  id: string;
  /** Peer display name (optional) */
  name?: string;
  /** Multiaddress for connecting */
  address: string;
  /** Peer's advertised public key */
  publicKey: Uint8Array;
  /** Protocol version the peer supports */
  protocolVersion: string;
  /** Peer capabilities */
  capabilities: PeerCapability[];
  /** Current connection state */
  state: PeerState;
  /** Reputation score (0-100) */
  reputation: number;
  /** When this peer was first seen */
  firstSeen: number;
  /** When this peer was last seen active */
  lastSeen: number;
  /** Latency to this peer (ms) */
  latencyMs: number;
  /** Geographic region (inferred) */
  region: string;
  /** Number of intents successfully relayed through this peer */
  relayedCount: number;
  /** Number of relay failures */
  failureCount: number;
  /** Whether this is a seed/bootstrap peer */
  isSeed: boolean;
}

export type PeerState =
  | "discovered"
  | "connecting"
  | "connected"
  | "authenticated"
  | "disconnecting"
  | "disconnected"
  | "banned";

export type PeerCapability =
  | "relay"
  | "solve"
  | "validate"
  | "prove"
  | "archive";

export interface PeerManagerConfig {
  /** Seed peer addresses for bootstrap */
  seedPeers: string[];
  /** Maximum number of connected peers */
  maxPeers: number;
  /** Minimum number of connected peers (triggers discovery) */
  minPeers: number;
  /** Peer discovery interval (ms) */
  discoveryIntervalMs: number;
  /** Ping interval for connected peers (ms) */
  pingIntervalMs: number;
  /** Timeout for peer connections (ms) */
  connectionTimeoutMs: number;
  /** Minimum reputation to stay connected */
  minReputation: number;
  /** Reputation decay per hour */
  reputationDecayPerHour: number;
  /** Ban duration for misbehaving peers (ms) */
  banDurationMs: number;
  /** Maximum peer age before eviction (ms) */
  maxPeerAgeMs: number;
}

export interface PeerMetrics {
  totalDiscovered: number;
  currentConnected: number;
  currentAuthenticated: number;
  totalBanned: number;
  averageReputation: number;
  averageLatencyMs: number;
  totalRelayed: number;
  totalFailed: number;
}

// --- Default Config ---

const DEFAULT_PEER_CONFIG: PeerManagerConfig = {
  seedPeers: [
    "https://seed-1.relay.usevanta.xyz",
    "https://seed-2.relay.usevanta.xyz",
    "https://seed-3.relay.usevanta.xyz",
  ],
  maxPeers: 50,
  minPeers: 5,
  discoveryIntervalMs: 60_000,
  pingIntervalMs: 15_000,
  connectionTimeoutMs: 10_000,
  minReputation: 20,
  reputationDecayPerHour: 1,
  banDurationMs: 24 * 60 * 60 * 1000,
  maxPeerAgeMs: 7 * 24 * 60 * 60 * 1000,
};

// --- Peer Manager ---

export class PeerManager extends EventEmitter {
  private peers: Map<string, PeerInfo> = new Map();
  private bannedPeers: Map<string, number> = new Map(); // peerId -> ban expiry
  private config: PeerManagerConfig;
  private discoveryTimer?: NodeJS.Timeout;
  private pingTimer?: NodeJS.Timeout;
  private metrics: PeerMetrics = {
    totalDiscovered: 0,
    currentConnected: 0,
    currentAuthenticated: 0,
    totalBanned: 0,
    averageReputation: 0,
    averageLatencyMs: 0,
    totalRelayed: 0,
    totalFailed: 0,
  };

  constructor(config?: Partial<PeerManagerConfig>) {
    super();
    this.config = { ...DEFAULT_PEER_CONFIG, ...config };
  }

  /**
   * Start peer discovery and connection management.
   */
  async start(): Promise<void> {
    logger.info(
      `Peer manager starting (max: ${this.config.maxPeers}, ` +
      `seeds: ${this.config.seedPeers.length})`
    );

    // Bootstrap from seed peers
    await this.bootstrapFromSeeds();

    // Start periodic discovery
    this.discoveryTimer = setInterval(
      () => this.discoverPeers(),
      this.config.discoveryIntervalMs
    );

    // Start periodic ping
    this.pingTimer = setInterval(
      () => this.pingAll(),
      this.config.pingIntervalMs
    );
  }

  /**
   * Stop the peer manager and disconnect all peers.
   */
  async stop(): Promise<void> {
    if (this.discoveryTimer) clearInterval(this.discoveryTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);

    // Disconnect all peers gracefully
    const disconnects = [...this.peers.values()]
      .filter((p) => p.state === "connected" || p.state === "authenticated")
      .map((p) => this.disconnectPeer(p.id));

    await Promise.allSettled(disconnects);
    logger.info("Peer manager stopped");
  }

  /**
   * Add a discovered peer.
   */
  addPeer(
    address: string,
    publicKey: Uint8Array,
    capabilities: PeerCapability[] = ["relay"],
    isSeed: boolean = false
  ): PeerInfo | null {
    const id = this.computePeerId(publicKey);

    // Check if banned
    if (this.isBanned(id)) {
      logger.debug(`Ignoring banned peer ${id.slice(0, 8)}`);
      return null;
    }

    // Check if already known
    if (this.peers.has(id)) {
      const existing = this.peers.get(id)!;
      existing.lastSeen = Date.now();
      return existing;
    }

    // Check capacity
    if (this.peers.size >= this.config.maxPeers && !isSeed) {
      // Try to evict a low-reputation peer
      if (!this.evictLowestReputation()) {
        logger.debug("Peer limit reached, cannot add more");
        return null;
      }
    }

    const peer: PeerInfo = {
      id,
      address,
      publicKey,
      protocolVersion: "0.5.0",
      capabilities,
      state: "discovered",
      reputation: 50, // Start neutral
      firstSeen: Date.now(),
      lastSeen: Date.now(),
      latencyMs: 0,
      region: this.inferRegion(address),
      relayedCount: 0,
      failureCount: 0,
      isSeed,
    };

    this.peers.set(id, peer);
    this.metrics.totalDiscovered++;
    this.updateMetrics();

    this.emit("peerDiscovered", peer);
    logger.info(
      `Discovered peer ${id.slice(0, 8)} at ${address} ` +
      `[${capabilities.join(",")}] (${this.peers.size} total)`
    );

    return peer;
  }

  /**
   * Connect to a discovered peer.
   */
  async connectPeer(peerId: string): Promise<boolean> {
    const peer = this.peers.get(peerId);
    if (!peer) return false;

    if (peer.state === "connected" || peer.state === "authenticated") {
      return true; // Already connected
    }

    peer.state = "connecting";
    this.emit("peerConnecting", peer);

    try {
      // In production: establish WebSocket/QUIC connection
      const startTime = performance.now();
      await this.performHandshake(peer);
      peer.latencyMs = performance.now() - startTime;

      peer.state = "connected";
      this.metrics.currentConnected++;
      this.updateMetrics();

      this.emit("peerConnected", peer);
      logger.info(
        `Connected to ${peerId.slice(0, 8)} (${peer.latencyMs.toFixed(0)}ms)`
      );

      // Attempt authentication
      await this.authenticatePeer(peer);

      return true;
    } catch (error) {
      peer.state = "disconnected";
      this.adjustReputation(peerId, -5, "connection_failed");
      logger.warn(
        `Failed to connect to ${peerId.slice(0, 8)}: ${error}`
      );
      return false;
    }
  }

  /**
   * Disconnect from a peer.
   */
  async disconnectPeer(peerId: string): Promise<void> {
    const peer = this.peers.get(peerId);
    if (!peer) return;

    peer.state = "disconnecting";

    try {
      // In production: graceful close of connection
      await this.performDisconnect(peer);
    } catch {
      // Ignore disconnect errors
    }

    peer.state = "disconnected";
    if (this.metrics.currentConnected > 0) {
      this.metrics.currentConnected--;
    }
    this.updateMetrics();

    this.emit("peerDisconnected", peer);
    logger.info(`Disconnected from ${peerId.slice(0, 8)}`);
  }

  /**
   * Ban a misbehaving peer.
   */
  banPeer(peerId: string, reason: string): void {
    const peer = this.peers.get(peerId);
    if (peer) {
      peer.state = "banned";
      peer.reputation = 0;
    }

    this.bannedPeers.set(peerId, Date.now() + this.config.banDurationMs);
    this.peers.delete(peerId);
    this.metrics.totalBanned++;
    this.updateMetrics();

    this.emit("peerBanned", { peerId, reason });
    logger.warn(`Banned peer ${peerId.slice(0, 8)}: ${reason}`);
  }

  /**
   * Adjust a peer's reputation.
   */
  adjustReputation(peerId: string, delta: number, reason: string): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;

    const oldReputation = peer.reputation;
    peer.reputation = Math.min(100, Math.max(0, peer.reputation + delta));

    if (peer.reputation < this.config.minReputation) {
      this.banPeer(peerId, `reputation too low (${peer.reputation}): ${reason}`);
      return;
    }

    logger.debug(
      `Reputation ${peerId.slice(0, 8)}: ${oldReputation} -> ${peer.reputation} (${reason})`
    );
  }

  /**
   * Record a successful relay through a peer.
   */
  recordRelaySuccess(peerId: string): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;

    peer.relayedCount++;
    this.metrics.totalRelayed++;
    this.adjustReputation(peerId, 2, "relay_success");
  }

  /**
   * Record a relay failure through a peer.
   */
  recordRelayFailure(peerId: string): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;

    peer.failureCount++;
    this.metrics.totalFailed++;
    this.adjustReputation(peerId, -5, "relay_failure");
  }

  /**
   * Get peers suitable for relaying an intent.
   * Returns peers sorted by reputation * (1/latency).
   */
  getRelayPeers(count: number = 3): PeerInfo[] {
    return [...this.peers.values()]
      .filter(
        (p) =>
          p.state === "authenticated" &&
          p.capabilities.includes("relay") &&
          p.reputation >= this.config.minReputation
      )
      .sort((a, b) => {
        const scoreA = a.reputation / Math.max(1, a.latencyMs);
        const scoreB = b.reputation / Math.max(1, b.latencyMs);
        return scoreB - scoreA;
      })
      .slice(0, count);
  }

  /**
   * Get all known peers.
   */
  getAllPeers(): PeerInfo[] {
    return [...this.peers.values()];
  }

  /**
   * Get connected peer count.
   */
  getConnectedCount(): number {
    return [...this.peers.values()].filter(
      (p) => p.state === "connected" || p.state === "authenticated"
    ).length;
  }

  /**
   * Get metrics.
   */
  getMetrics(): Readonly<PeerMetrics> {
    return { ...this.metrics };
  }

  // --- Private ---

  private async bootstrapFromSeeds(): Promise<void> {
    logger.info(`Bootstrapping from ${this.config.seedPeers.length} seed peers`);

    for (const seedUrl of this.config.seedPeers) {
      // Generate a deterministic peer ID for seed peers
      const seedKey = new TextEncoder().encode(seedUrl);
      const pubKey = sha256(seedKey);

      this.addPeer(seedUrl, pubKey, ["relay", "validate"], true);
    }
  }

  private async discoverPeers(): Promise<void> {
    const connected = this.getConnectedCount();

    if (connected < this.config.minPeers) {
      logger.info(
        `Low peer count (${connected}/${this.config.minPeers}), ` +
        `triggering discovery`
      );

      // Ask connected peers for their peer lists (gossip)
      for (const peer of this.peers.values()) {
        if (peer.state === "authenticated") {
          try {
            await this.requestPeerList(peer);
          } catch {
            // Ignore discovery errors from individual peers
          }
        }
      }
    }

    // Clean up stale peers
    this.pruneStale();

    // Unban expired bans
    this.cleanExpiredBans();
  }

  private async pingAll(): Promise<void> {
    for (const peer of this.peers.values()) {
      if (peer.state === "connected" || peer.state === "authenticated") {
        try {
          const startTime = performance.now();
          await this.pingPeer(peer);
          peer.latencyMs = performance.now() - startTime;
          peer.lastSeen = Date.now();
        } catch {
          this.adjustReputation(peer.id, -2, "ping_timeout");
          if (peer.reputation < this.config.minReputation) {
            await this.disconnectPeer(peer.id);
          }
        }
      }
    }
  }

  private pruneStale(): void {
    const now = Date.now();
    for (const [id, peer] of this.peers) {
      if (
        peer.state === "disconnected" &&
        now - peer.lastSeen > this.config.maxPeerAgeMs &&
        !peer.isSeed
      ) {
        this.peers.delete(id);
      }
    }
    this.updateMetrics();
  }

  private cleanExpiredBans(): void {
    const now = Date.now();
    for (const [id, expiry] of this.bannedPeers) {
      if (now > expiry) {
        this.bannedPeers.delete(id);
      }
    }
  }

  private isBanned(peerId: string): boolean {
    const expiry = this.bannedPeers.get(peerId);
    if (!expiry) return false;
    if (Date.now() > expiry) {
      this.bannedPeers.delete(peerId);
      return false;
    }
    return true;
  }

  private evictLowestReputation(): boolean {
    let lowest: PeerInfo | null = null;

    for (const peer of this.peers.values()) {
      if (peer.isSeed) continue;
      if (!lowest || peer.reputation < lowest.reputation) {
        lowest = peer;
      }
    }

    if (lowest) {
      this.peers.delete(lowest.id);
      logger.debug(
        `Evicted peer ${lowest.id.slice(0, 8)} (rep: ${lowest.reputation})`
      );
      return true;
    }

    return false;
  }

  private computePeerId(publicKey: Uint8Array): string {
    return Buffer.from(sha256(publicKey)).toString("hex");
  }

  private inferRegion(address: string): string {
    if (address.includes("us-") || address.includes("seed-1")) return "us-east";
    if (address.includes("eu-") || address.includes("seed-2")) return "eu-west";
    if (address.includes("ap-") || address.includes("seed-3")) return "ap-southeast";
    return "unknown";
  }

  private async performHandshake(_peer: PeerInfo): Promise<void> {
    // Stub — production: TLS handshake + protocol negotiation
  }

  private async authenticatePeer(peer: PeerInfo): Promise<void> {
    // Stub — production: verify peer's public key signature
    peer.state = "authenticated";
    this.metrics.currentAuthenticated++;
    this.emit("peerAuthenticated", peer);
  }

  private async performDisconnect(_peer: PeerInfo): Promise<void> {
    // Stub — production: graceful connection close
  }

  private async requestPeerList(_peer: PeerInfo): Promise<void> {
    // Stub — production: gossip protocol peer exchange
  }

  private async pingPeer(_peer: PeerInfo): Promise<void> {
    // Stub — production: lightweight ping/pong
  }

  private updateMetrics(): void {
    const peers = [...this.peers.values()];
    this.metrics.currentConnected = peers.filter(
      (p) => p.state === "connected" || p.state === "authenticated"
    ).length;
    this.metrics.currentAuthenticated = peers.filter(
      (p) => p.state === "authenticated"
    ).length;

    if (peers.length > 0) {
      this.metrics.averageReputation =
        peers.reduce((s, p) => s + p.reputation, 0) / peers.length;
      const connectedPeers = peers.filter(
        (p) => p.latencyMs > 0
      );
      if (connectedPeers.length > 0) {
        this.metrics.averageLatencyMs =
          connectedPeers.reduce((s, p) => s + p.latencyMs, 0) /
          connectedPeers.length;
      }
    }
  }
}
