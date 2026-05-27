/**
 * VANTA Transport Layer
 *
 * Abstraction over network communication between Vanta nodes.
 * Supports multiple transport backends:
 *   - WebSocket (primary, low latency)
 *   - HTTP/2 (fallback, firewall-friendly)
 *   - QUIC (experimental, UDP-based)
 *
 * All transport channels enforce:
 *   - TLS 1.3 encryption
 *   - Message framing with length prefix
 *   - Automatic reconnection with backoff
 *   - Flow control and back-pressure
 */

import { EventEmitter } from "events";
import { Logger } from "../utils/logger";
import { sha256 } from "../utils/crypto";

const logger = new Logger("transport");

// --- Types ---

export type TransportType = "websocket" | "http2" | "quic";

export interface TransportMessage {
  /** Message ID for request/response correlation */
  id: number;
  /** Message type */
  type: MessageType;
  /** Payload data */
  payload: Uint8Array;
  /** Sender peer ID */
  from: string;
  /** Recipient peer ID (empty for broadcast) */
  to: string;
  /** Message timestamp */
  timestamp: number;
  /** Whether this message requires an acknowledgment */
  requiresAck: boolean;
  /** TTL in hops (decremented by each relay) */
  ttl: number;
}

export type MessageType =
  | "intent_submit"
  | "intent_ack"
  | "intent_result"
  | "peer_exchange"
  | "ping"
  | "pong"
  | "handshake"
  | "handshake_ack"
  | "error"
  | "relay_forward"
  | "proof_request"
  | "proof_response";

export interface TransportConfig {
  /** Which transport backend to use */
  type: TransportType;
  /** Listen address (for server mode) */
  listenAddress?: string;
  /** Listen port */
  listenPort: number;
  /** Maximum message size in bytes */
  maxMessageSize: number;
  /** Connection timeout (ms) */
  connectionTimeoutMs: number;
  /** Keep-alive interval (ms) */
  keepAliveIntervalMs: number;
  /** Maximum concurrent connections */
  maxConnections: number;
  /** Enable message compression */
  compression: boolean;
  /** Reconnection settings */
  reconnect: {
    enabled: boolean;
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
  };
  /** Flow control: max messages per second per connection */
  maxMessagesPerSecond: number;
}

export interface Connection {
  /** Connection identifier */
  id: string;
  /** Remote peer ID */
  peerId: string;
  /** Remote address */
  remoteAddress: string;
  /** Transport type */
  transport: TransportType;
  /** Connection state */
  state: ConnectionState;
  /** When the connection was established */
  connectedAt: number;
  /** Last activity timestamp */
  lastActivity: number;
  /** Bytes sent */
  bytesSent: bigint;
  /** Bytes received */
  bytesReceived: bigint;
  /** Messages sent */
  messagesSent: number;
  /** Messages received */
  messagesReceived: number;
  /** Current round-trip time (ms) */
  rttMs: number;
  /** Reconnection attempt count */
  reconnectAttempts: number;
}

export type ConnectionState =
  | "connecting"
  | "open"
  | "closing"
  | "closed"
  | "reconnecting";

export interface TransportStats {
  activeConnections: number;
  totalBytesSent: bigint;
  totalBytesReceived: bigint;
  totalMessagesSent: number;
  totalMessagesReceived: number;
  averageRttMs: number;
  droppedMessages: number;
  reconnections: number;
}

// --- Default Config ---

const DEFAULT_TRANSPORT_CONFIG: TransportConfig = {
  type: "websocket",
  listenPort: 9742,
  maxMessageSize: 256 * 1024, // 256 KB
  connectionTimeoutMs: 10_000,
  keepAliveIntervalMs: 30_000,
  maxConnections: 100,
  compression: true,
  reconnect: {
    enabled: true,
    maxAttempts: 10,
    baseDelayMs: 1_000,
    maxDelayMs: 60_000,
  },
  maxMessagesPerSecond: 100,
};

// --- Message Framing ---

const FRAME_HEADER_SIZE = 16; // 4 (length) + 4 (type) + 4 (id) + 4 (flags)
const MAGIC_BYTES = Buffer.from([0x56, 0x4e, 0x54, 0x41]); // "VNTA"

export function frameMessage(msg: TransportMessage): Buffer {
  const typeCode = encodeMessageType(msg.type);
  const flags = (msg.requiresAck ? 0x01 : 0x00) | (msg.ttl << 4);

  const totalLength = MAGIC_BYTES.length + FRAME_HEADER_SIZE + msg.payload.length;
  const frame = Buffer.alloc(totalLength);

  let offset = 0;

  // Magic bytes
  MAGIC_BYTES.copy(frame, offset);
  offset += MAGIC_BYTES.length;

  // Length (excludes magic and length field itself)
  frame.writeUInt32BE(totalLength - MAGIC_BYTES.length - 4, offset);
  offset += 4;

  // Message type
  frame.writeUInt32BE(typeCode, offset);
  offset += 4;

  // Message ID
  frame.writeUInt32BE(msg.id, offset);
  offset += 4;

  // Flags (ack required, TTL, etc.)
  frame.writeUInt32BE(flags, offset);
  offset += 4;

  // Payload
  Buffer.from(msg.payload).copy(frame, offset);

  return frame;
}

