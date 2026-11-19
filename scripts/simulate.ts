// Command line: node scripts/simulate.ts <feed file>
// Runs the two deployed functions the way production would, against the sample feed,
// in simulated time: the events webhook as a real HTTP server, and the scheduled
// ticker every 30 simulated seconds. Ctrl-C stops it.
//
// The simulated clock stands in for two things outside the system: the upstream
// producer, which posts each line once simulated time reaches its arrival, and the
// platform's scheduler, which runs the ticker. Neither function is driven by the
// clock; each reads it once to know "now". One loop steps both on a single timeline
// and waits for each call to finish, so every run gives the same notifications.
//
// The feed is dated 2026-05-26, so it cannot be posted to a service on the real
// clock: every "for" deadline would already have passed. At 60x the 90-minute
// morning takes 90 seconds. Time keeps going after the last line, so follow-ups and
// closes keep coming from the ticker alone.

import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { setTimeout as sleepFor } from "node:timers/promises";

import { formatTime } from "../src/engine/normalize.ts";
import type { Outcome } from "../src/ingest.ts";
import type { Clock, Deliver } from "../src/functions/clock.ts";
import { createEventsApp } from "../src/functions/events.ts";
import { runTick } from "../src/functions/ticker.ts";
import { printNotifications } from "../src/notify/console.ts";
import type { Db, Notification } from "../src/store/store.ts";
import {
  type ReplayReport,
  arrivals,
  emptyReport,
  printSummary,
  recordLine,
  seededStore,
} from "./replay.ts";

const TICK_EVERY_MS = 30_000;
const SPEED = 60;

/** A clock the simulation moves itself. It only moves forward. */
export interface SimClock extends Clock {
  time: number;
}

export function simClock(): SimClock {
  const clock: SimClock = { time: 0, now: () => clock.time };
  return clock;
}

export interface SimulationOptions {
  db: Db;
  lines: string[];
  /** Where the events webhook is listening, e.g. http://localhost:3000 */
  baseUrl: string;
  clock: SimClock;
  /** Delivery for the ticker's notifications (the webhook has its own). */
  deliver: Deliver;
  /** Waits this many simulated ms; the CLI waits the real time at 60x. */
  sleep: (simulatedMs: number) => Promise<void>;
  /** Stop after this simulated time. Without it the run never ends (Ctrl-C). */
  stopAt?: number;
  /** Filled in as lines are posted, so a Ctrl-C can still print the summary. */
  report: ReplayReport;
}

/** Steps the producer and the scheduler on one simulated timeline. */
export async function runSimulation(options: SimulationOptions): Promise<void> {
  const { db, baseUrl, clock, deliver, sleep, stopAt, report } = options;
  const feed = arrivals(options.lines);
  if (feed.length === 0) return;

  clock.time = feed[0]!.at;
  let nextTick = Math.ceil(clock.time / TICK_EVERY_MS) * TICK_EVERY_MS;
  let next = 0;

  while (true) {
    const arrival = feed[next];
    const step = Math.min(arrival?.at ?? Infinity, nextTick);
    if (stopAt !== undefined && step > stopAt) return;

    await sleep(step - clock.time);
    clock.time = step;

    // The tick goes first on a tie. Either order sends the same notifications: the
    // webhook settles any overdue deadline on an incident before changing it.
    if (!arrival || nextTick <= arrival.at) {
      runTick(db, clock, deliver);
      nextTick += TICK_EVERY_MS;
      continue;
    }

    const response = await fetch(`${baseUrl}/events`, {
      method: "POST",
      body: arrival.line,
    });
    const body = (await response.json()) as { outcome: Outcome; reason: string | null };
    recordLine(report, arrival.lineNumber, body.outcome, body.reason);
    next += 1;
    if (next === feed.length) {
      console.log(`--- ${formatTime(clock.time)}  feed finished; the ticker keeps running ---`);
    }
  }
}

if (import.meta.main) {
  const feedPath = process.argv[2];
  if (!feedPath) {
    console.error("Usage: node scripts/simulate.ts <feed file>");
    process.exit(1);
  }

  const db = seededStore();
  const clock = simClock();
  const report = emptyReport();
  const deliver: Deliver = (notifications: Notification[], source) => {
    report.notifications.push(...notifications);
    printNotifications(notifications, `[${source}]  `);
  };

  const server = createEventsApp(db, clock, deliver).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;

  process.once("SIGINT", () => {
    console.log(`\nStopped at simulated ${formatTime(clock.time)}.`);
    printSummary(db, feedPath, report);
    server.close();
    process.exit(0);
  });

  console.log(`Events webhook on http://localhost:${port}/events; ticker every 30s.`);
  console.log(`Simulated time at ${SPEED}x. Ctrl-C to stop.\n`);
  await runSimulation({
    db,
    lines: readFileSync(feedPath, "utf8").split("\n"),
    baseUrl: `http://localhost:${port}`,
    clock,
    deliver,
    sleep: (ms) => (ms > 0 ? sleepFor(ms / SPEED) : Promise.resolve()),
    report,
  });
}
