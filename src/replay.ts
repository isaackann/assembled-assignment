// Command line: node src/replay.ts <feed file>
// Replays a feed through the system from an empty database and prints the
// notifications as they fire, then what happened to every line.
// The database is in memory, so each run starts clean and a second run cannot be
// silenced by event ids remembered from the first.

import { readFileSync } from "node:fs";

import { formatTime } from "./engine/normalize.ts";
import { replayFeed } from "./ingest.ts";
import { printNotifications } from "./notify/console.ts";
import { listLiveIncidents, openStore, seedDirectory, seedRules } from "./store/store.ts";

const feedPath = process.argv[2];
if (!feedPath) {
  console.error("Usage: node src/replay.ts <feed file>");
  process.exit(1);
}

const readData = (name: string) =>
  JSON.parse(readFileSync(new URL(`../data/${name}`, import.meta.url), "utf8"));
const db = openStore(":memory:");
seedDirectory(db, readData("directory.json"));
seedRules(db, readData("rules.seed.json"));

const report = replayFeed(db, readFileSync(feedPath, "utf8").split("\n"), printNotifications);

const { applied, late, duplicate, rejected } = report.counts;
console.log(`\nReplayed ${feedPath}: ${report.lines} lines`);
console.log(`  applied ${applied}, late ${late}, duplicate ${duplicate}, rejected ${rejected}`);
for (const skipped of report.skipped) {
  console.log(`  line ${skipped.line}: ${skipped.reason}`);
}
const live = listLiveIncidents(db);
console.log(`  notifications ${report.notifications.length}, incidents still live ${live.length}`);
for (const incident of live) {
  const due = incident.next_due_at === null ? "" : `, next due ${formatTime(incident.next_due_at)}`;
  console.log(`  ${incident.status.padEnd(8)}  ${incident.rule_id}  ${incident.subject_id}${due}`);
}
