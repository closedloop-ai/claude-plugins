import { UsageState } from "../../codex-fleet-monitor/scripts/ratelimit.mjs";
import { codexHigh, freshReading } from "./dispatch-route.mjs";

const ACTIVE_LIMIT_STATES = new Set([UsageState.Limit, UsageState.SpendingCredits, UsageState.Stopped]);

function belowThreshold(text, moveAt) {
  if (codexHigh(text) === null) return false;
  const [, , band, state] = text.split(/\s+/);
  if (ACTIVE_LIMIT_STATES.has(state)) return false;
  const under = /^under(\d+)%$/.exec(band);
  if (under) return Number(under[1]) <= moveAt;
  const high = /^HIGH\((\d+)%\)$/.exec(band);
  // A high band reports only its lower decade boundary. Require the entire band to be below the move threshold.
  return Boolean(high && Number(high[1]) + 10 <= moveAt);
}

/** Flag an all-Claude live fleet only when a fresh Codex reading proves room below the move threshold. */
export function runtimeMixLine(writers, readings, { now, staleSeconds, moveAt = 80 }) {
  const live = Object.values(writers).filter((row) => !row.retiredAt && row.status?.trim().toUpperCase() !== "DONE");
  if (!live.length || live.some(({ runtime }) => runtime !== "claude") || !Number.isFinite(moveAt) || moveAt <= 0) return null;
  const room = readings.find((row) => row.runtime === "codex" && row.status === "ok" && belowThreshold(
    freshReading(row.line, row.readAt, { now, staleSeconds }), moveAt));
  return room ? `RUNTIME-MIX all ${live.length} live writers are Claude; Codex room on ${room.machine} below ${moveAt}%` : null;
}
