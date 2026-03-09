import { SlashingEngine, DEFAULT_PARAMS } from "../src/consensus/slashing";

describe("SlashingEngine", () => {
  let engine: SlashingEngine;

  beforeEach(() => {
    engine = new SlashingEngine();
    engine.registerValidator("0xAlice", 1_000_000n);
    engine.registerValidator("0xBob", 500_000n);
    engine.setEpoch(1);
  });

  test("double sign slashes 5%", () => {
    const inf = engine.slash("0xAlice", "DOUBLE_SIGN", "ev1");
    expect(inf.amount).toBe(50_000n);
    expect(engine.getValidatorState("0xAlice")!.stake).toBe(950_000n);
  });

  test("validator is jailed after slash", () => {
    engine.slash("0xAlice", "DOUBLE_SIGN", "ev1");
    const state = engine.getValidatorState("0xAlice")!;
    expect(state.isJailed).toBe(true);
    expect(state.jailedUntil).toBe(1 + DEFAULT_PARAMS.jailDuration);
  });

  test("unjail after duration expires", () => {
    engine.slash("0xAlice", "DOUBLE_SIGN", "ev1");
    engine.setEpoch(1 + DEFAULT_PARAMS.jailDuration);
    expect(engine.getValidatorState("0xAlice")!.isJailed).toBe(false);
  });

  test("downtime auto-slash after threshold", () => {
    for (let i = 0; i < DEFAULT_PARAMS.downtimeThreshold - 1; i++) {
      expect(engine.recordMissedBlock("0xBob")).toBeNull();
    }
    const inf = engine.recordMissedBlock("0xBob");
    expect(inf).not.toBeNull();
    expect(inf!.type).toBe("DOWNTIME");
  });

  test("cooldown prevents same-type double slash", () => {
    engine.slash("0xAlice", "DOUBLE_SIGN", "ev1");
    expect(() => engine.slash("0xAlice", "DOUBLE_SIGN", "ev2")).toThrow(/Cooldown/);
  });

  test("tombstone after max infractions", () => {
    for (let i = 0; i < DEFAULT_PARAMS.maxInfractionsBeforeTombstone; i++) {
      engine.setEpoch(1 + i * (DEFAULT_PARAMS.cooldownEpochs + 1));
      engine.slash("0xAlice", "DOUBLE_SIGN", `ev${i}`);
    }
    expect(engine.isTombstoned("0xAlice")).toBe(true);
    expect(engine.getValidatorState("0xAlice")!.stake).toBe(0n);
  });

  test("getActiveValidators excludes jailed", () => {
    engine.slash("0xAlice", "DOUBLE_SIGN", "ev1");
    const active = engine.getActiveValidators();
    expect(active.length).toBe(1);
    expect(active[0].address).toBe("0xBob");
  });
});
