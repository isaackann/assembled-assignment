// Command line: node scripts/replay.ts <feed file>
// Replays a feed through the system as fast as it can, from an empty database, and
// prints the notifications as they fire, then what happened to every line. Time is
// the feed's own: it stops at the last line, so nothing fires after the feed ends.
// For the same feed shown as two running services, see scripts/simulate.ts.
// The database is in memory, so each run starts clean and a second run cannot be
// silenced by event ids remembered from the first.

import { readFileSync } from "node:fs";

import { formatTime, normalize } from "../src/engine/normalize.ts";
import { type Outcome, handleEvent, tick } from "../src/ingest.ts";
import { printNotifications } from "../src/notify/console.ts";
import {
  type Db,
  type Notification,
  listLiveIncidents,
  openStore,
  seedDirectory,
  seedRules,
} from "../src/store/store.ts";

/** A line that was not applied, for the summary. */
export interface SkippedLine {
  line: number;
  outcome: Outcome;
  reason: string;
}

/** What a replay did. */
export interface ReplayReport {
  lines: number;
  counts: Record<Outcome, number>;
  skipped: SkippedLine[];
  notifications: Notification[];
}

/** A report with nothing in it yet. */
export function emptyReport(): ReplayReport {
  return {
    lines: 0,
    counts: { applied: 0, late: 0, duplicate: 0, rejected: 0 },
    skipped: [],
    notifications: [],
  };
}

/** Counts one handled line, and keeps the reason if it was not applied. */
export function recordLine(
  report: ReplayReport,
  line: number,
  outcome: Outcome,
  reason: string | null,
): void {
  report.lines += 1;
  report.counts[outcome] += 1;
  if (reason !== null) report.skipped.push({ line, outcome, reason });
}

/** One line of the feed with the time it arrives at. */
export interface Arrival {
  lineNumber: number;
  line: string;
  at: number;
}

/**
 * File order is arrival order. A line arrives at its own timestamp, or at the
 * previous line's arrival if its timestamp is older or unreadable: the producer
 * never sends into the past, so late lines arrive late. Blank lines are skipped.
 */
export function arrivals(lines: string[]): Arrival[] {
  const result: Arrival[] = [];
  let at = 0;
  lines.forEach((line, index) => {
    if (line.trim() === "") return;
    const parsed = normalize(line);
    if (parsed.ok) at = Math.max(at, parsed.event.ts);
    result.push({ lineNumber: index + 1, line, at });
  });
  return result;
}

/**
 * Replays a feed line by line, each at its arrival time. Before each line it runs
 * the scheduled tick at that time, standing in for a ticker that never misses a
 * beat, then hands the line to the events webhook's handler. `deliver` gets each
 * line's notifications.
 */
export function replayFeed(
  db: Db,
  lines: string[],
  deliver: (notifications: Notification[]) => void,
): ReplayReport {
  const report = emptyReport();

  for (const { lineNumber, line, at } of arrivals(lines)) {
    const ticked = tick(db, at);
    const result = handleEvent(db, line, at);

    recordLine(report, lineNumber, result.outcome, result.reason);
    const notifications = [...ticked, ...result.notifications];
    report.notifications.push(...notifications);
    deliver(notifications);
  }

  return report;
}

/** An in-memory database holding the shipped directory and rules. */
export function seededStore(): Db {
  const readData = (name: string) =>
    JSON.parse(readFileSync(new URL(`../data/${name}`, import.meta.url), "utf8"));
  const db = openStore(":memory:");
  seedDirectory(db, readData("directory.json"));
  seedRules(db, readData("rules.seed.json"));
  return db;
}

/** Prints what happened to every line and the incidents still live. */
export function printSummary(db: Db, feedPath: string, report: ReplayReport): void {
  const { applied, late, duplicate, rejected } = report.counts;
  console.log(`\nReplayed ${feedPath}: ${report.lines} lines`);
  console.log(`  applied ${applied}, late ${late}, duplicate ${duplicate}, rejected ${rejected}`);
  for (const skipped of report.skipped) {
    console.log(`  line ${skipped.line}: ${skipped.reason}`);
  }
  const live = listLiveIncidents(db);
  console.log(
    `  notifications ${report.notifications.length}, incidents still live ${live.length}`,
  );
  for (const incident of live) {
    const due =
      incident.next_due_at === null ? "" : `, next due ${formatTime(incident.next_due_at)}`;
    console.log(
      `  ${incident.status.padEnd(8)}  ${incident.rule_id}  ${incident.subject_id}${due}`,
    );
  }
}

if (import.meta.main) {
  const feedPath = process.argv[2];
  if (!feedPath) {
    console.error("Usage: node scripts/replay.ts <feed file>");
    process.exit(1);
  }
  const db = seededStore();
  const report = replayFeed(db, readFileSync(feedPath, "utf8").split("\n"), printNotifications);
  printSummary(db, feedPath, report);
}
