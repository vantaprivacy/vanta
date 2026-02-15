# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0-beta.1] - 2026-05-25

### Added
- MEV sandwich attack detector (`src/mev/detector.ts`)
- Jito bundle submission with configurable tip range
- Validator registry with stake-weighted leader selection
- SDK client with automatic MEV risk analysis

### Changed
- Privacy layer now uses AES-256-GCM (was ChaCha20)
- Relay health checks run on 30s interval (was 60s)
- Intent IDs prefixed with `vnt_` for namespace clarity

### Fixed
- Race condition in concurrent intent submissions
- Memory leak in relay connection pool

## [0.4.0] - 2026-04-18

### Added
- Working slashing engine with double-sign and downtime detection
- Tombstone mechanism after max infractions
- Jail/unjail lifecycle with configurable duration
- Cooldown periods to prevent duplicate slashing

### Changed
- Slashing percentages aligned with Cosmos SDK defaults
- Event system for slashing notifications

## [0.3.0] - 2026-03-22

### Added
- ZK proof module (Groth16 backend via snarkjs, behind feature flag)
- Feature flag system (`FEATURES.ZK_PROOFS`, `FEATURES.MAINNET`)
- Privacy scoring for intents (relay diversity + encryption strength)

### Fixed
- Intent expiry not respecting TTL in edge cases

## [0.2.0] - 2026-02-15

### Added
- Privacy layer with AES-256-GCM encryption
- Relay network with health monitoring
- HKDF key derivation for intent-specific keys
- Intent engine with type validation

### Changed
- Migrated from raw crypto to structured PrivacyLayer class

## [0.1.0] - 2025-12-20

### Added
- Initial project scaffold
- Core intent types and interfaces
- Basic configuration system
- CI pipeline with GitHub Actions
- Apache 2.0 license
