/**
 * VANTA Wire Protocol
 *
 * Defines the protocol messages, serialization format, and
 * versioning for communication between Vanta nodes.
 *
 * Protocol version: 1.0
 *
 * Message flow:
 *   Client -> Relay:  Handshake -> IntentSubmit -> [wait] -> IntentResult
 *   Relay  -> Solver: IntentForward -> SolveResult
 *   Relay  -> Relay:  PeerExchange, RelayForward
 */

import { Logger } from "../utils/logger";

const logger = new Logger("protocol");

// --- Protocol Version ---

export const PROTOCOL_VERSION = "1.0.0";
export const MIN_SUPPORTED_VERSION = "0.5.0";

// --- Message Definitions ---

export interface ProtocolMessage {
  /** Protocol version */
  version: string;
  /** Message type identifier */
  type: ProtocolMessageType;
  /** Unique message ID */
  id: string;
  /** Sender node ID */
  sender: string;
  /** Timestamp (ISO 8601) */
  timestamp: string;
  /** Signature over the message (hex) */
  signature: string;
  /** Message payload */
  body: MessageBody;
}

export type ProtocolMessageType =
  | "handshake_init"
  | "handshake_response"
  | "intent_submit"
  | "intent_ack"
  | "intent_forward"
  | "intent_result"
  | "solve_request"
  | "solve_response"
  | "peer_list_request"
  | "peer_list_response"
  | "relay_status"
  | "error_report"
  | "heartbeat";

export type MessageBody =
  | HandshakeInit
  | HandshakeResponse
  | IntentSubmitBody
  | IntentAckBody
  | IntentForwardBody
  | IntentResultBody
  | SolveRequestBody
  | SolveResponseBody
  | PeerListRequest
  | PeerListResponse
  | RelayStatusBody
  | ErrorReportBody
  | HeartbeatBody;

// --- Handshake ---

export interface HandshakeInit {
  type: "handshake_init";
  /** Client's protocol version */
  protocolVersion: string;
  /** Client's public key (base64) */
  publicKey: string;
  /** Supported capabilities */
  capabilities: string[];
  /** Client's preferred network (mainnet/devnet/testnet) */
  network: "mainnet-beta" | "devnet" | "testnet";
  /** Random challenge for authentication */
  challenge: string;
  /** Client user agent */
  userAgent: string;
}

export interface HandshakeResponse {
  type: "handshake_response";
  /** Server's protocol version */
  protocolVersion: string;
  /** Whether the handshake is accepted */
  accepted: boolean;
  /** Rejection reason (if not accepted) */
  rejectReason?: string;
  /** Server's public key */
  publicKey: string;
  /** Signed challenge response */
  challengeResponse: string;
  /** Session token for subsequent messages */
  sessionToken: string;
  /** Session TTL in seconds */
  sessionTTL: number;
  /** Server's capabilities */
  capabilities: string[];
}

// --- Intent Messages ---

export interface IntentSubmitBody {
  type: "intent_submit";
  /** Encrypted intent payload (base64) */
  encryptedPayload: string;
  /** Intent nonce (base64) */
  nonce: string;
  /** Privacy level requested */
  privacyLevel: "standard" | "enhanced" | "maximum";
  /** Solver tip in lamports */
  tipLamports: string; // string for bigint serialization
  /** Preferred solver list (optional) */
  preferredSolvers?: string[];
  /** Intent TTL in seconds */
  ttl: number;
}

export interface IntentAckBody {
  type: "intent_ack";
  /** Intent ID */
  intentId: string;
  /** Acknowledgment status */
  status: "accepted" | "rejected" | "queued";
  /** Queue position (if queued) */
  queuePosition?: number;
  /** Estimated execution time (seconds) */
  estimatedTimeSeconds?: number;
  /** Rejection reason (if rejected) */
  rejectReason?: string;
}

