# RFC-0002: MEV Shield Architecture

- **Status**: Accepted
- **Author**: vantaagent
- **Created**: 2026-01-15
- **Updated**: 2026-04-08

## Summary

Define the MEV risk analysis pipeline and Jito integration for protecting VANTA intents from sandwich attacks.

## Motivation

Even with encrypted intents, the final execution transaction is visible on-chain. Sophisticated MEV searchers can still extract value if the transaction hits the standard RPC path. Routing high-risk transactions through Jito's block engine provides atomic inclusion guarantees that prevent sandwich insertion.

## Design

### Risk Scoring

```
sandwichRisk = w_pair * pairScore + w_amount * amountScore + w_timing * timingScore
```

Where:
- `pairScore` is 1.0 for top-10 Solana pairs (SOL/USDC, SOL/USDT, etc.), 0.1 for unknown pairs
- `amountScore` scales logarithmically from 0.0 ($0) to 1.0 ($100K+)
- `timingScore` is based on slot position (higher at slot start)

Weights: `w_pair=0.4, w_amount=0.35, w_timing=0.25`

### Routing Decision Tree

```
if sandwichRisk > 0.5:
    route = "jito"
    tip = scale(risk, [5000, 100000])  # higher risk → higher tip
elif sandwichRisk > 0.3:
    route = "jito"  # recommended but user can override
    tip = 5000      # minimum tip
else:
    route = "rpc"   # standard submission
```

### Jito Bundle Format

Bundles contain 1–5 transactions submitted atomically. VANTA wraps the user's transaction as the sole bundle entry (or includes a tip transfer as a second entry).

## Trade-offs

- **Cost**: Jito tips add 0.000005–0.0001 SOL per transaction
- **Latency**: Bundle submission adds ~200ms vs direct RPC
- **Privacy**: Jito validators see the raw transaction; this is acceptable because the bundle guarantees prevent sandwich insertion

## Future Work

- Multi-transaction bundles for complex DeFi strategies
- Dynamic tip estimation based on recent Jito auction data
- Fallback to standard RPC if Jito endpoint is unreachable
