"""
VANTA Python SDK

Private intent execution for Solana.

Usage:
    from vanta import VantaClient

    client = VantaClient(
        rpc_url="https://api.mainnet-beta.solana.com",
        relay_urls=["https://relay-1.usevanta.xyz"],
    )

    result = await client.submit_swap(
        input_mint="So11111111111111111111111111111111111111112",
        output_mint="EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        amount=1_000_000_000,
        slippage=0.5,
    )
"""

__version__ = "0.1.0"

# TODO: Implement Python bindings
# See TypeScript reference implementation in src/sdk/client.ts

__all__ = ["__version__"]
