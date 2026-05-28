/**
 * VANTA Wallet Adapter
 *
 * Integrates with Solana wallet standards to provide intent signing,
 * privacy-preserving transaction submission, and wallet state management.
 *
 * Supports:
 *   - Phantom, Solflare, Backpack via @solana/wallet-adapter
 *   - Raw keypair for CLI/bot usage
 *   - Hardware wallets via Ledger adapter
 */

import { Logger } from "../utils/logger";
import { sha256 } from "../utils/crypto";

const logger = new Logger("wallet");

// --- Types ---

export interface WalletAdapter {
  /** Display name of the wallet */
  name: string;
  /** Wallet public key (base58) */
  publicKey: string | null;
  /** Whether the wallet is currently connected */
  connected: boolean;
  /** Connect to the wallet */
  connect(): Promise<void>;
  /** Disconnect from the wallet */
  disconnect(): Promise<void>;
  /** Sign a message */
  signMessage(message: Uint8Array): Promise<Uint8Array>;
  /** Sign a transaction */
  signTransaction(transaction: SerializableTransaction): Promise<SignedTransaction>;
  /** Sign multiple transactions in batch */
  signAllTransactions(
    transactions: SerializableTransaction[]
  ): Promise<SignedTransaction[]>;
}

export interface SerializableTransaction {
  /** Serialized transaction bytes */
  data: Uint8Array;
  /** Recent blockhash */
  recentBlockhash: string;
  /** Fee payer public key */
  feePayer: string;
}

export interface SignedTransaction {
  /** Serialized signed transaction */
  data: Uint8Array;
  /** Transaction signature (base58) */
  signature: string;
}

export interface WalletState {
  /** Wallet adapter name */
  adapter: string;
  /** Public key (base58) */
  publicKey: string;
  /** SOL balance in lamports */
  balanceLamports: bigint;
  /** Connected RPC endpoint */
  rpcEndpoint: string;
  /** Last balance refresh timestamp */
  lastRefresh: number;
  /** Whether auto-approve is enabled for intents */
  autoApprove: boolean;
  /** Maximum auto-approve amount in lamports */
  autoApproveMaxLamports: bigint;
  /** Number of intents signed this session */
  intentsSigned: number;
}

export interface WalletConfig {
  /** RPC endpoint URL */
  rpcUrl: string;
  /** Whether to auto-approve intents below threshold */
  autoApprove: boolean;
  /** Max amount for auto-approval (lamports) */
  autoApproveMaxLamports: bigint;
  /** Commitment level for balance queries */
  commitment: "processed" | "confirmed" | "finalized";
  /** How often to refresh balance (ms) */
  balanceRefreshMs: number;
  /** Whether to preflight-simulate transactions */
  preflightSimulation: boolean;
}

export type WalletEvent =
  | { type: "connected"; publicKey: string }
  | { type: "disconnected" }
  | { type: "intentSigned"; intentId: string; signature: string }
  | { type: "balanceChanged"; oldBalance: bigint; newBalance: bigint }
  | { type: "error"; error: string };

type WalletEventHandler = (event: WalletEvent) => void;

// --- Default Config ---

const DEFAULT_WALLET_CONFIG: WalletConfig = {
  rpcUrl: "https://api.mainnet-beta.solana.com",
  autoApprove: false,
  autoApproveMaxLamports: 0n,
  commitment: "confirmed",
  balanceRefreshMs: 30_000,
  preflightSimulation: true,
};

// --- Wallet Manager ---

export class WalletManager {
  private adapter: WalletAdapter | null = null;
  private config: WalletConfig;
  private state: WalletState | null = null;
  private eventHandlers: WalletEventHandler[] = [];
  private balanceTimer?: NodeJS.Timeout;
  private nonceCounter: number = 0;

  constructor(config?: Partial<WalletConfig>) {
    this.config = { ...DEFAULT_WALLET_CONFIG, ...config };
  }

  /**
   * Connect a wallet adapter.
   * This is the primary entry point — call with your preferred adapter.
   */
  async connect(adapter: WalletAdapter): Promise<WalletState> {
    if (this.adapter?.connected) {
      await this.disconnect();
    }

    this.adapter = adapter;

    try {
      await adapter.connect();

      if (!adapter.publicKey) {
        throw new WalletError("Wallet connected but no public key available");
      }

      this.state = {
        adapter: adapter.name,
        publicKey: adapter.publicKey,
        balanceLamports: 0n,
        rpcEndpoint: this.config.rpcUrl,
        lastRefresh: 0,
        autoApprove: this.config.autoApprove,
        autoApproveMaxLamports: this.config.autoApproveMaxLamports,
        intentsSigned: 0,
      };

      // Initial balance fetch
      await this.refreshBalance();

      // Start balance polling
      this.startBalancePolling();

      this.emitEvent({ type: "connected", publicKey: adapter.publicKey });
      logger.info(
        `Connected: ${adapter.name} (${adapter.publicKey.slice(0, 8)}...)`
      );

      return { ...this.state };
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      this.emitEvent({ type: "error", error: msg });
      throw new WalletError(`Failed to connect ${adapter.name}: ${msg}`);
    }
  }

