// ── Signal policy filter — keep / kill rules derived from Phase 1 measurement ──
// These rules encode the per-signal verdicts produced by the Phase 1 honest
// measurement (POST /api/measurement/phase1) and applied at runtime BEFORE the
// calibrated EV gate. They are deliberately conservative: a signal that the
// measurement flags as KILL is hard-skipped unless its env override disables
// the rule. As more data accumulates and verdicts shift, the constants here
// should be revisited — do not bake rules in that are no longer supported by
// the data.

export interface PolicyInput {
  direction: "UP" | "DOWN";
  emaCross?: string;
  imbalanceSignal?: string;
  rsi?: number;
  divergenceStrength?: string;
}

export interface PolicyDecision {
  block: boolean;
  reasons: string[];
}

interface PolicyConfig {
  blockBearishEma: boolean;
  blockSellPressureImbalance: boolean;
  // The pressure filter in server.ts already blocks direction × pressure
  // opposition. This flag adds the *unconditional* SELL_PRESSURE skip on top,
  // because the data showed SELL_PRESSURE losing across directions.
}

function readConfig(): PolicyConfig {
  return {
    blockBearishEma: process.env.POLICY_BLOCK_BEARISH_EMA !== "false",
    blockSellPressureImbalance: process.env.POLICY_BLOCK_SELL_PRESSURE !== "false",
  };
}

export function evaluatePolicy(input: PolicyInput): PolicyDecision {
  const cfg = readConfig();
  const reasons: string[] = [];

  // KILL: BEARISH EMA cross (Phase 1 measurement: 17% WR, n=6 — strong KILL
  // verdict on the limited sample we have). Override with POLICY_BLOCK_BEARISH_EMA=false.
  if (cfg.blockBearishEma && input.emaCross === "BEARISH") {
    reasons.push("emaCross=BEARISH (Phase 1 verdict: KILL — 17% WR)");
  }

  // KILL: SELL_PRESSURE imbalance regardless of trade direction
  // (Phase 1 measurement: 20% WR, n=5). The existing direction-aware pressure
  // filter handles UP × SELL_PRESSURE, but this rule also kills DOWN × SELL.
  if (cfg.blockSellPressureImbalance && input.imbalanceSignal === "SELL_PRESSURE") {
    reasons.push("imbalanceSignal=SELL_PRESSURE (Phase 1 verdict: KILL — 20% WR)");
  }

  return { block: reasons.length > 0, reasons };
}

export interface PolicyStatus {
  blockBearishEma: boolean;
  blockSellPressureImbalance: boolean;
}

export function getPolicyStatus(): PolicyStatus {
  const cfg = readConfig();
  return {
    blockBearishEma: cfg.blockBearishEma,
    blockSellPressureImbalance: cfg.blockSellPressureImbalance,
  };
}
