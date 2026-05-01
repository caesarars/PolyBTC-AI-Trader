import { getBotProfiles, updateBotAccuracy, BotProfile } from "./bot-personality";
import { askDeepSeek, batchPredict, MarketContext, DeepSeekPrediction } from "./deepseek";

// In-memory storage for predictions (current window)
interface WindowPrediction {
  windowStart: number;
  botId: number;
  botName: string;
  direction: "UP" | "DOWN" | "NEUTRAL";
  confidence: number;
  reasoning: string;
  timestamp: number;
}

interface WindowResult {
  windowStart: number;
  actual: "UP" | "DOWN";
  resolvedAt: number;
}

const predictionsMap = new Map<number, WindowPrediction[]>(); // windowStart -> predictions
const resultsMap = new Map<number, WindowResult>(); // windowStart -> result
let swarmEnabled = process.env.SWARM_ENABLED === "true";
const SWARM_CONCURRENCY = Number(process.env.SWARM_CONCURRENCY || 5);

export function getSwarmEnabled(): boolean {
  return swarmEnabled;
}

export function setSwarmEnabled(enabled: boolean): void {
  swarmEnabled = enabled;
}

export interface SwarmEnsemble {
  windowStart: number;
  consensusDirection: "UP" | "DOWN" | "NEUTRAL";
  consensusConfidence: number;
  upVotes: number;
  downVotes: number;
  neutralVotes: number;
  upConfidence: number;
  downConfidence: number;
  weightedConfidence: number;
  avgConfidence: number;
  topBots: { id: number; name: string; confidence: number; direction: string }[];
}



export async function runSwarmPrediction(
  windowStart: number,
  context: MarketContext
): Promise<{ ensemble: SwarmEnsemble; predictions: number }> {
  const bots = getBotProfiles();
  const botInputs = bots.map((b) => ({
    id: b.id,
    personality: b.description,
    temperature: b.temperature,
  }));

  const startTime = Date.now();
  const results = await batchPredict(botInputs, context, SWARM_CONCURRENCY);
  const elapsed = Date.now() - startTime;

  const predictions: WindowPrediction[] = [];
  for (const [botId, pred] of results) {
    const bot = bots.find((b) => b.id === botId);
    if (!bot) continue;
    predictions.push({
      windowStart,
      botId,
      botName: bot.name,
      direction: pred.direction,
      confidence: pred.confidence,
      reasoning: pred.reasoning,
      timestamp: Date.now(),
    });
  }

  predictionsMap.set(windowStart, predictions);

  const ensemble = computeEnsemble(windowStart, predictions);

  console.log(`[Swarm] Window ${windowStart}: ${predictions.length}/${bots.length} bots responded in ${elapsed}ms | Consensus: ${ensemble.consensusDirection} ${ensemble.consensusConfidence}%`);

  return { ensemble, predictions: predictions.length };
}

function computeEnsemble(windowStart: number, predictions: WindowPrediction[]): SwarmEnsemble {
  const upVotes = predictions.filter((p) => p.direction === "UP");
  const downVotes = predictions.filter((p) => p.direction === "DOWN");
  const neutralVotes = predictions.filter((p) => p.direction === "NEUTRAL");

  const upWeight = upVotes.reduce((s, p) => s + p.confidence, 0);
  const downWeight = downVotes.reduce((s, p) => s + p.confidence, 0);
  const neutralWeight = neutralVotes.reduce((s, p) => s + p.confidence, 0);

  let consensusDirection: "UP" | "DOWN" | "NEUTRAL" = "NEUTRAL";
  let consensusConfidence = 0;

  if (upWeight > downWeight && upWeight > neutralWeight) {
    consensusDirection = "UP";
    consensusConfidence = Math.round(upWeight / Math.max(upVotes.length, 1));
  } else if (downWeight > upWeight && downWeight > neutralWeight) {
    consensusDirection = "DOWN";
    consensusConfidence = Math.round(downWeight / Math.max(downVotes.length, 1));
  } else {
    consensusDirection = "NEUTRAL";
    consensusConfidence = Math.round(neutralWeight / Math.max(neutralVotes.length, 1));
  }

  const totalWeight = upWeight + downWeight + neutralWeight;
  const weightedConfidence = totalWeight > 0 ? Math.round(totalWeight / predictions.length) : 50;
  const avgConfidence = predictions.length > 0
    ? Math.round(predictions.reduce((s, p) => s + p.confidence, 0) / predictions.length)
    : 50;

  // Top 5 bots by confidence
  const sorted = [...predictions].sort((a, b) => b.confidence - a.confidence).slice(0, 5);
  const topBots = sorted.map((p) => ({
    id: p.botId,
    name: p.botName,
    confidence: p.confidence,
    direction: p.direction,
  }));

  return {
    windowStart,
    consensusDirection,
    consensusConfidence,
    upVotes: upVotes.length,
    downVotes: downVotes.length,
    neutralVotes: neutralVotes.length,
    upConfidence: Math.round(upWeight / Math.max(upVotes.length, 1)) || 0,
    downConfidence: Math.round(downWeight / Math.max(downVotes.length, 1)) || 0,
    weightedConfidence,
    avgConfidence,
    topBots,
  };
}

