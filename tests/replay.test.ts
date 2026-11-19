// The end-to-end check: the whole sample feed and the shipped rules through the
// real pipeline. It tests replayFeed (in ingest.ts) rather than replay.ts, which
// is only the command-line wrapper and runs as soon as it is loaded.

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { replayFeed } from "../src/ingest.ts";
import { countLiveIncidents, openStore, seedRules } from "../src/store/store.ts";
import { at, feedLines } from "./testHelpers.ts";

const SEED_RULES_URL = new URL("../data/rules.seed.json", import.meta.url);

describe("replayFeed on data/events.jsonl with data/rules.seed.json", () => {
  const db = openStore(":memory:");
  seedRules(db, JSON.parse(readFileSync(SEED_RULES_URL, "utf8")));
  const report = replayFeed(db, feedLines(), () => {});

  it("accounts for all 96 lines", () => {
    expect(report.lines).toBe(96);
    expect(report.counts).toEqual({ applied: 94, late: 1, duplicate: 1, rejected: 0 });
  });

  it("reports the duplicate and the late line by line number", () => {
    expect(report.skipped).toEqual([
      { line: 95, outcome: "duplicate", reason: "duplicate of evt_01HXYZ050" },
      { line: 96, outcome: "late", reason: "late, vip already has data from 2026-05-26T10:30:00Z" },
    ]);
  });

  it("fires exactly one notification: billing breached its SLA at 09:30", () => {
    expect(report.notifications).toHaveLength(1);
    expect(report.notifications[0]).toMatchObject({
      recipient_id: "lead_1",
      kind: "opened",
      at: at("09:30:00"),
      message: "queue billing: sla_pct is 108.3 (rule: sla_pct > 100)",
      detail: { longest_wait_sec: 130, sla_target_sec: 120, tickets_waiting: 18 },
    });
  });

  it("leaves the billing incident open, since closing is not built yet", () => {
    expect(countLiveIncidents(db)).toBe(1);
  });
});
