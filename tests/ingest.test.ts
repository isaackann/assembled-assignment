import { describe, expect, it } from "vitest";

import { ingestLine } from "../src/ingest.ts";
import { type Db, getLiveIncident, getQueueState, openStore, seedRules } from "../src/store/store.ts";
import { at, breachRule, feedLine, snapshotLine } from "./testHelpers.ts";

/** An empty in-memory database holding the one seeded rule. */
function newStore(): Db {
  const db = openStore(":memory:");
  seedRules(db, [breachRule()]);
  return db;
}

/** Ingests lines in order, carrying the clock forward, and returns each result. */
function ingestAll(db: Db, lines: string[]) {
  let now = 0;
  return lines.map((line) => {
    const result = ingestLine(db, line, now);
    now = result.now;
    return result;
  });
}

function storedEvents(db: Db, eventId: string) {
  return db.prepare("select ts, outcome from events where event_id = ?").all(eventId);
}

describe("ingestLine", () => {
  describe("duplicates", () => {
    it("drops a second event with the same id, even though its timestamp differs (lines 50 and 95)", () => {
      const db = newStore();
      const [first, second] = ingestAll(db, [feedLine(50), feedLine(95)]);

      expect(first?.outcome).toBe("applied");
      expect(second).toMatchObject({ outcome: "duplicate", reason: "duplicate of evt_01HXYZ050" });
      expect(storedEvents(db, "evt_01HXYZ050")).toEqual([{ ts: at("09:36:00"), outcome: "applied" }]);
    });
  });

  describe("late events", () => {
    it("stores a late event but leaves the queue's state alone (lines 93 and 96)", () => {
      const db = newStore();
      // Line 93 is vip at 10:30. Line 96 arrives after it, stamped 09:49.
      const [, late] = ingestAll(db, [feedLine(93), feedLine(96)]);

      expect(late).toMatchObject({
        outcome: "late",
        reason: "late, vip already has data from 2026-05-26T10:30:00Z",
      });
      expect(storedEvents(db, "evt_01HXYZ096")).toEqual([{ ts: at("09:49:00"), outcome: "late" }]);
      expect(getQueueState(db, "vip")).toMatchObject({
        longest_wait_sec: 0,
        last_event_ts: at("10:30:00"),
      });
    });

    it("applies an event with the same timestamp as the subject's newest (lines 38 and 40)", () => {
      const db = newStore();
      // Both are a_31 at 09:30:00: a state change, then an adherence check.
      const results = ingestAll(db, [feedLine(38), feedLine(40)]);

      expect(results.map((result) => result.outcome)).toEqual(["applied", "applied"]);
    });

    it("does not let a late breached snapshot open an incident", () => {
      const db = newStore();
      const [, late] = ingestAll(db, [
        snapshotLine({ event_id: "evt_a", ts: "2026-05-26T10:00:00Z", longest_wait_sec: 60 }),
        snapshotLine({ event_id: "evt_b", ts: "2026-05-26T09:50:00Z", longest_wait_sec: 270 }),
      ]);

      expect(late).toMatchObject({ outcome: "late", notifications: [] });
      expect(getLiveIncident(db, "rule_billing_sla_breached", "billing")).toBeNull();
    });
  });

  describe("the billing breach", () => {
    it("notifies once for six breached snapshots in a row (09:30 to 10:00)", () => {
      const db = newStore();
      const breached = [39, 49, 52, 55, 66, 68].map(feedLine);
      const notifications = ingestAll(db, breached).flatMap((result) => result.notifications);

      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toMatchObject({
        recipient_id: "lead_1",
        kind: "opened",
        at: at("09:30:00"),
        message: "queue billing: sla_pct is 108.3 (rule: sla_pct > 100)",
      });
    });

    it("does not notify for a queue the rule does not cover", () => {
      const db = newStore();
      const [result] = ingestAll(db, [snapshotLine({ queue_id: "tier_2", longest_wait_sec: 500 })]);

      expect(result).toMatchObject({ outcome: "applied", notifications: [] });
    });
  });

  describe("the clock", () => {
    it("never moves backward", () => {
      const db = newStore();
      const results = ingestAll(db, [feedLine(93), feedLine(96)]);

      expect(results.map((result) => result.now)).toEqual([at("10:30:00"), at("10:30:00")]);
    });

    it("stamps an incident found from an older event with current time, not the event's", () => {
      const db = newStore();
      // vip moves the clock to 10:30. Billing's first snapshot then arrives stamped 09:30.
      // Billing has no newer data, so it is accepted, and the breach started at 09:30.
      const [, breach] = ingestAll(db, [feedLine(93), feedLine(39)]);

      expect(breach?.outcome).toBe("applied");
      expect(breach?.notifications[0]?.at).toBe(at("10:30:00"));
      expect(getLiveIncident(db, "rule_billing_sla_breached", "billing")).toMatchObject({
        started_at: at("09:30:00"),
        opened_at: at("10:30:00"),
      });
    });
  });

  describe("one transaction per event", () => {
    it("keeps nothing from an event when checking its rules fails", () => {
      const db = openStore(":memory:");
      // The rule names a field the catalog does not have, so evaluating it throws
      // after the event and the queue's state have already been written.
      seedRules(db, [breachRule({ conditions: [{ field: "sla_percent", op: ">", value: 100 }] })]);

      expect(() => ingestLine(db, feedLine(39), 0)).toThrow('Unknown queue field "sla_percent"');
      expect(db.prepare("select count(*) as n from events").get()).toEqual({ n: 0 });
      expect(getQueueState(db, "billing")).toBeNull();
    });
  });

  describe("rejects", () => {
    it("stores nothing for a malformed line and leaves the clock where it was", () => {
      const db = newStore();
      const result = ingestLine(db, "{not json", at("09:00:00"));

      expect(result).toEqual({
        outcome: "rejected",
        reason: "not valid JSON",
        now: at("09:00:00"),
        notifications: [],
      });
      expect(db.prepare("select count(*) as n from events").get()).toEqual({ n: 0 });
    });
  });
});
