# Privacy Model

## Encryption Scheme

VANTA uses a layered encryption model:

1. **Master Key**: User-provided 256-bit key
2. **Salt**: 16 random bytes per intent
3. **Derived Key**: HKDF-SHA256(masterKey, salt, "vanta-intent") → 256-bit intent key
4. **Encryption**: AES-256-GCM(derivedKey, nonce, plaintext) → ciphertext + auth tag

### Why AES-256-GCM?

- Authenticated encryption (integrity + confidentiality)
- Hardware-accelerated on modern CPUs (AES-NI)
- Well-audited, NIST-approved
- 12-byte nonce is sufficient for per-intent usage (no nonce reuse risk)

## Privacy Score

Each intent receives a privacy score (0.0 to 1.0) based on:

| Factor | Weight | Description |
|--------|--------|-------------|
| Encryption strength | 40% | Key size, algorithm |
| Relay diversity | 35% | Number of distinct relay regions |
| Timing obfuscation | 15% | Random delay before relay hop |
| Metadata minimization | 10% | Stripped headers, no IP leak |

## Relay Routing

The relay network provides unlinkability between user identity and transaction:

```
User → Relay A (us-east) → Relay B (eu-west) → Solver
```

Minimum 1 relay hop. Privacy score increases with 2+ hops across distinct regions.

## Limitations

- **Not a mixer**: VANTA does not pool funds or break on-chain transaction graphs
- **Solver trust**: The final solver sees the decrypted intent (by design — it needs to execute)
- **Metadata leaks**: On-chain transaction size and timing can leak information
- **Key management**: Users are responsible for their master key security
