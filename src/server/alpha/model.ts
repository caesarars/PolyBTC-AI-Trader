import type { AlphaModelSnapshot, AlphaScoringInput, ExecutedTradeSample } from "./types.js";

export const ALPHA_MODEL_VERSION = "btc-alpha-v1";

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number, digits = 4): number {
  return Number(value.toFixed(digits));
}

function getBtcDirectionalBaseProbability(direction: "UP" | "DOWN", confidence: number): number {
  if (direction === "UP") {
    if (confidence >= 85) return 0.72;
    if (confidence >= 80) return 0.58;
    if (confidence >= 75) return 0.32;
    return 0.26;
  }

  if (confidence >= 85) return 0.62;
  if (confidence >= 80) return 0.52;
  if (confidence >= 75) return 0.44;
  return 0.24;
}

function getDirectionalAlignmentScore(direction: "UP" | "DOWN", signalScore?: number | null): number {
  if (!Number.isFinite(signalScore)) return 0;
  const score = Number(signalScore);
  if (direction === "UP") return score;
  return score * -1;
}

function getRsiAdjustment(direction: "UP" | "DOWN", rsi?: number | null): { delta: number; reason?: string } {
  if (!Number.isFinite(rsi)) return { delta: 0 };
  const normalizedRsi = Number(rsi);

  if (direction === "UP") {
    if (normalizedRsi < 42) return { delta: 0.03, reason: `RSI ${normalizedRsi.toFixed(0)} memberi ruang naik` };
    if (normalizedRsi > 62) return { delta: -0.04, reason: `RSI ${normalizedRsi.toFixed(0)} terlalu panas untuk UP` };
  }

  if (direction === "DOWN") {
    if (normalizedRsi > 58) return { delta: 0.03, reason: `RSI ${normalizedRsi.toFixed(0)} mendukung DOWN` };
    if (normalizedRsi < 10) return { delta: -0.01, reason: `RSI ${normalizedRsi.toFixed(0)} terlalu oversold untuk DOWN` };
  }

  return { delta: 0 };
}

function getImbalanceAdjustment(direction: "UP" | "DOWN", signal?: string | null): { delta: number; reason?: string } {
  const normalized = String(signal || "").toUpperCase();
  if (!normalized) return { delta: 0 };

  if (direction === "UP" && normalized === "BUY_PRESSURE") {
    return { delta: 0.03, reason: "Order book BUY_PRESSURE searah" };
  }
  if (direction === "DOWN" && normalized === "SELL_PRESSURE") {
    return { delta: 0.02, reason: "Order book SELL_PRESSURE searah" };
  }
  if (direction === "UP" && normalized === "SELL_PRESSURE") {
    return { delta: -0.05, reason: "Order book SELL_PRESSURE melawan UP" };
  }
  if (direction === "DOWN" && normalized === "BUY_PRESSURE") {
    return { delta: -0.02, reason: "Order book BUY_PRESSURE melawan DOWN" };
  }

  return { delta: normalized === "NEUTRAL" ? -0.01 : 0 };
}

function getDivergenceAdjustment(
  direction: "UP" | "DOWN",
  divergenceDirection?: string | null,
  divergenceStrength?: string | null
): { delta: number; reason?: string } {
  const normalizedDirection = String(divergenceDirection || "").toUpperCase();
  const normalizedStrength = String(divergenceStrength || "").toUpperCase();
  if (!normalizedDirection || normalizedDirection === "NEUTRAL" || normalizedStrength === "NONE") {
    return { delta: 0 };
  }

  const aligned = normalizedDirection === direction;
  const strong = normalizedStrength === "STRONG";
  const moderate = normalizedStrength === "MODERATE";

  if (aligned && strong) return { delta: 0.05, reason: "Strong divergence searah" };
  if (aligned && moderate) return { delta: 0.03, reason: "Moderate divergence searah" };
  if (!aligned && strong) return { delta: -0.08, reason: "Strong divergence conflict" };
  if (!aligned && moderate) return { delta: -0.04, reason: "Moderate divergence conflict" };
  return { delta: 0 };
}

