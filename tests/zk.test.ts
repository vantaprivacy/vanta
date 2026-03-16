import { createProver } from "../src/zk/prover";
import { FEATURES } from "../src/config/features";

describe("ZK Module", () => {
  afterEach(() => { FEATURES.ZK_PROOFS = false; });

  test("throws when feature flag is off", () => {
    FEATURES.ZK_PROOFS = false;
    expect(() => createProver({ backend: "groth16", circuitsDir: "./circuits" }))
      .toThrow(/not enabled/);
  });

  test("groth16 prover instantiates when flag on", () => {
    FEATURES.ZK_PROOFS = true;
    const prover = createProver({ backend: "groth16", circuitsDir: "./circuits" });
    expect(prover.name).toBe("groth16-snarkjs");
  });

  test("prove() throws WIP error", async () => {
    FEATURES.ZK_PROOFS = true;
    const prover = createProver({ backend: "groth16", circuitsDir: "./circuits" });
    await expect(prover.prove(new Uint8Array(), {} as any)).rejects.toThrow(/WIP/);
  });

  test("plonk not yet available", () => {
    FEATURES.ZK_PROOFS = true;
    expect(() => createProver({ backend: "plonk", circuitsDir: "./circuits" }))
      .toThrow(/not yet implemented/);
  });
});
