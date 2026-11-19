// The simulation: the sample feed posted to the real webhook over HTTP, and the
// ticker every 30 simulated seconds, with no waiting. It must send the same 33
// notifications as the replay up to the feed's end, then keep going on the ticker.

import type { AddressInfo } from "node:net";

import { describe, expect, it } from "vitest";

import { emptyReport, seededStore } from "../scripts/replay.ts";
import { runSimulation, simClock } from "../scripts/simulate.ts";
import { createEventsApp } from "../src/functions/events.ts";
import type { Source } from "../src/functions/clock.ts";
import { SAMPLE_EXPECTED, at, feedLines, notificationRows, sortedRows } from "./testHelpers.ts";

// What the ticker alone sends after the last line (10:30), up to 10:45, worked out by
// hand from the incidents live at the end of the feed, before this test was run.
const TAIL = [
  ["10:33:00", "opened", "lead_1", "a_42", "rule_lead_1_team_long_call"],
  ["10:35:00", "closed", "lead_1", "billing", "rule_sla_near"],
  ["10:40:00", "follow_up", "lead_2", "a_88", "rule_lead_2_team_adherence"],
  ["10:40:00", "follow_up", "a_88", "a_88", "rule_a_88_adherence"],
  ["10:40:00", "follow_up", "lead_1", "a_07", "rule_lead_1_team_long_call"],
  ["10:40:30", "follow_up", "lead_2", "a_23", "rule_lead_2_team_adherence"],
  ["10:40:30", "follow_up", "a_23", "a_23", "rule_a_23_adherence"],
];

/** Runs the sample feed through the simulation up to 10:45, with no waiting. */
async function simulate() {
  const db = seededStore();
  const clock = simClock();
  const sources: Source[] = [];
  const deliver = (notifications: unknown[], source: Source) =>
    notifications.forEach(() => sources.push(source));
  const report = emptyReport();

  const server = createEventsApp(db, clock, deliver).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    await runSimulation({
      db,
      lines: feedLines(),
      baseUrl: `http://localhost:${(server.address() as AddressInfo).port}`,
      clock,
      deliver,
      sleep: async () => {},
      stopAt: at("10:45:00"),
      report,
    });
  } finally {
    server.close();
  }
  return { rows: notificationRows(db), sources, report };
}

describe("runSimulation on data/events.jsonl", () => {
  it("sends the 33 notifications worked out by hand up to the feed's end, then the ticker's tail", async () => {
    const { rows } = await simulate();

    expect(sortedRows(rows.filter((r) => r[0]! <= "10:30:00"))).toEqual(
      sortedRows(SAMPLE_EXPECTED),
    );
    expect(sortedRows(rows.filter((r) => r[0]! > "10:30:00"))).toEqual(sortedRows(TAIL));
  });

  it("posts every line to the webhook: 94 applied, the duplicate and the late line as in the replay", async () => {
    const { report } = await simulate();

    expect(report.counts).toEqual({ applied: 94, late: 1, duplicate: 1, rejected: 0 });
    expect(report.skipped.map((s) => [s.line, s.outcome])).toEqual([
      [95, "duplicate"],
      [96, "late"],
    ]);
  });

  it("has both functions sending notifications", async () => {
    const { sources } = await simulate();

    expect(sources).toContain("webhook");
    expect(sources).toContain("ticker");
  });

  it("gives the same notifications every run", async () => {
    const first = await simulate();
    const second = await simulate();

    expect(second.rows).toEqual(first.rows);
  });
});
