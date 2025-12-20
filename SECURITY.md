# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.5.x   | :white_check_mark: |
| 0.4.x   | :white_check_mark: |
| < 0.4   | :x:                |

## Reporting a Vulnerability

**Do not open a public issue for security vulnerabilities.**

Please report security issues to: **security@usevanta.xyz**

Include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact assessment
- Suggested fix (if any)

## Response Timeline

- **Acknowledgment**: Within 24 hours
- **Initial assessment**: Within 72 hours
- **Fix & disclosure**: Within 14 days for critical issues

## Scope

The following are in scope:
- Intent encryption/decryption logic (`src/core/privacy-layer.ts`)
- Key derivation and cryptographic primitives (`src/utils/crypto.ts`)
- MEV protection bypass vectors (`src/mev/`)
- Slashing logic correctness (`src/consensus/slashing.ts`)
- ZK proof verification (when enabled)
- Relay routing privacy leaks (`src/core/relay.ts`)

## Bug Bounty

We are working on a formal bug bounty program. In the meantime, confirmed critical vulnerabilities will be rewarded at our discretion.

## Audit Status

| Auditor | Scope | Status | Report |
|---------|-------|--------|--------|
| OtterSec | Core + MEV | Scheduled Q3 2026 | Pending |
| Internal | Slashing engine | Complete | [Internal doc](docs/slashing-review.md) |