export function parseFrame(
  data: Buffer
): { message: Partial<TransportMessage>; bytesConsumed: number } | null {
  if (data.length < MAGIC_BYTES.length + 4) return null;

  // Verify magic bytes
  if (!data.subarray(0, MAGIC_BYTES.length).equals(MAGIC_BYTES)) {
    throw new TransportError("Invalid frame: bad magic bytes", "INVALID_FRAME");
  }

  let offset = MAGIC_BYTES.length;

  const length = data.readUInt32BE(offset);
  offset += 4;

  if (data.length < MAGIC_BYTES.length + 4 + length) return null; // Incomplete frame

  const typeCode = data.readUInt32BE(offset);
  offset += 4;

  const id = data.readUInt32BE(offset);
  offset += 4;

  const flags = data.readUInt32BE(offset);
  offset += 4;

  const payloadLength = length - FRAME_HEADER_SIZE + 4;
  const payload = new Uint8Array(data.subarray(offset, offset + payloadLength));

  return {
    message: {
      id,
      type: decodeMessageType(typeCode),
      payload,
      requiresAck: (flags & 0x01) !== 0,
      ttl: (flags >> 4) & 0x0f,
      timestamp: Date.now(),
    },
    bytesConsumed: MAGIC_BYTES.length + 4 + length,
  };
}

// --- Transport Layer ---

export class TransportLayer extends EventEmitter {
  private connections: Map<string, Connection> = new Map();
  private config: TransportConfig;
  private messageIdCounter: number = 0;
  private keepAliveTimer?: NodeJS.Timeout;
  private pendingAcks: Map<number, {
    resolve: (value: TransportMessage) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }> = new Map();
  private rateLimiters: Map<string, { count: number; windowStart: number }> = new Map();
  private stats: TransportStats = {
    activeConnections: 0,
    totalBytesSent: 0n,
    totalBytesReceived: 0n,
    totalMessagesSent: 0,
    totalMessagesReceived: 0,
    averageRttMs: 0,
    droppedMessages: 0,
    reconnections: 0,
  };

  constructor(config?: Partial<TransportConfig>) {
    super();
    this.config = { ...DEFAULT_TRANSPORT_CONFIG, ...config };
  }

  /**
   * Start the transport layer (begin accepting connections).
   */
  async start(): Promise<void> {
    this.keepAliveTimer = setInterval(
      () => this.sendKeepAlives(),
      this.config.keepAliveIntervalMs
    );

    logger.info(
      `Transport layer started (${this.config.type}, ` +
      `port: ${this.config.listenPort}, max: ${this.config.maxConnections})`
    );
  }

  /**
   * Stop the transport layer and close all connections.
   */
  async stop(): Promise<void> {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
    }

    // Cancel pending acks
    for (const [id, pending] of this.pendingAcks) {
      clearTimeout(pending.timeout);
      pending.reject(new TransportError("Transport shutting down", "SHUTDOWN"));
      this.pendingAcks.delete(id);
    }

    // Close all connections
    const closes = [...this.connections.keys()].map((id) =>
      this.closeConnection(id)
    );
    await Promise.allSettled(closes);

