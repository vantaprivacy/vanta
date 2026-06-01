<div align="center">

# VANTA

**Private Intent Execution Layer for Solana**

[![CI](https://github.com/vantaprivacy/vanta/actions/workflows/ci.yml/badge.svg)](https://github.com/vantaprivacy/vanta/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/@vanta-protocol/core.svg)](https://www.npmjs.com/package/@vanta-protocol/core)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5-blue.svg)](https://www.typescriptlang.org/)

[Website](https://usevanta.xyz) | [Docs](https://docs.usevanta.xyz) | [Blog](https://blog.usevanta.xyz) | [Twitter](https://x.com/vantaprivacy_)

</div>

---

> **Status: Beta** — Core intent encryption and MEV protection are functional. ZK proofs are behind a feature flag (Groth16 backend, WIP). Mainnet launch pending audit.

## What is VANTA?

VANTA is a privacy-preserving execution layer for Solana that protects DeFi users from MEV extraction. Instead of broadcasting raw transactions to the mempool, users submit **encrypted intents** that are:

1. **Encrypted** with AES-256-GCM before leaving the client
2. **Routed** through a decentralized relay network
3. **Shielded** from sandwich attacks via Jito bundle submission
4. **Verified** (planned) with zero-knowledge proofs for intent validity

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐     ┌──────────┐
│  User SDK   │────▶│ Privacy Layer│────▶│ Relay Network│────▶│  Solver  │
│  (encrypt)  │     │  (AES-256)   │     │  (k-of-n)   │     │  (Jito)  │
└─────────────┘     └──────────────┘     └─────────────┘     └──────────┘
       │                                                           │
       │                    ┌──────────────┐                       │
       └───────────────────▶│  MEV Shield  │◀──────────────────────┘
                            │  (analysis)  │
                            └──────────────┘
```

**Core modules:**

| Module | Path | Status |
|--------|------|--------|
| Intent Engine | `src/core/intent-engine.ts` | Stable |
| Privacy Layer | `src/core/privacy-layer.ts` | Stable |
| Relay Network | `src/core/relay.ts` | Stable |
| MEV Shield | `src/mev/shield.ts` | Stable |
| MEV Detector | `src/mev/detector.ts` | Beta |
| Slashing Engine | `src/consensus/slashing.ts` | Stable |
| Validator Registry | `src/consensus/validator.ts` | Stable |
| ZK Proofs | `src/zk/prover.ts` | WIP (flag-gated) |
| SDK Client | `src/sdk/client.ts` | Beta |

## Quick Start

```bash
npm install @vanta-protocol/core
```

```typescript
import { VantaClient } from "@vanta-protocol/core/sdk";

const client = new VantaClient({
  rpcUrl: "https://api.mainnet-beta.solana.com",
  relayUrls: ["https://relay-1.usevanta.xyz"],
  encryptionKey: myKey,
});

// Submit a private swap intent
const result = await client.submitIntent({
  type: "swap",
  inputMint: "So11111111111111111111111111111111111111112",
  outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  amount: 1_000_000_000, // 1 SOL
  slippage: 0.5,
});

console.log(result.mevAnalysis.sandwichRisk); // 0.0 — protected
console.log(result.intent.id);                // vnt_a1b2c3...
```

## Development

```bash
git clone https://github.com/vantaprivacy/vanta.git
cd vanta
npm install
npm test
```

### Commands

| Command | Description |
|---------|-------------|
| `npm test` | Run test suite |
| `npm run build` | Build for production |
| `npm run typecheck` | Type-check without emit |
| `npm run lint` | Lint with ESLint |
| `npm run bench` | Run benchmarks |

### Feature Flags

Experimental features are gated via `src/config/features.ts`:

```typescript
import { FEATURES } from "@vanta-protocol/core";

FEATURES.ZK_PROOFS = true;   // Enable ZK proof generation (Groth16)
FEATURES.MAINNET = false;    // Lock to devnet/testnet
```

## Security

- **Encryption**: AES-256-GCM with HKDF-derived per-intent keys
- **Key derivation**: HKDF-SHA256 with unique salt per intent
- **MEV protection**: Jito bundle submission with configurable tip
- **Slashing**: Byzantine fault detection with jail/tombstone lifecycle
- **Audit**: OtterSec engagement scheduled for Q3 2026

See [SECURITY.md](SECURITY.md) for vulnerability reporting.

## RFCs

Protocol changes go through the RFC process:

- [RFC-0001](spec/RFC-0001-intent-encryption.md) — Intent Encryption Scheme
- [RFC-0002](spec/RFC-0002-mev-shield.md) — MEV Shield Architecture
- [RFC-0003](spec/RFC-0003-zk-proofs.md) — ZK Proof Integration (Draft)

## License

Apache License 2.0 — see [LICENSE](LICENSE).

## Contributors

<a href="https://github.com/vantaprivacy/vanta/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=vantaprivacy/vanta" />
</a>
<!-- v0.5.0-beta -->
