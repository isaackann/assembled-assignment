// The end-to-end check: the whole sample feed, the shipped directory and the shipped
// rules through the real pipeline. It tests replayFeed rather than
// the command-line part of scripts/replay.ts.
//
// SAMPLE_EXPECTED was worked out by hand from the feed before the engine was written. It
// is the acceptance test for the five scenarios the seeded rules stand for: SLA
// breached, near SLA, more than 20 waiting, out of adherence for 10 minutes, and
// on a call for 45 minutes.

import { describe, expect, it } from "vitest";

import { replayFeed, seededStore } from "../scripts/replay.ts";
import { listLiveIncidents } from "../src/store/store.ts";
import { SAMPLE_EXPECTED, feedLines, notificationRows, sortedRows } from "./testHelpers.ts";

describe("replayFeed on data/events.jsonl with the shipped directory and rules", () => {
  const db = seededStore();
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
    const rows = notificationRows(db);

    expect(sortedRows(rows)).toEqual(sortedRows(SAMPLE_EXPECTED));
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
