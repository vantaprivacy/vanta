# RFC-0003: ZK Proof Integration

- **Status**: Draft
- **Author**: vantaprivacy
- **Created**: 2026-03-10
- **Updated**: 2026-05-20

## Summary

Integrate zero-knowledge proofs to enable intent validity verification without revealing intent contents.

## Motivation

Currently, solvers must decrypt intents to verify their validity (sufficient balance, valid mints, etc.). ZK proofs would allow solvers to verify intent properties without seeing the plaintext, achieving stronger privacy guarantees.

## Proposed Design

### Circuit

A Groth16 circuit (via snarkjs/circom) that proves:

1. The encrypted intent is well-formed
2. The user's wallet has sufficient balance for the stated amount
3. The input/output mints are valid SPL tokens
4. The slippage parameter is within acceptable bounds

### Proof Flow

```
User                          Solver
  │                              │
  ├── intent + proof ──────────▶ │
  │                              ├── verify(proof, public_inputs)
  │                              │   ✓ valid intent without seeing plaintext
  │                              ├── execute transaction
  │   ◀── confirmation ─────────┤
```

### Public Inputs

- Commitment to the intent (Poseidon hash)
- Wallet balance Merkle root
- Mint registry root

### Performance Budget

- Proof generation: <2s on consumer hardware (target)
- Proof verification: <10ms
- Proof size: ~200 bytes (Groth16)

## Current Status

**WIP** — The Groth16 backend is implemented but the circuit is not yet written. The prover module (`src/zk/prover.ts`) is behind the `FEATURES.ZK_PROOFS` flag and returns a placeholder error.

### Milestones

- [x] Prover abstraction and factory pattern
- [x] Feature flag gating
- [ ] Circom circuit for intent validity
- [ ] Trusted setup ceremony
- [ ] Benchmark against performance budget
- [ ] PLONK backend as alternative (no trusted setup)

## Alternatives Considered

1. **PLONK**: No trusted setup, but larger proofs (~500 bytes) and slower verification. Planned as a future backend option.
2. **STARKs**: Quantum-resistant but proof sizes are 10-100KB, too large for on-chain verification.
3. **Bulletproofs**: Good for range proofs but not general-purpose computation.

## Security Considerations

- Trusted setup must be performed as a multi-party ceremony
- Circuit must be formally verified before mainnet deployment
- Soundness depends on the discrete log assumption (Groth16)
