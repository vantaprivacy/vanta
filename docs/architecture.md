# Architecture

## Overview

VANTA is structured as a layered privacy protocol for Solana transaction execution:

```
┌─────────────────────────────────────────────┐
│                 SDK Client                    │
├─────────────────────────────────────────────┤
│              Intent Engine                    │
│  (create, validate, expire, batch)           │
├─────────────────────────────────────────────┤
│            Privacy Layer                      │
│  (AES-256-GCM, HKDF, per-intent keys)       │
├──────────────────┬──────────────────────────┤
│   Relay Network  │      MEV Shield           │
│  (k-of-n routing)│  (risk analysis, Jito)    │
├──────────────────┴──────────────────────────┤
│           Consensus / Slashing               │
│  (validator registry, fault detection)       │
├─────────────────────────────────────────────┤
│          ZK Proofs (experimental)             │
│  (Groth16 via snarkjs, feature-flagged)      │
└─────────────────────────────────────────────┘
```

## Module Dependency Graph

```
sdk/client ──▶ core/intent-engine ──▶ core/privacy-layer ──▶ utils/crypto
                    │                        │
                    ▼                        ▼
               mev/shield              core/relay
                    │
                    ▼
              mev/detector
```

The consensus layer (`consensus/`) operates independently and is used by relay operators, not end users.

## Key Design Decisions

### 1. Per-Intent Key Derivation

Each intent gets a unique encryption key derived via HKDF from the master key and a random salt. This ensures that compromising one intent's ciphertext reveals nothing about others.

### 2. Relay-First Architecture

Intents are always routed through at least one relay node before reaching a solver. This breaks the direct link between user IP and transaction. The privacy score increases with relay diversity.

### 3. MEV Analysis Before Submission

The SDK analyzes MEV risk before choosing a submission path. High-risk intents (large swaps on liquid pairs) are automatically routed through Jito bundles. Low-risk intents use standard RPC.

### 4. Feature-Flagged Experimentation

All experimental modules (ZK proofs, mainnet mode) are behind runtime feature flags. This allows safe iteration without risking production stability. See `src/config/features.ts`.

## Threat Model

| Threat | Mitigation | Status |
|--------|-----------|--------|
| Mempool snooping | Intent encryption | Implemented |
| Sandwich attacks | Jito bundle submission | Implemented |
| Relay collusion | k-of-n threshold routing | Planned |
| Validator misbehavior | Slashing engine | Implemented |
| Proof forgery | ZK verification | WIP |
// expanded threat model