function getFastLoopAdjustment(
  direction: "UP" | "DOWN",
  fastLoopDirection?: string | null,
  fastLoopStrength?: string | null,
  fastLoopVw?: number | null
): { delta: number; reason?: string } {
  const normalizedDirection = String(fastLoopDirection || "").toUpperCase();
  const normalizedStrength = String(fastLoopStrength || "").toUpperCase();
  const vw = Number(fastLoopVw || 0);
  if (!normalizedDirection || normalizedDirection === "NEUTRAL" || normalizedStrength === "WEAK") {
    return { delta: 0 };
  }

  const aligned = normalizedDirection === direction;
  if (aligned && normalizedStrength === "STRONG") {
    return { delta: 0.04 + clamp(Math.abs(vw) * 6, 0, 0.02), reason: "FastLoop strong searah" };
  }
  if (aligned && normalizedStrength === "MODERATE") {
    return { delta: 0.02, reason: "FastLoop moderate searah" };
  }
  if (!aligned && normalizedStrength === "STRONG") {
    return { delta: -0.05, reason: "FastLoop strong conflict" };
  }
  if (!aligned && normalizedStrength === "MODERATE") {
    return { delta: -0.025, reason: "FastLoop moderate conflict" };
  }
  return { delta: 0 };
}

export function scoreBtcAlpha(input: AlphaScoringInput): AlphaModelSnapshot {
  if (input.asset !== "BTC" || input.direction === "NONE") {
    return {
      version: ALPHA_MODEL_VERSION,
      probability: null,
      edge: null,
      score: null,
      conviction: null,
      agreement: "NEUTRAL",
      shouldTrade: false,
      reasons: ["Model hanya aktif untuk setup BTC berarah"],
    };
  }

  let probability = getBtcDirectionalBaseProbability(input.direction, input.confidence);
  let score = 0;
  const reasons: string[] = [];
  let alignedSignals = 0;
  let conflictingSignals = 0;

  if (input.edge >= 0.28) {
    probability += 0.05;
    score += 1.2;
    reasons.push(`Edge ${(input.edge * 100).toFixed(1)}c sangat sehat`);
    alignedSignals += 1;
  } else if (input.edge >= 0.21) {
    probability += 0.025;
    score += 0.6;
    reasons.push(`Edge ${(input.edge * 100).toFixed(1)}c masih layak`);
    alignedSignals += 1;
  } else if (input.edge < 0.15) {
    probability -= 0.05;
    score -= 1.2;
    reasons.push(`Edge ${(input.edge * 100).toFixed(1)}c terlalu tipis`);
    conflictingSignals += 1;
  }

  if (input.entryPrice != null) {
    if (input.entryPrice < 0.49) {
      probability += 0.03;
      score += 0.8;
      reasons.push(`Entry ${(input.entryPrice * 100).toFixed(1)}c berada di zona murah`);
      alignedSignals += 1;
    }

    if (input.direction === "UP") {
      if (input.entryPrice < 0.48) {
        probability += 0.03;
        score += 0.6;
      } else if (input.entryPrice < 0.495) {
        probability -= 0.02;
        score -= 0.4;
      } else if (input.entryPrice < 0.505) {
        if (input.edge >= 0.29) {
          probability += 0.16;
          score += 1.8;
          reasons.push(`UP premium ${(input.entryPrice * 100).toFixed(1)}c hanya lolos karena edge ${(input.edge * 100).toFixed(1)}c`);
          alignedSignals += 1;
        } else {
          probability -= 0.08;
          score -= 1.4;
          reasons.push(`UP di ${(input.entryPrice * 100).toFixed(1)}c butuh edge >= 29.0c`);
          conflictingSignals += 1;
        }
      } else {
        probability -= 0.18;
        score -= 2.2;
        reasons.push(`UP ${(input.entryPrice * 100).toFixed(1)}c terlalu premium`);
        conflictingSignals += 1;
      }
    } else {
      if (input.entryPrice < 0.48) {
        probability += 0.02;
        score += 0.4;
      } else if (input.entryPrice <= 0.485) {
        probability -= 0.02;
        score -= 0.3;
      } else if (input.entryPrice <= 0.505) {
        probability -= 0.08;
        score -= 1.1;
        reasons.push(`DOWN ${(input.entryPrice * 100).toFixed(1)}c kurang menarik kecuali conviction tinggi`);
        conflictingSignals += 1;
      } else if (input.confidence >= 80 && input.edge >= 0.22) {
        probability -= 0.01;
        score -= 0.2;
        reasons.push(`DOWN premium masih dipertimbangkan karena confidence ${input.confidence}% dan edge ${(input.edge * 100).toFixed(1)}c`);
      } else {
        probability -= 0.12;
        score -= 1.6;
        reasons.push(`DOWN ${(input.entryPrice * 100).toFixed(1)}c terlalu premium`);
        conflictingSignals += 1;
      }
    }
  }

  const imbalance = getImbalanceAdjustment(input.direction, input.imbalanceSignal);
  probability += imbalance.delta;
  score += imbalance.delta * 20;
  if (imbalance.reason) {
    reasons.push(imbalance.reason);
    if (imbalance.delta > 0) alignedSignals += 1;
    if (imbalance.delta < 0) conflictingSignals += 1;
  }

  const divergence = getDivergenceAdjustment(input.direction, input.divergenceDirection, input.divergenceStrength);
  probability += divergence.delta;
  score += divergence.delta * 20;
  if (divergence.reason) {
    reasons.push(divergence.reason);
    if (divergence.delta > 0) alignedSignals += 1;
    if (divergence.delta < 0) conflictingSignals += 1;
  }

  const fastLoop = getFastLoopAdjustment(input.direction, input.fastLoopDirection, input.fastLoopStrength, input.fastLoopVw);
  probability += fastLoop.delta;
  score += fastLoop.delta * 20;
  if (fastLoop.reason) {
    reasons.push(fastLoop.reason);
    if (fastLoop.delta > 0) alignedSignals += 1;
    if (fastLoop.delta < 0) conflictingSignals += 1;
  }

  const directionalSignalScore = getDirectionalAlignmentScore(input.direction, input.signalScore);
  if (directionalSignalScore >= 2) {
    probability += 0.04;
    score += 0.9;
    reasons.push(`Signal score ${input.signalScore} mendukung ${input.direction}`);
    alignedSignals += 1;
  } else if (directionalSignalScore <= -1) {
    probability -= 0.05;
    score -= 1.0;
    reasons.push(`Signal score ${input.signalScore} menentang ${input.direction}`);
    conflictingSignals += 1;
  }

  const rsi = getRsiAdjustment(input.direction, input.rsi);
  probability += rsi.delta;
  score += rsi.delta * 20;
  if (rsi.reason) {
    reasons.push(rsi.reason);
    if (rsi.delta > 0) alignedSignals += 1;
    if (rsi.delta < 0) conflictingSignals += 1;
  }

  const normalizedEmaCross = String(input.emaCross || "").toUpperCase();
  if (
    (input.direction === "UP" && normalizedEmaCross === "BULLISH") ||
    (input.direction === "DOWN" && normalizedEmaCross === "BEARISH")
  ) {
    probability += 0.02;
    score += 0.5;
    reasons.push(`EMA ${normalizedEmaCross} searah`);
    alignedSignals += 1;
  } else if (
    (input.direction === "UP" && normalizedEmaCross === "BEARISH") ||
    (input.direction === "DOWN" && normalizedEmaCross === "BULLISH")
  ) {
    probability -= 0.03;
    score -= 0.6;
    reasons.push(`EMA ${normalizedEmaCross} conflict`);
    conflictingSignals += 1;
  }

  const elapsed = Number(input.windowElapsedSeconds ?? 0);
  if (elapsed > 0 && elapsed < 20) {
    probability -= 0.015;
    score -= 0.35;
    reasons.push(`Window masih terlalu awal (${elapsed}s)`);
    conflictingSignals += 1;
  } else if (elapsed > 180) {
    probability -= 0.025;
    score -= 0.5;
    reasons.push(`Entry terlambat (${elapsed}s)`);
    conflictingSignals += 1;
  } else if (elapsed >= 45 && elapsed <= 150) {
    probability += 0.01;
    score += 0.2;
  }

  const normalizedRisk = String(input.riskLevel || "").toUpperCase();
  if (normalizedRisk === "LOW") {
    probability += 0.015;
    score += 0.4;
  } else if (normalizedRisk === "HIGH") {
    probability -= 0.05;
    score -= 1.0;
    reasons.push("Risk level HIGH");
    conflictingSignals += 1;
  }

  probability = clamp(probability, 0.05, 0.95);
  const modelEdge = input.entryPrice != null ? round(probability - input.entryPrice) : null;

  let shouldTrade = Boolean(
    input.entryPrice != null &&
    input.confidence >= 75 &&
    probability >= 0.55 &&
    modelEdge != null &&
    modelEdge >= 0.08 &&
    normalizedRisk !== "HIGH"
  );

  if (input.direction === "UP" && input.entryPrice != null) {
    const buyPressure = String(input.imbalanceSignal || "").toUpperCase() === "BUY_PRESSURE";
    const directionalSignal = Number(input.signalScore ?? 0);
    if (input.entryPrice >= 0.505) {
      shouldTrade = shouldTrade && input.confidence >= 83 && input.edge >= 0.23 && buyPressure;
    } else if (input.entryPrice >= 0.495) {
      shouldTrade = shouldTrade && (input.edge >= 0.29 || input.confidence >= 83 || buyPressure);
    } else if (input.entryPrice >= 0.48) {
      shouldTrade = shouldTrade && (input.confidence >= 85 || buyPressure || directionalSignal >= 2);
    }
  }

  if (input.direction === "DOWN" && input.entryPrice != null) {
    const bearishEma = String(input.emaCross || "").toUpperCase() === "BEARISH";
    const bearishSignal = Number(input.signalScore ?? 0) <= -2;
    if (input.confidence < 77) {
      shouldTrade = false;
    }
    if (input.entryPrice > 0.485) {
      shouldTrade = shouldTrade && input.confidence >= 80 && input.edge >= 0.22;
    } else if (input.entryPrice >= 0.48) {
      shouldTrade = shouldTrade && (
        (input.confidence >= 81 && input.edge >= 0.22) ||
        (bearishSignal && bearishEma)
      );
    } else if (input.confidence < 80) {
      shouldTrade = shouldTrade && (bearishEma || bearishSignal);
    }
  }

  const conviction =
    probability >= 0.76 ? "HIGH" :
    probability >= 0.66 ? "MEDIUM" :
    "LOW";
  const agreement =
    alignedSignals === 0 && conflictingSignals === 0 ? "NEUTRAL" :
    conflictingSignals === 0 ? "ALIGNED" :
    alignedSignals === 0 ? "CONFLICT" :
    "MIXED";
  return {
    version: ALPHA_MODEL_VERSION,
    probability: round(probability),
    edge: modelEdge,
    score: round(score, 3),
    conviction,
    agreement,
    shouldTrade,
    reasons: reasons.slice(0, 6),
  };
}

export function scoreExecutedTradeSample(sample: ExecutedTradeSample): AlphaModelSnapshot {
  return scoreBtcAlpha({
    asset: "BTC",
    direction: sample.direction,
    confidence: sample.confidence,
    edge: sample.edge >= 1 ? Number((sample.edge / 100).toFixed(4)) : sample.edge,
    entryPrice: sample.entryPrice,
    imbalanceSignal: sample.imbalanceSignal,
    signalScore: sample.signalScore,
    rsi: sample.rsi,
    emaCross: sample.emaCross,
    divergenceDirection: sample.divergenceDirection,
    divergenceStrength: sample.divergenceStrength,
    windowElapsedSeconds: sample.windowElapsedSeconds,
    riskLevel: "MEDIUM",
  });
}