  /**
   * Disconnect the current wallet.
   */
  async disconnect(): Promise<void> {
    if (this.balanceTimer) {
      clearInterval(this.balanceTimer);
      this.balanceTimer = undefined;
    }

    if (this.adapter?.connected) {
      try {
        await this.adapter.disconnect();
      } catch (error) {
        logger.warn(`Disconnect error: ${error}`);
      }
    }

    const wasConnected = this.state?.publicKey;
    this.adapter = null;
    this.state = null;
    this.nonceCounter = 0;

    this.emitEvent({ type: "disconnected" });
    if (wasConnected) {
      logger.info(`Disconnected: ${wasConnected.slice(0, 8)}...`);
    }
  }

  /**
   * Sign an intent for relay submission.
   * The intent payload is signed with the wallet's private key
   * to prove ownership without revealing the strategy.
   */
  async signIntent(
    intentId: string,
    intentPayload: Uint8Array,
    amountLamports: bigint
  ): Promise<{ signature: Uint8Array; nonce: number }> {
    this.ensureConnected();

    // Auto-approve check
    if (
      this.config.autoApprove &&
      amountLamports <= this.config.autoApproveMaxLamports
    ) {
      logger.debug(
        `Auto-approving intent ${intentId} (${amountLamports} <= ` +
        `${this.config.autoApproveMaxLamports} lamports)`
      );
    }

    // Create the signable message:
    //   SHA256(intentId || payload || nonce || timestamp)
    const nonce = this.nonceCounter++;
    const timestamp = Date.now();
    const message = this.buildSignableMessage(
      intentId,
      intentPayload,
      nonce,
      timestamp
    );

    const signature = await this.adapter!.signMessage(message);

    this.state!.intentsSigned++;

    this.emitEvent({
      type: "intentSigned",
      intentId,
      signature: Buffer.from(signature).toString("hex").slice(0, 16) + "...",
    });

    logger.info(
      `Signed intent ${intentId} (nonce: ${nonce}, amount: ${amountLamports})`
    );

    return { signature, nonce };
  }

  /**
   * Sign and submit a transaction through the privacy layer.
   */
  async signTransaction(
    tx: SerializableTransaction
  ): Promise<SignedTransaction> {
    this.ensureConnected();

    if (this.config.preflightSimulation) {
      await this.simulateTransaction(tx);
    }

    return this.adapter!.signTransaction(tx);
  }

  /**
   * Sign a batch of transactions for atomic execution.
   */
  async signAllTransactions(
    transactions: SerializableTransaction[]
  ): Promise<SignedTransaction[]> {
    this.ensureConnected();

    if (transactions.length === 0) {
      return [];
    }

    if (transactions.length > 10) {
      throw new WalletError(
        `Batch too large: ${transactions.length} (max 10)`
      );
    }

    logger.info(`Signing batch of ${transactions.length} transactions`);
    return this.adapter!.signAllTransactions(transactions);
  }

  /**
   * Get the current wallet state.
   */
  getState(): Readonly<WalletState> | null {
    return this.state ? { ...this.state } : null;
  }

  /**
   * Get the connected public key.
   */
  getPublicKey(): string | null {
    return this.state?.publicKey ?? null;
  }

  /**
   * Check if a wallet is connected.
   */
  isConnected(): boolean {
    return this.adapter?.connected === true && this.state !== null;
  }

  /**
   * Register an event handler.
   */
  onEvent(handler: WalletEventHandler): () => void {
    this.eventHandlers.push(handler);
    return () => {
      this.eventHandlers = this.eventHandlers.filter((h) => h !== handler);
    };
  }

  /**
   * Force a balance refresh.
   */
  async refreshBalance(): Promise<bigint> {
    this.ensureConnected();

    try {
      // In production: RPC call to getBalance
      const balance = await this.fetchBalance(this.state!.publicKey);
      const oldBalance = this.state!.balanceLamports;

      this.state!.balanceLamports = balance;
      this.state!.lastRefresh = Date.now();

      if (oldBalance !== balance && oldBalance > 0n) {
        this.emitEvent({
          type: "balanceChanged",
          oldBalance,
          newBalance: balance,
        });
      }

      return balance;
    } catch (error) {
      logger.warn(`Balance refresh failed: ${error}`);
      return this.state!.balanceLamports;
    }
  }

