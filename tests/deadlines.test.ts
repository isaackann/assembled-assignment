// The two triggers in production: the scheduled tick fires deadlines (an opening after
// a "for", a follow-up, a settled close) with no event needed, and the events webhook
// never overtakes a deadline on an incident it is about to change, even when the
// tick has not reached it yet.

import { describe, expect, it } from "vitest";

import { formatTime } from "../src/engine/normalize.ts";
import { handleEvent, tick } from "../src/ingest.ts";
import { type Db, openStore, insertRules } from "../src/store/store.ts";
import { replayFeed, seededStore } from "../scripts/replay.ts";
import {
  adherenceRule,
  at,
  feedLine,
  feedLines,
  notificationRows,
  sortedRows,
} from "./testHelpers.ts";

/** Feeds lines 1..last, with the tick run before each one, as the replay does. */
function feedThrough(db: Db, last: number): void {
  replayFeed(db, feedLines().slice(0, last), () => {});
}

const row = (n: { at: number; kind: string; recipient_id: string }) => [
  formatTime(n.at).slice(11, 19),
  n.kind,
  n.recipient_id,
];

describe("tick", () => {
  it("opens a_11's long call at 09:55 with no event after it (line 66 is 09:50)", () => {
    const db = seededStore();
    feedThrough(db, 66);

    expect(tick(db, at("09:55:00")).map(row)).toEqual([["09:55:00", "opened", "lead_2"]]);
  });

  it("sends nothing the second time at the same time", () => {
    const db = seededStore();
    feedThrough(db, 66);
    tick(db, at("09:55:00"));

    expect(tick(db, at("09:55:00"))).toEqual([]);
  });
});

describe("handleEvent with a deadline the tick has not reached", () => {
  it("sends tier_2's 10:00 near-SLA follow-up before the 10:00 snapshot moves it past 100%", () => {
    // With the snapshot first, the near-SLA incident would start settling and its
    // follow-up would never go out.
    const db = seededStore();
    feedThrough(db, 67);

    const result = handleEvent(db, feedLine(69), at("10:00:00"));

    expect(sortedRows(notificationRows(db).filter((r) => r[0] === "10:00:00"))).toEqual(
      sortedRows([
        ["10:00:00", "follow_up", "lead_1", "tier_2", "rule_sla_near"],
        ["10:00:00", "opened", "lead_1", "tier_2", "rule_sla_breached"],
      ]),
    );
    expect(result.notifications).toHaveLength(2);
    // The follow-up reports tier_2 as it was when it came due, not the snapshot's 106.7%.
    const followUp = result.notifications.find((n) => n.kind === "follow_up");
    expect(followUp?.message).toBe("queue tier_2: still true after 15 min: SLA used 83.3%");
  });

  it("does not lose an opening whose 'for' ran out before the agent came back", () => {
    // Out of adherence from 09:00 with a 10 minute rule: due at 09:10. The agent is
    // back at 09:10:10, before any tick. The opening goes out, then the close.
    const db = openStore(":memory:");
    insertRules(db, [
      adherenceRule({ id: "mine", subject: { kind: "agent", resource_ids: ["a_19"] } }),
    ]);
    const check = (time: string, inViolation: boolean) =>
      JSON.stringify({
        event_id: `check_${time}`,
        ts: `2026-05-26T${time}Z`,
        type: "adherence_check",
        agent_id: "a_19",
        queue_ids: [],
        scheduled_state: "available",
        actual_state: inViolation ? "in_meeting" : "available",
        in_violation: inViolation,
        violation_started_at: inViolation ? "2026-05-26T09:00:00Z" : null,
      });

    handleEvent(db, check("09:00:00", true), at("09:00:00"));
    const result = handleEvent(db, check("09:10:10", false), at("09:10:10"));

    expect(result.notifications.map(row)).toEqual([
      ["09:10:00", "opened", "lead_1"],
      ["09:10:10", "closed", "lead_1"],
    ]);
  });
});
