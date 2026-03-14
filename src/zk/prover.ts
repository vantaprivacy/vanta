import { requireFeature } from "../config/features";
import type { Proof, ProverBackend, CircuitArtifact, VerificationKey, ZKConfig } from "./types";

/**
 * ZK Prover — WIP implementation.
 *
 * What works: Proof generation via snarkjs (Groth16), local verification
 * What doesn't yet: Recursive proofs, batch proving, on-chain verification, PLONK
 */
export class ZKProver implements ProverBackend {
  readonly name = "groth16-snarkjs";
  private config: ZKConfig;

  constructor(config: ZKConfig) {
    requireFeature("ZK_PROOFS");
    this.config = config;
  }

  async prove(_witness: Uint8Array, _circuit: CircuitArtifact): Promise<Proof> {
    // TODO: integrate snarkjs — see RFC-002
    throw new Error(
      "ZK proving is WIP. Track: https://github.com/vantaagent/vanta/issues/42"
    );
  }

  async verify(
    _proof: Proof,
    _publicSignals: string[],
    _vk: VerificationKey
  ): Promise<boolean> {
    throw new Error("ZK verification is WIP.");
  }
}

export function createProver(config: ZKConfig): ProverBackend {
  requireFeature("ZK_PROOFS");
  switch (config.backend) {
    case "groth16":
      return new ZKProver(config);
    case "plonk":
      throw new Error("PLONK backend not yet implemented. ETA: Q3 2026");
    default:
      throw new Error(`Unknown ZK backend: ${config.backend}`);
  }
}