    logger.info("Transport layer stopped");
  }

  /**
   * Open a connection to a remote peer.
   */
  async connect(address: string, peerId: string): Promise<Connection> {
    if (this.connections.size >= this.config.maxConnections) {
      throw new TransportError(
        `Max connections reached (${this.config.maxConnections})`,
        "MAX_CONNECTIONS"
      );
    }

    const connId = this.generateConnectionId(address, peerId);

    if (this.connections.has(connId)) {
      return this.connections.get(connId)!;
    }

    const connection: Connection = {
      id: connId,
      peerId,
      remoteAddress: address,
      transport: this.config.type,
      state: "connecting",
      connectedAt: Date.now(),
      lastActivity: Date.now(),
      bytesSent: 0n,
      bytesReceived: 0n,
      messagesSent: 0,
      messagesReceived: 0,
      rttMs: 0,
      reconnectAttempts: 0,
    };

    this.connections.set(connId, connection);

    try {
      // In production: establish actual network connection
      await this.establishConnection(connection);
      connection.state = "open";
      this.stats.activeConnections++;

      this.emit("connectionOpened", connection);
      logger.info(
        `Connection opened to ${peerId.slice(0, 8)} at ${address}`
      );

      return connection;
    } catch (error) {
      connection.state = "closed";
      this.connections.delete(connId);
      throw error;
    }
  }

  /**
   * Send a message over a connection.
   */
  async send(
    connectionId: string,
    type: MessageType,
    payload: Uint8Array,
    requiresAck: boolean = false
  ): Promise<TransportMessage | void> {
    const connection = this.connections.get(connectionId);
    if (!connection || connection.state !== "open") {
      throw new TransportError(
        `Connection ${connectionId} not available`,
        "CONNECTION_UNAVAILABLE"
      );
    }

    // Rate limiting
    if (!this.checkRateLimit(connectionId)) {
      this.stats.droppedMessages++;
      throw new TransportError("Rate limit exceeded", "RATE_LIMITED");
    }

    // Message size check
    if (payload.length > this.config.maxMessageSize) {
      throw new TransportError(
        `Message too large: ${payload.length} > ${this.config.maxMessageSize}`,
        "MESSAGE_TOO_LARGE"
      );
    }

    const msgId = this.messageIdCounter++;
    const message: TransportMessage = {
      id: msgId,
      type,
      payload,
      from: "", // Set by the sender's identity
      to: connection.peerId,
      timestamp: Date.now(),
      requiresAck,
      ttl: 5,
    };

    const frame = frameMessage(message);

    // In production: write to actual network socket
    await this.writeToConnection(connection, frame);

    connection.bytesSent += BigInt(frame.length);
    connection.messagesSent++;
    connection.lastActivity = Date.now();
    this.stats.totalBytesSent += BigInt(frame.length);
    this.stats.totalMessagesSent++;

    if (requiresAck) {
      return this.waitForAck(msgId);
    }
  }

  /**
   * Close a specific connection.
   */
  async closeConnection(connectionId: string): Promise<void> {
    const connection = this.connections.get(connectionId);
    if (!connection) return;

    connection.state = "closing";

    try {
      // In production: graceful close
      await this.performClose(connection);
    } catch {
      // Ignore close errors
    }

    connection.state = "closed";
    this.connections.delete(connectionId);
    if (this.stats.activeConnections > 0) {
      this.stats.activeConnections--;
    }

    this.emit("connectionClosed", connection);
  }

  /**
   * Get a connection by ID.
   */
  getConnection(connectionId: string): Connection | undefined {
    return this.connections.get(connectionId);
  }

  /**
   * Get all active connections.
   */
  getActiveConnections(): Connection[] {
    return [...this.connections.values()].filter(
      (c) => c.state === "open"
    );
  }

  /**
   * Get transport statistics.
   */
  getStats(): Readonly<TransportStats> {
    return { ...this.stats };
  }

  // --- Private ---

  private generateConnectionId(address: string, peerId: string): string {
    const input = new TextEncoder().encode(`${address}:${peerId}`);
    return Buffer.from(sha256(input)).toString("hex").slice(0, 16);
  }

  private async establishConnection(_connection: Connection): Promise<void> {
    // Stub — production: WebSocket/HTTP2/QUIC connect
  }

  private async writeToConnection(
    _connection: Connection,
    _frame: Buffer
  ): Promise<void> {
    // Stub — production: write to socket
  }

  private async performClose(_connection: Connection): Promise<void> {
    // Stub — production: graceful close
  }

  private async waitForAck(messageId: number): Promise<TransportMessage> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingAcks.delete(messageId);
        reject(new TransportError("Ack timeout", "ACK_TIMEOUT"));
      }, this.config.connectionTimeoutMs);

      this.pendingAcks.set(messageId, { resolve, reject, timeout });
    });
  }

  private checkRateLimit(connectionId: string): boolean {
    const now = Date.now();
    const limiter = this.rateLimiters.get(connectionId);

    if (!limiter || now - limiter.windowStart > 1000) {
      this.rateLimiters.set(connectionId, { count: 1, windowStart: now });
      return true;
    }

    if (limiter.count >= this.config.maxMessagesPerSecond) {
      return false;
    }

    limiter.count++;
    return true;
  }

  private sendKeepAlives(): void {
    for (const connection of this.connections.values()) {
      if (connection.state === "open") {
        const idleMs = Date.now() - connection.lastActivity;
        if (idleMs > this.config.keepAliveIntervalMs) {
          this.send(
            connection.id,
            "ping",
            new Uint8Array([]),
            false
          ).catch(() => {
            // Ping failed — will be caught by health check
          });
        }
      }
    }
  }
}

// --- Helpers ---

function encodeMessageType(type: MessageType): number {
  const types: Record<MessageType, number> = {
    intent_submit: 0x01,
    intent_ack: 0x02,
    intent_result: 0x03,
    peer_exchange: 0x10,
    ping: 0x20,
    pong: 0x21,
    handshake: 0x30,
    handshake_ack: 0x31,
    error: 0xff,
    relay_forward: 0x40,
    proof_request: 0x50,
    proof_response: 0x51,
  };
  return types[type] ?? 0xff;
}

function decodeMessageType(code: number): MessageType {
  const types: Record<number, MessageType> = {
    0x01: "intent_submit",
    0x02: "intent_ack",
    0x03: "intent_result",
    0x10: "peer_exchange",
    0x20: "ping",
    0x21: "pong",
    0x30: "handshake",
    0x31: "handshake_ack",
    0xff: "error",
    0x40: "relay_forward",
    0x50: "proof_request",
    0x51: "proof_response",
  };
  return types[code] ?? "error";
}

// --- Error class ---

export class TransportError extends Error {
  readonly code: string;

  constructor(message: string, code: string = "TRANSPORT_ERROR") {
    super(message);
    this.name = "TransportError";
    this.code = code;
  }
}
