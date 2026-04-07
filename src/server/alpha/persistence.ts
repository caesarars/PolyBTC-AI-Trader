import fs from "fs";
import { randomUUID } from "crypto";
import type { DecisionLogEntry } from "./types.js";

export function createDecisionLogEntry(
  payload: Omit<DecisionLogEntry, "id" | "ts"> & { id?: string; ts?: string }
): DecisionLogEntry {
  return {
    ...payload,
    id: payload.id || randomUUID(),
    ts: payload.ts || new Date().toISOString(),
  };
}

export function appendDecisionLog(filePath: string, entry: DecisionLogEntry): void {
  fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, "utf8");
}

export function loadDecisionLog(filePath: string): DecisionLogEntry[] {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as DecisionLogEntry);
}

export function filterDecisionLogByDays(entries: DecisionLogEntry[], days?: number): DecisionLogEntry[] {
  if (!Number.isFinite(days) || !days || days <= 0) return entries;
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  return entries.filter((entry) => {
    const ts = new Date(entry.ts).getTime();
    return Number.isFinite(ts) && ts >= cutoffMs;
  });
}
