// The simulation: the sample feed posted to the real webhook over HTTP, and the
// ticker every 30 simulated seconds, with no waiting. It must send the same 33
// notifications as the replay up to the feed's end, then keep going on the ticker.

import type { AddressInfo } from "node:net";

import { describe, expect, it } from "vitest";

import { emptyReport, seededStore } from "../scripts/replay.ts";
import { createSimulationServer, runSimulation, simClock } from "../scripts/simulate.ts";
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

// Sprint 3's exit: a rule created through the config API fires on the sample feed.
// lead_1, "any of my agents goes on break". Worked out by hand from the feed before
// this test was run: only a_19 goes on break in the feed (09:35, back at 10:10). A
// state rule with no "for" opens on the event, follows up every 15 minutes on the
// ticker, and closes on the event that ends the state.
const BREAK_ROWS = [
  ["09:35:00", "opened", "lead_1", "a_19"],
  ["09:50:00", "follow_up", "lead_1", "a_19"],
  ["10:05:00", "follow_up", "lead_1", "a_19"],
  ["10:10:00", "closed", "lead_1", "a_19"],
];

describe("a rule created through the config API, then the feed started", () => {
  /** The simulation's own server: config API, webhook and start control. */
  async function startServer() {
    const db = seededStore();
    const server = createSimulationServer({
      db,
      lines: feedLines(),
      clock: simClock(),
      deliver: () => {},
      sleep: async () => {},
      stopAt: at("10:45:00"),
      report: emptyReport(),
    }).listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    const base = `http://localhost:${(server.address() as AddressInfo).port}`;
    return { db, server, base };
  }

  /** Waits until the started feed has played up to its stop time. */
  async function waitForFeed(base: string) {
    for (let i = 0; i < 200; i++) {
      const { now } = await (await fetch(`${base}/simulation`)).json();
      if (now === at("10:45:00")) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("The feed did not finish");
  }

  it("fires the new rule exactly as worked out by hand, and leaves the seeded 33 as they were", async () => {
    const { db, server, base } = await startServer();
    try {
      const created = await fetch(`${base}/rules`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          owner_id: "lead_1",
          subject: { kind: "team", resource_ids: ["team_1"] },
          conditions: [{ field: "state", op: "=", value: "on_break" }],
          for_seconds: 0,
        }),
      });
      const rule = await created.json();
      expect(created.status).toBe(201);

      expect((await fetch(`${base}/simulation/start`, { method: "POST" })).status).toBe(202);
      await waitForFeed(base);

      const rows = notificationRows(db);
      expect(rows.filter((r) => r[4] === rule.id).map((r) => r.slice(0, 4))).toEqual(BREAK_ROWS);
      const seeded = rows.filter((r) => r[4] !== rule.id && r[0]! <= "10:30:00");
      expect(sortedRows(seeded)).toEqual(sortedRows(SAMPLE_EXPECTED));
    } finally {
      server.close();
    }
  });

  it("starts once: a second start is refused", async () => {
    const { server, base } = await startServer();
    try {
      expect(await (await fetch(`${base}/simulation`)).json()).toEqual({
        started: false,
        now: null,
      });
      expect((await fetch(`${base}/simulation/start`, { method: "POST" })).status).toBe(202);
      expect((await fetch(`${base}/simulation/start`, { method: "POST" })).status).toBe(409);
      await waitForFeed(base);
    } finally {
      server.close();
    }
  });
});
