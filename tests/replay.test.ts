// The end-to-end check: the whole sample feed, the shipped directory and the shipped
// rules through the real pipeline. It tests replayFeed (in ingest.ts) rather than
// replay.ts, which is only the command-line wrapper and runs as soon as it is loaded.
//
// EXPECTED was worked out by hand from the feed before the engine was written. It
// is the acceptance test for the five scenarios the seeded rules stand for: SLA
// breached, near SLA, more than 20 waiting, out of adherence for 10 minutes, and
// on a call for 45 minutes.

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { formatTime } from "../src/engine/normalize.ts";
import { replayFeed } from "../src/ingest.ts";
import { listLiveIncidents, openStore, seedDirectory, seedRules } from "../src/store/store.ts";
import { feedLines } from "./testHelpers.ts";

const readData = (name: string) =>
  JSON.parse(readFileSync(new URL(`../data/${name}`, import.meta.url), "utf8"));

// time, kind, recipient, subject, rule
const EXPECTED = [
  ["09:30:00", "opened", "lead_1", "billing", "rule_sla_breached"],
  ["09:36:00", "opened", "lead_1", "billing", "rule_over_20_waiting"],
  ["09:45:00", "follow_up", "lead_1", "billing", "rule_sla_breached"],
  ["09:45:00", "closed", "lead_1", "billing", "rule_over_20_waiting"],
  ["09:45:00", "opened", "lead_1", "tier_2", "rule_sla_near"],
  ["09:45:00", "opened", "lead_1", "a_19", "rule_lead_1_team_adherence"],
  ["09:45:00", "opened", "a_19", "a_19", "rule_a_19_adherence"],
  ["09:55:00", "opened", "lead_2", "a_11", "rule_lead_2_team_long_call"],
  ["10:00:00", "follow_up", "lead_1", "billing", "rule_sla_breached"],
  ["10:00:00", "follow_up", "lead_1", "tier_2", "rule_sla_near"],
  ["10:00:00", "follow_up", "lead_1", "a_19", "rule_lead_1_team_adherence"],
  ["10:00:00", "follow_up", "a_19", "a_19", "rule_a_19_adherence"],
  ["10:00:00", "opened", "lead_1", "tier_2", "rule_sla_breached"],
  ["10:05:00", "closed", "lead_1", "tier_2", "rule_sla_near"],
  ["10:10:00", "opened", "lead_2", "a_88", "rule_lead_2_team_adherence"],
  ["10:10:00", "opened", "a_88", "a_88", "rule_a_88_adherence"],
  ["10:10:00", "opened", "lead_1", "a_07", "rule_lead_1_team_long_call"],
  ["10:10:00", "follow_up", "lead_2", "a_11", "rule_lead_2_team_long_call"],
  ["10:10:30", "closed", "lead_1", "a_19", "rule_lead_1_team_adherence"],
  ["10:10:30", "closed", "a_19", "a_19", "rule_a_19_adherence"],
  ["10:15:00", "follow_up", "lead_1", "billing", "rule_sla_breached"],
  ["10:15:00", "follow_up", "lead_1", "tier_2", "rule_sla_breached"],
  ["10:15:00", "opened", "lead_1", "a_31", "rule_lead_1_team_long_call"],
  ["10:16:00", "opened", "lead_1", "billing", "rule_sla_near"],
  ["10:20:00", "closed", "lead_1", "billing", "rule_sla_breached"],
  ["10:20:00", "closed", "lead_1", "tier_2", "rule_sla_breached"],
  ["10:20:00", "closed", "lead_2", "a_11", "rule_lead_2_team_long_call"],
  ["10:25:00", "closed", "lead_1", "a_31", "rule_lead_1_team_long_call"],
  ["10:25:00", "follow_up", "lead_2", "a_88", "rule_lead_2_team_adherence"],
  ["10:25:00", "follow_up", "a_88", "a_88", "rule_a_88_adherence"],
  ["10:25:00", "follow_up", "lead_1", "a_07", "rule_lead_1_team_long_call"],
  ["10:25:30", "opened", "lead_2", "a_23", "rule_lead_2_team_adherence"],
  ["10:25:30", "opened", "a_23", "a_23", "rule_a_23_adherence"],
];

describe("replayFeed on data/events.jsonl with the shipped directory and rules", () => {
  const db = openStore(":memory:");
  seedDirectory(db, readData("directory.json"));
  seedRules(db, readData("rules.seed.json"));
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

  it("fires exactly the 33 notifications worked out by hand, for the right person and rule", () => {
    const rows = db
      .prepare(
        `select n.at, n.kind, n.recipient_id, i.subject_id, i.rule_id
         from notifications n join incidents i on n.incident_id = i.id`,
      )
      .all()
      .map((row) => [
        formatTime(row.at as number).slice(11, 19),
        row.kind,
        row.recipient_id,
        row.subject_id,
        row.rule_id,
      ]);

    // Within one second the order follows incident ids, which the table does not try to predict.
    const sorted = (list: unknown[][]) => list.map((row) => row.join(" ")).sort();
    expect(sorted(rows)).toEqual(sorted(EXPECTED));
    expect(report.notifications).toHaveLength(33);
  });

  it("delivers notifications in time order", () => {
    const times = report.notifications.map((n) => n.at);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it("leaves the incidents live that the feed has not ended", () => {
    const live = listLiveIncidents(db).map((i) => `${i.status} ${i.rule_id} ${i.subject_id}`);

    expect(live.sort()).toEqual(
      [
        "open rule_a_23_adherence a_23",
        "open rule_a_88_adherence a_88",
        "open rule_lead_1_team_long_call a_07",
        "pending rule_lead_1_team_long_call a_42",
        "open rule_lead_2_team_adherence a_23",
        "open rule_lead_2_team_adherence a_88",
        "settling rule_sla_near billing",
      ].sort(),
    );
  });

  it("reads the reason in words: the 09:30 billing breach", () => {
    expect(report.notifications[0]).toMatchObject({
      recipient_id: "lead_1",
      kind: "opened",
      message: "queue billing: SLA used 108.3% (rule: SLA used above 100%)",
      detail: { longest_wait_sec: 130, sla_target_sec: 120, tickets_waiting: 18 },
    });
  });
});