export interface IntentForwardBody {
  type: "intent_forward";
  /** Original intent submission */
  intent: IntentSubmitBody;
  /** Relay path (list of relay node IDs) */
  relayPath: string[];
  /** Remaining hops */
  remainingHops: number;
  /** Forwarding relay's signature */
  relaySignature: string;
}

export interface IntentResultBody {
  type: "intent_result";
  /** Intent ID */
  intentId: string;
  /** Execution status */
  status: "executed" | "failed" | "expired" | "cancelled";
  /** Transaction signature (if executed) */
  txSignature?: string;
  /** Execution slot */
  slot?: number;
  /** Solver node ID */
  solver?: string;
  /** Execution time (ms) */
  executionTimeMs?: number;
  /** Error message (if failed) */
  error?: string;
  /** MEV saved (lamports) */
  mevSaved?: string;
}

// --- Solver Messages ---

export interface SolveRequestBody {
  type: "solve_request";
  /** Encrypted intent to solve */
  encryptedPayload: string;
  /** Solver-specific parameters */
  params: {
    maxSlippage: number;
    preferredDex: string[];
    urgency: "low" | "normal" | "high";
  };
  /** Deadline (unix timestamp ms) */
  deadline: number;
}

export interface SolveResponseBody {
  type: "solve_response";
  /** Intent ID */
  intentId: string;
  /** Whether the solver can execute this intent */
  canSolve: boolean;
  /** Proposed execution route */
  route?: {
    dex: string;
    inputMint: string;
    outputMint: string;
    expectedOutput: string;
    priceImpact: number;
    fee: string;
  };
  /** Transaction to sign (base64) */
  transaction?: string;
}

// --- Peer Messages ---

export interface PeerListRequest {
  type: "peer_list_request";
  /** Maximum peers to return */
  maxPeers: number;
  /** Filter by capability */
  capability?: string;
  /** Filter by region */
  region?: string;
}

export interface PeerListResponse {
  type: "peer_list_response";
  /** List of known peers */
  peers: Array<{
    id: string;
    address: string;
    capabilities: string[];
    region: string;
    latencyMs: number;
    reputation: number;
  }>;
}

// --- Status Messages ---

export interface RelayStatusBody {
  type: "relay_status";
  /** Relay node ID */
  nodeId: string;
  /** Current load (0-1) */
  load: number;
  /** Active connections */
  activeConnections: number;
  /** Intents in queue */
  queueDepth: number;
  /** Uptime in seconds */
  uptimeSeconds: number;
  /** Version */
  version: string;
}

export interface ErrorReportBody {
  type: "error_report";
  /** Error code */
  code: string;
  /** Error message */
  message: string;
  /** Related intent ID (if applicable) */
  intentId?: string;
  /** Whether the error is recoverable */
  recoverable: boolean;
}

export interface HeartbeatBody {
  type: "heartbeat";
  /** Sequence number */
  seq: number;
  /** Current timestamp */
  timestamp: number;
  /** Node status */
  status: "healthy" | "degraded" | "overloaded";
}

// --- Protocol Codec ---

export class ProtocolCodec {
  private nodeId: string;

  constructor(nodeId: string) {
    this.nodeId = nodeId;
  }

  /**
   * Encode a protocol message to bytes.
   */
  encode(type: ProtocolMessageType, body: MessageBody): Uint8Array {
    const message: ProtocolMessage = {
      version: PROTOCOL_VERSION,
      type,
      id: this.generateMessageId(),
      sender: this.nodeId,
      timestamp: new Date().toISOString(),
      signature: "", // Set after serialization for signing
      body,
    };

    const json = JSON.stringify(message);
    return new TextEncoder().encode(json);
  }

  /**
   * Decode bytes to a protocol message.
   */
  decode(data: Uint8Array): ProtocolMessage {
    const json = new TextDecoder().decode(data);

    let parsed: ProtocolMessage;
    try {
      parsed = JSON.parse(json) as ProtocolMessage;
    } catch (error) {
      throw new ProtocolError(
        `Failed to decode message: ${error instanceof Error ? error.message : "parse error"}`,
        "DECODE_ERROR"
      );
    }

    this.validateMessage(parsed);
    return parsed;
  }

