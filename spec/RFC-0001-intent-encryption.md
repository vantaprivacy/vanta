# RFC-0001: Intent Encryption Scheme

- **Status**: Accepted
- **Author**: vantaprivacy
- **Created**: 2025-12-28
- **Updated**: 2026-02-10

## Summary

Define the encryption scheme for VANTA intents, including key derivation, cipher selection, and payload format.

## Motivation

Raw transaction data in Solana's mempool is visible to all validators and searchers. This enables MEV extraction through sandwich attacks, frontrunning, and backrunning. VANTA intents must be encrypted before leaving the client to prevent information leakage.

## Design

### Key Hierarchy

```
Master Key (256-bit, user-provided)
    │
    ├── HKDF(master, salt_1, "vanta-intent") → Intent Key 1
    ├── HKDF(master, salt_2, "vanta-intent") → Intent Key 2
    └── ...
```

### Cipher

AES-256-GCM with:
- 12-byte random nonce (generated per encryption)
- 16-byte authentication tag
- No additional authenticated data (AAD) in v1

### Payload Format

```
[1 byte version][16 byte salt][12 byte nonce][N byte ciphertext][16 byte tag]
```

Version byte is `0x01` for the initial scheme.

## Alternatives Considered

1. **ChaCha20-Poly1305**: Good performance without AES-NI, but AES-256-GCM has broader hardware support on server-side relay nodes.
2. **NaCl secretbox**: Simpler API but less control over nonce generation strategy.
3. **Hybrid encryption (ECIES)**: Unnecessary complexity for symmetric intent encryption where both sides share a key.

## Security Considerations

- Nonce reuse with the same key breaks GCM security. Per-intent key derivation with unique salts makes nonce reuse effectively impossible.
- The master key must be stored securely by the client. VANTA does not manage key storage.
- Ciphertext length reveals plaintext length. Intent types have variable sizes, which may leak the intent type. Padding to fixed sizes is deferred to a future RFC.

## References

- NIST SP 800-38D (GCM specification)
- RFC 5869 (HKDF)
- Solana transaction format specification
