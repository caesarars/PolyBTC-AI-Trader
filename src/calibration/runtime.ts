// ── Calibrator runtime — singleton state + disk persistence ────────────────────
// Owns the in-memory calibrator state and (de)serializes the model from
// `data/calibrator.json`. Loaded at startup; saved after each successful
// retrain. The state is consumed by server.ts to gate trades on a *real*
// probability instead of the heuristic confidence score.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  trainCalibrator,
  calibrateProbability,
  type CalibratorState,
  type LabeledTrade,
  type TradeFeatures,
  type TrainCalibratorOptions,
} from "./calibrator.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
// `src/calibration/` → project root → `data/`
const DATA_DIR   = path.resolve(__dirname, "..", "..", "data");
const MODEL_FILE = path.join(DATA_DIR, "calibrator.json");

let _state: CalibratorState = {
  model: null,
  ready: false,
  minTrades: 100,
  nSamples: 0,
  reason: "Not trained yet.",
  buckets: [],
  heuristicBrier: null,
};

export function getCalibratorState(): CalibratorState {
  return _state;
}

export function isCalibratorReady(): boolean {
  return _state.ready && _state.model !== null;
}

export function loadCalibrator(): CalibratorState | null {
  try {
    if (!fs.existsSync(MODEL_FILE)) return null;
    const raw = fs.readFileSync(MODEL_FILE, "utf8");
    const persisted = JSON.parse(raw) as CalibratorState;
    if (!persisted?.model || !Array.isArray(persisted.model.weights)) {
      console.warn(`[Calibrate] ${MODEL_FILE} present but malformed — ignoring.`);
      return null;
    }
    _state = {
      model: persisted.model,
      ready: true,
      minTrades: persisted.minTrades ?? 100,
      nSamples: persisted.nSamples ?? 0,
      reason: persisted.reason ?? "Loaded from disk.",
      buckets: persisted.buckets ?? [],
      heuristicBrier: persisted.heuristicBrier ?? null,
    };
    return _state;
  } catch (e: any) {
    console.warn(`[Calibrate] Failed to load model: ${e?.message ?? e}`);
    return null;
  }
}

export function saveCalibrator(): void {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(MODEL_FILE, JSON.stringify(_state, null, 2), "utf8");
  } catch (e: any) {
    console.error(`[Calibrate] Failed to save model: ${e?.message ?? e}`);
  }
}

export function clearCalibrator(): void {
  _state = {
    model: null,
    ready: false,
    minTrades: _state.minTrades,
    nSamples: 0,
    reason: "Cleared.",
    buckets: [],
    heuristicBrier: null,
  };
  try { fs.unlinkSync(MODEL_FILE); } catch {}
}

/** Retrain from the given labeled trades, replace in-memory state, persist. */
export function retrain(trades: LabeledTrade[], opts: TrainCalibratorOptions = {}): CalibratorState {
  _state = trainCalibrator(trades, opts);
  if (_state.ready) saveCalibrator();
  return _state;
}

/** Returns calibrated P(WIN) for the given trade features, or `null` if not ready. */
export function predictPWin(features: TradeFeatures): number | null {
  return calibrateProbability(_state, features);
}