  /**
   * Check if a protocol version is compatible.
   */
  isCompatible(version: string): boolean {
    const [major, minor] = version.split(".").map(Number);
    const [minMajor, minMinor] = MIN_SUPPORTED_VERSION.split(".").map(Number);

    if (major < minMajor) return false;
    if (major === minMajor && minor < minMinor) return false;
    return true;
  }

  /**
   * Create a handshake init message.
   */
  createHandshake(
    publicKey: string,
    capabilities: string[],
    network: "mainnet-beta" | "devnet" | "testnet" = "mainnet-beta"
  ): Uint8Array {
    const body: HandshakeInit = {
      type: "handshake_init",
      protocolVersion: PROTOCOL_VERSION,
      publicKey,
      capabilities,
      network,
      challenge: this.generateChallenge(),
      userAgent: `vanta-sdk/${PROTOCOL_VERSION}`,
    };

    return this.encode("handshake_init", body);
  }

  /**
   * Create an intent submission message.
   */
  createIntentSubmit(
    encryptedPayload: Uint8Array,
    nonce: Uint8Array,
    tipLamports: bigint,
    ttl: number = 120,
    privacyLevel: "standard" | "enhanced" | "maximum" = "enhanced"
  ): Uint8Array {
    const body: IntentSubmitBody = {
      type: "intent_submit",
      encryptedPayload: Buffer.from(encryptedPayload).toString("base64"),
      nonce: Buffer.from(nonce).toString("base64"),
      privacyLevel,
      tipLamports: tipLamports.toString(),
      ttl,
    };

    return this.encode("intent_submit", body);
  }

  /**
   * Create an error report message.
   */
  createError(
    code: string,
    message: string,
    intentId?: string,
    recoverable: boolean = true
  ): Uint8Array {
    const body: ErrorReportBody = {
      type: "error_report",
      code,
      message,
      intentId,
      recoverable,
    };

    return this.encode("error_report", body);
  }

  /**
   * Create a heartbeat message.
   */
  createHeartbeat(
    seq: number,
    status: "healthy" | "degraded" | "overloaded" = "healthy"
  ): Uint8Array {
    const body: HeartbeatBody = {
      type: "heartbeat",
      seq,
      timestamp: Date.now(),
      status,
    };

    return this.encode("heartbeat", body);
  }

  // --- Private ---

  private validateMessage(msg: ProtocolMessage): void {
    if (!msg.version) {
      throw new ProtocolError("Missing protocol version", "MISSING_VERSION");
    }
    if (!this.isCompatible(msg.version)) {
      throw new ProtocolError(
        `Incompatible version: ${msg.version} (min: ${MIN_SUPPORTED_VERSION})`,
        "VERSION_MISMATCH"
      );
    }
    if (!msg.type) {
      throw new ProtocolError("Missing message type", "MISSING_TYPE");
    }
    if (!msg.id) {
      throw new ProtocolError("Missing message ID", "MISSING_ID");
    }

    logger.debug(
      `Decoded ${msg.type} from ${msg.sender?.slice(0, 8) ?? "unknown"} (v${msg.version})`
    );
  }

  private generateMessageId(): string {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).slice(2, 8);
    return `msg_${timestamp}_${random}`;
  }

  private generateChallenge(): string {
    const bytes = new Uint8Array(32);
    if (typeof globalThis.crypto !== "undefined") {
      globalThis.crypto.getRandomValues(bytes);
    } else {
      for (let i = 0; i < 32; i++) {
        bytes[i] = Math.floor(Math.random() * 256);
      }
    }
    return Buffer.from(bytes).toString("hex");
  }
}

// --- Error class ---

export class ProtocolError extends Error {
  readonly code: string;

  constructor(message: string, code: string = "PROTOCOL_ERROR") {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
  }
}