export async function resolveSwarmWindow(
  windowStart: number,
  actualDirection: "UP" | "DOWN"
): Promise<void> {
  const predictions = predictionsMap.get(windowStart);
  if (!predictions || predictions.length === 0) {
    console.log(`[Swarm] No predictions to resolve for window ${windowStart}`);
    return;
  }

  resultsMap.set(windowStart, {
    windowStart,
    actual: actualDirection,
    resolvedAt: Date.now(),
  });

  let correctCount = 0;
  for (const pred of predictions) {
    const correct = pred.direction === actualDirection;
    if (correct) correctCount++;
    updateBotAccuracy(pred.botId, correct);
  }

  console.log(`[Swarm] Window ${windowStart} resolved: ${actualDirection} | ${correctCount}/${predictions.length} bots correct`);
}

export function getPredictionsForWindow(windowStart: number): WindowPrediction[] {
  return predictionsMap.get(windowStart) || [];
}

export function getResultForWindow(windowStart: number): WindowResult | null {
  return resultsMap.get(windowStart) || null;
}

export function getAllEnsembles(): SwarmEnsemble[] {
  const ensembles: SwarmEnsemble[] = [];
  for (const [windowStart, predictions] of predictionsMap) {
    const result = resultsMap.get(windowStart);
    const ensemble = computeEnsemble(windowStart, predictions);
    // Attach result if available
    (ensemble as any).actual = result?.actual || null;
    (ensemble as any).correct = result ? ensemble.consensusDirection === result.actual : null;
    ensembles.push(ensemble);
  }
  return ensembles.sort((a, b) => b.windowStart - a.windowStart);
}

export function getLeaderboard(): BotProfile[] {
  const profiles = getBotProfiles();
  return [...profiles].sort((a, b) => b.accuracy - a.accuracy);
}

export function getBotDetail(botId: number): {
  profile: BotProfile | null;
  predictions: WindowPrediction[];
} {
  const profile = getBotProfiles().find((b) => b.id === botId) || null;
  const predictions: WindowPrediction[] = [];
  for (const [, preds] of predictionsMap) {
    const p = preds.find((x) => x.botId === botId);
    if (p) predictions.push(p);
  }
  return { profile, predictions: predictions.reverse() };
}

export function clearSwarmMemory(): void {
  predictionsMap.clear();
  resultsMap.clear();
}

export function getSwarmStats(): {
  totalWindows: number;
  resolvedWindows: number;
  consensusAccuracy: number;
  avgBotsPerWindow: number;
} {
  const ensembles = getAllEnsembles();
  const resolved = ensembles.filter((e) => (e as any).correct !== null);
  const correctConsensus = resolved.filter((e) => (e as any).correct === true).length;

  return {
    totalWindows: ensembles.length,
    resolvedWindows: resolved.length,
    consensusAccuracy: resolved.length > 0 ? parseFloat(((correctConsensus / resolved.length) * 100).toFixed(1)) : 0,
    avgBotsPerWindow: ensembles.length > 0
      ? parseFloat((ensembles.reduce((s, e) => s + e.upVotes + e.downVotes + e.neutralVotes, 0) / ensembles.length).toFixed(1))
      : 0,
  };
}
