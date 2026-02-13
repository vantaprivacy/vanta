# MEV Protection

## Overview

VANTA's MEV Shield analyzes transactions before submission and routes high-risk ones through Jito's block engine to prevent sandwich attacks.

## Risk Analysis

The `analyzeMEVRisk()` function computes a sandwich risk score (0.0 to 1.0):

```
risk = pairLiquidity * amountImpact * slotTiming
```

### Factors

| Factor | Weight | High Risk | Low Risk |
|--------|--------|-----------|----------|
| Pair liquidity | 40% | SOL/USDC, SOL/USDT | Unknown pairs |
| Amount impact | 35% | >$10K equivalent | <$100 |
| Slot timing | 25% | Beginning of slot | End of slot |

## Routing Decision

Based on the risk score:

- **risk > 0.5**: Route through Jito bundle (recommended)
- **risk 0.3–0.5**: Optional Jito, warn user
- **risk < 0.3**: Standard RPC submission

## Jito Integration

High-risk intents are bundled and submitted via Jito's block engine:

- **Tip range**: 1,000–100,000 lamports (configurable)
- **Max bundle size**: 5 transactions
- **Regions**: amsterdam, frankfurt, ny, tokyo

## Sandwich Detection

The `MEVDetector` module identifies sandwich patterns in historical data:

1. Three transactions in the same slot
2. All touching the same pool accounts
3. Pattern: buy → victim → sell

This is used for post-trade analysis and validator slashing evidence.

## Configuration

```typescript
const shield = new MEVShield({
  jitoTipRange: [5_000, 50_000],
  jitoRegion: "ny",
  riskThreshold: 0.5,
});
```