  /**
   * Update auto-approve settings.
   */
  setAutoApprove(enabled: boolean, maxLamports?: bigint): void {
    this.config.autoApprove = enabled;
    if (maxLamports !== undefined) {
      this.config.autoApproveMaxLamports = maxLamports;
    }
    if (this.state) {
      this.state.autoApprove = enabled;
      this.state.autoApproveMaxLamports =
        maxLamports ?? this.state.autoApproveMaxLamports;
    }
    logger.info(
      `Auto-approve: ${enabled ? "ON" : "OFF"} ` +
      `(max: ${this.config.autoApproveMaxLamports} lamports)`
    );
  }

  // --- Private ---

  private ensureConnected(): void {
    if (!this.adapter?.connected || !this.state) {
      throw new WalletError("No wallet connected");
    }
  }

  private buildSignableMessage(
    intentId: string,
    payload: Uint8Array,
    nonce: number,
    timestamp: number
  ): Uint8Array {
    const intentIdBytes = new TextEncoder().encode(intentId);
    const nonceBytes = new Uint8Array(8);
    new DataView(nonceBytes.buffer).setBigUint64(0, BigInt(nonce));
    const timestampBytes = new Uint8Array(8);
    new DataView(timestampBytes.buffer).setBigUint64(0, BigInt(timestamp));

    const combined = new Uint8Array(
      intentIdBytes.length + payload.length + nonceBytes.length + timestampBytes.length
    );

    let offset = 0;
    combined.set(intentIdBytes, offset);
    offset += intentIdBytes.length;
    combined.set(payload, offset);
    offset += payload.length;
    combined.set(nonceBytes, offset);
    offset += nonceBytes.length;
    combined.set(timestampBytes, offset);

    return sha256(combined);
  }

  private async fetchBalance(_publicKey: string): Promise<bigint> {
    // Stub — production uses @solana/web3.js Connection.getBalance()
    // const connection = new Connection(this.config.rpcUrl, this.config.commitment);
    // const balance = await connection.getBalance(new PublicKey(publicKey));
    // return BigInt(balance);
    return 0n;
  }

  private async simulateTransaction(
    _tx: SerializableTransaction
  ): Promise<void> {
    // Stub — production simulates via RPC simulateTransaction
    logger.debug("Preflight simulation (stub)");
  }

  private startBalancePolling(): void {
    if (this.balanceTimer) {
      clearInterval(this.balanceTimer);
    }
    this.balanceTimer = setInterval(
      () => this.refreshBalance().catch(() => {}),
      this.config.balanceRefreshMs
    );
  }

  private emitEvent(event: WalletEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch (error) {
        logger.error(`Event handler error: ${error}`);
      }
    }
  }
}

// --- Keypair Adapter (for CLI/bots) ---

export class KeypairAdapter implements WalletAdapter {
  readonly name = "Keypair";
  publicKey: string | null = null;
  connected = false;

  private secretKey: Uint8Array;
  private pubKeyBytes: Uint8Array;

  constructor(secretKey: Uint8Array) {
    if (secretKey.length !== 64) {
      throw new WalletError("Secret key must be 64 bytes (ed25519 keypair)");
    }
    this.secretKey = secretKey;
    this.pubKeyBytes = secretKey.slice(32);
  }

  async connect(): Promise<void> {
    this.publicKey = Buffer.from(this.pubKeyBytes).toString("base64");
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.publicKey = null;
    this.connected = false;
  }

  async signMessage(message: Uint8Array): Promise<Uint8Array> {
    // In production: ed25519 sign via tweetnacl or @solana/web3.js
    const hash = sha256(
      new Uint8Array([...this.secretKey.slice(0, 32), ...message])
    );
    return hash;
  }

  async signTransaction(
    transaction: SerializableTransaction
  ): Promise<SignedTransaction> {
    const signature = await this.signMessage(transaction.data);
    return {
      data: new Uint8Array([...signature, ...transaction.data]),
      signature: Buffer.from(signature).toString("hex"),
    };
  }

  async signAllTransactions(
    transactions: SerializableTransaction[]
  ): Promise<SignedTransaction[]> {
    return Promise.all(transactions.map((tx) => this.signTransaction(tx)));
  }

  /**
   * Securely destroy the secret key from memory.
   */
  destroy(): void {
    this.secretKey.fill(0);
    this.pubKeyBytes.fill(0);
    this.connected = false;
    this.publicKey = null;
  }
}

// --- Error class ---

export class WalletError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WalletError";
  }
}
