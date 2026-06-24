import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import type { HistoryStore, PullStatus, CoverageMap, CoverageEntry } from "./types.js";

// ─── Paths ────────────────────────────────────────────────────────────────────
// /data is a Railway persistent volume. Falls back to /tmp for local dev.

const DATA_DIR    = existsSync("/data") ? "/data" : "/tmp";
const HISTORY_FILE = `${DATA_DIR}/whoop_history.json`;
const STATUS_FILE  = `${DATA_DIR}/whoop_pull_status.json`;

// Ensure directory exists (safety for local dev)
try { mkdirSync(DATA_DIR, { recursive: true }); } catch { /* already exists */ }

// ─── History ──────────────────────────────────────────────────────────────────

export function readHistory(): HistoryStore | null {
  if (!existsSync(HISTORY_FILE)) return null;
  try {
    return JSON.parse(readFileSync(HISTORY_FILE, "utf8")) as HistoryStore;
  } catch {
    return null;
  }
}

export function writeHistory(data: HistoryStore): void {
  writeFileSync(HISTORY_FILE, JSON.stringify(data), "utf8");
  console.log(
    `[store] History written: ${data.cycles.length} cycles, ` +
    `${data.recoveries.length} recoveries, ${data.sleeps.length} sleeps, ` +
    `${data.workouts.length} workouts`
  );
}

// ─── Coverage helpers ─────────────────────────────────────────────────────────

// Extract YYYY-MM-DD from a record using start or created_at field
function recordDate(r: Record<string, unknown>): string {
  const raw = (r["start"] ?? r["created_at"] ?? "") as string;
  return raw.split("T")[0];
}

// Compute coverage entry from an array of records
export function computeCoverage(records: Record<string, unknown>[]): CoverageEntry | null {
  const dates = records.map(recordDate).filter(Boolean).sort();
  if (dates.length === 0) return null;
  return {
    min:       dates[0],
    max:       dates[dates.length - 1],
    updatedAt: new Date().toISOString(),
  };
}

// Recovery records have no date field of their own — only created_at (when
// Whoop computed/last touched the score) and cycle_id (which physiological
// cycle it belongs to). created_at can lag far behind the actual cycle date
// if Whoop re-scores or migrates records internally, which silently breaks
// any date-range filtering or coverage tracking based on it. Resolve each
// recovery's effective date through its parent cycle's start date instead.
export function computeRecoveryCoverage(
  recoveries: Record<string, unknown>[],
  cycles: Record<string, unknown>[]
): CoverageEntry | null {
  const cycleStartById = new Map<number, string>();
  for (const c of cycles) {
    const id = c["id"] as number | undefined;
    const start = ((c["start"] as string | undefined) ?? "").split("T")[0];
    if (id != null && start) cycleStartById.set(id, start);
  }

  const dates = recoveries
    .map(r => cycleStartById.get(r["cycle_id"] as number))
    .filter((d): d is string => Boolean(d))
    .sort();

  if (dates.length === 0) return null;
  return {
    min:       dates[0],
    max:       dates[dates.length - 1],
    updatedAt: new Date().toISOString(),
  };
}

// Build a full CoverageMap from current history
export function buildCoverage(store: HistoryStore): CoverageMap {
  const now = new Date().toISOString();
  const empty = (): CoverageEntry => ({ min: "", max: "", updatedAt: now });

  return {
    cycles:     computeCoverage(store.cycles)     ?? empty(),
    recoveries: computeRecoveryCoverage(store.recoveries, store.cycles) ?? empty(),
    sleeps:     computeCoverage(store.sleeps)      ?? empty(),
    workouts:   computeCoverage(store.workouts)    ?? empty(),
  };
}

// ─── Pull Status ─────────────────────────────────────────────────────────────

export function readStatus(): PullStatus {
  if (!existsSync(STATUS_FILE)) return defaultStatus();
  try {
    return JSON.parse(readFileSync(STATUS_FILE, "utf8")) as PullStatus;
  } catch {
    return defaultStatus();
  }
}

export function writeStatus(status: PullStatus): void {
  writeFileSync(STATUS_FILE, JSON.stringify(status), "utf8");
}

function defaultStatus(): PullStatus {
  return {
    inProgress:     false,
    startedAt:      null,
    completedAt:    null,
    error:          null,
    mode:           "full",
    requestedStart: null,
    requestedEnd:   null,
    counts:  { cycles: 0, recoveries: 0, sleeps: 0, workouts: 0 },
    fetched: { cycles: 0, recoveries: 0, sleeps: 0, workouts: 0 },
  };
}
