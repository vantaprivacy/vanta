/**
 * ZK Proof System interfaces.
 * STATUS: WIP — interfaces stable, implementations partial.
 * See docs/zk-roadmap.md
 */

export interface Proof {
  protocol: "groth16" | "plonk" | "stark";
  pi_a: [string, string];
  pi_b: [[string, string], [string, string]];
  pi_c: [string, string];
  publicSignals: string[];
}

export interface VerificationKey {
  protocol: string;
  curve: string;
  nPublic: number;
  vk_alpha_1: [string, string];
  vk_beta_2: [[string, string], [string, string]];
  vk_gamma_2: [[string, string], [string, string]];
  vk_delta_2: [[string, string], [string, string]];
  IC: [string, string][];
}

export interface ProverBackend {
  name: string;
  prove(witness: Uint8Array, circuit: CircuitArtifact): Promise<Proof>;
  verify(proof: Proof, publicSignals: string[], vk: VerificationKey): Promise<boolean>;
}

export interface CircuitArtifact {
  wasmPath: string;
  zkeyPath: string;
  vkeyPath: string;
}

export interface ZKConfig {
  backend: "groth16" | "plonk";
  circuitsDir: string;
  trustedSetupPath?: string;
  threads?: number;
}
