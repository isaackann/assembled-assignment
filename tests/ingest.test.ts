import { describe, expect, it } from "vitest";

import { arrivals } from "../scripts/replay.ts";
import { handleEvent, tick } from "../src/ingest.ts";
import {
  type Db,
  getAgentState,
  getLiveIncident,
  getQueueState,
  openStore,
  seedDirectory,
  insertRules,
} from "../src/store/store.ts";
import { adherenceRule, at, breachRule, feedLine, snapshotLine } from "./testHelpers.ts";

/** An empty in-memory database holding the one seeded rule. */
function newStore(): Db {
  const db = openStore(":memory:");
  insertRules(db, [breachRule()]);
  return db;
}

/**
 * Ingests lines in order, carrying the clock forward, and returns each result. Runs
 * the scheduled tick before each line, as a ticker that never misses a beat would;
 * the tick's notifications are put in front of the line's own.
 */
function ingestAll(db: Db, lines: string[]) {
  return arrivals(lines).map(({ line, at: now }) => {
    const ticked = tick(db, now);
    const result = handleEvent(db, line, now);
    return { ...result, notifications: [...ticked, ...result.notifications] };
  });
}

function storedEvents(db: Db, eventId: string) {
  return db.prepare("select ts, outcome from events where event_id = ?").all(eventId);
}

describe("handleEvent", () => {
  describe("duplicates", () => {
    it("drops a second event with the same id, even though its timestamp differs (lines 50 and 95)", () => {
      const db = newStore();
      const [first, second] = ingestAll(db, [feedLine(50), feedLine(95)]);

      expect(first?.outcome).toBe("applied");
      expect(second).toMatchObject({ outcome: "duplicate", reason: "duplicate of evt_01HXYZ050" });
      expect(storedEvents(db, "evt_01HXYZ050")).toEqual([
        { ts: at("09:36:00"), outcome: "applied" },
      ]);
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
    it("opens once for six breached snapshots in a row (09:30 to 10:00), then follows up every 15 minutes", () => {
      const db = newStore();
      const breached = [39, 49, 52, 55, 66, 68].map(feedLine);
      const notifications = ingestAll(db, breached).flatMap((result) => result.notifications);

      expect(notifications.map((n) => [n.kind, n.at])).toEqual([
        ["opened", at("09:30:00")],
        ["follow_up", at("09:45:00")],
        ["follow_up", at("10:00:00")],
      ]);
      expect(notifications[0]).toMatchObject({
        recipient_id: "lead_1",
        kind: "opened",
        at: at("09:30:00"),
        message: "queue billing: SLA used 108.3% (rule: SLA used above 100%)",
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

  describe("timers", () => {
    it("fires every follow-up that came due across a long gap, in order, stamped with its due time", () => {
      const db = newStore();
      const [, later] = ingestAll(db, [
        snapshotLine({ event_id: "evt_a", ts: "2026-05-26T09:30:00Z", longest_wait_sec: 130 }),
        snapshotLine({ event_id: "evt_b", ts: "2026-05-26T10:05:00Z", longest_wait_sec: 150 }),
      ]);

      expect(later?.notifications.map((n) => [n.kind, n.at])).toEqual([
        ["follow_up", at("09:45:00")],
        ["follow_up", at("10:00:00")],
      ]);
      // Both fire before the 10:05 snapshot is applied, so nothing has changed since opening:
      // the opening values came back from the store as values and read the same.
      expect(later?.notifications[0]?.message).toBe(
        "queue billing: still true after 15 min: SLA used 108.3%",
      );
      expect(getLiveIncident(db, "rule_billing_sla_breached", "billing")?.opened_values).toEqual({
        sla_pct: (130 / 120) * 100,
      });
      expect(getLiveIncident(db, "rule_billing_sla_breached", "billing")?.next_due_at).toBe(
        at("10:15:00"),
      );
    });

    it("fires before an event at the same second: the follow-up sees the previous snapshot", () => {
      const db = newStore();
      const [, recovered] = ingestAll(db, [
        snapshotLine({ event_id: "evt_a", ts: "2026-05-26T09:30:00Z", longest_wait_sec: 130 }),
        snapshotLine({ event_id: "evt_b", ts: "2026-05-26T09:45:00Z", longest_wait_sec: 60 }),
      ]);

      expect(recovered?.notifications).toEqual([
        expect.objectContaining({
          kind: "follow_up",
          message: expect.stringContaining("SLA used 108.3%"),
        }),
      ]);
      expect(getLiveIncident(db, "rule_billing_sla_breached", "billing")?.status).toBe("settling");
    });

    it("closes a settled incident 5 minutes after the rule stopped holding", () => {
      const db = newStore();
      const results = ingestAll(db, [
        snapshotLine({ event_id: "evt_a", ts: "2026-05-26T09:30:00Z", longest_wait_sec: 130 }),
        snapshotLine({ event_id: "evt_b", ts: "2026-05-26T09:40:00Z", longest_wait_sec: 60 }),
        snapshotLine({ event_id: "evt_c", ts: "2026-05-26T09:44:00Z", longest_wait_sec: 60 }),
        snapshotLine({ event_id: "evt_d", ts: "2026-05-26T09:46:00Z", longest_wait_sec: 60 }),
      ]);

      expect(results[2]?.notifications).toEqual([]);
      expect(results[3]?.notifications).toEqual([
        expect.objectContaining({ kind: "closed", at: at("09:45:00") }),
      ]);
      expect(getLiveIncident(db, "rule_billing_sla_breached", "billing")).toBeNull();
    });

    it("still fires on a duplicate line, because the line moves the clock", () => {
      const db = newStore();
      const breach = snapshotLine({
        event_id: "evt_a",
        ts: "2026-05-26T09:30:00Z",
        longest_wait_sec: 130,
      });
      const [, duplicate] = ingestAll(db, [
        breach,
        snapshotLine({ event_id: "evt_a", ts: "2026-05-26T09:46:00Z" }),
      ]);

      expect(duplicate).toMatchObject({ outcome: "duplicate" });
      expect(duplicate?.notifications).toEqual([
        expect.objectContaining({ kind: "follow_up", at: at("09:45:00") }),
      ]);
    });

    it("keeps nothing from a timer that fails, and leaves the incident due", () => {
      const db = newStore();
      ingestAll(db, [
        snapshotLine({ event_id: "evt_a", ts: "2026-05-26T09:30:00Z", longest_wait_sec: 130 }),
      ]);
      // Break the rule after it opened, so the follow-up throws while describing it.
      db.prepare("update rules set conditions = ?").run(
        JSON.stringify([{ field: "sla_percent", op: ">", value: 100 }]),
      );

      expect(() =>
        handleEvent(
          db,
          snapshotLine({ event_id: "evt_b", ts: "2026-05-26T09:46:00Z" }),
          at("09:30:00"),
        ),
      ).toThrow();
      expect(db.prepare("select count(*) as n from notifications").get()).toEqual({ n: 1 });
      expect(getLiveIncident(db, "rule_billing_sla_breached", "billing")).toMatchObject({
        follow_ups: 0,
        next_due_at: at("09:45:00"),
      });
    });
  });

  describe("agents", () => {
    /** lead_1's team rule and a_19's own rule, with the seeded teams. */
    function agentStore(): Db {
      const db = openStore(":memory:");
      seedDirectory(db, {
        queues: [],
        teams: [
          { id: "team_1", lead_id: "lead_1", agent_ids: ["a_07", "a_19", "a_31", "a_42"] },
          { id: "team_2", lead_id: "lead_2", agent_ids: ["a_05", "a_11", "a_23", "a_88"] },
        ],
      });
      insertRules(db, [
        adherenceRule(),
        adherenceRule({
          id: "rule_a_19_adherence",
          owner_id: "a_19",
          subject: { kind: "agent", resource_ids: ["a_19"] },
        }),
      ]);
      return db;
    }

    it("tells a_19 and their lead once a_19 has been out of adherence for 10 minutes (lines 48 to 57)", () => {
      const db = agentStore();
      // On break 09:35, flagged at 09:36 (violation from 09:35), then the 09:45 round of events.
      const results = ingestAll(db, [48, 50, 53, 57].map(feedLine));

      expect(results[1]?.notifications).toEqual([]);
      expect(results[2]?.notifications.map((n) => [n.recipient_id, n.kind, n.at])).toEqual([
        // Same due time: incidents fire in the order they were created (rules are checked by id).
        ["a_19", "opened", at("09:45:00")],
        ["lead_1", "opened", at("09:45:00")],
      ]);
    });

    it("does not cover an agent on another lead's team", () => {
      const db = agentStore();
      // a_88 (lead_2's team) out of adherence from 10:00; nothing is due for lead_1's rule.
      ingestAll(db, [feedLine(70), feedLine(72)]);
      expect(db.prepare("select count(*) as n from incidents").get()).toEqual({ n: 0 });
    });

    it("never checks a queue rule against an agent, even one with the same id", () => {
      const db = agentStore();
      // A queue rule naming "a_19" must not read queue fields from agent a_19's state.
      insertRules(db, [
        breachRule({
          id: "rule_queue_named_a_19",
          subject: { kind: "queue", resource_ids: ["a_19"] },
        }),
      ]);
      ingestAll(db, [48, 50].map(feedLine));

      const rules = db.prepare("select distinct rule_id from incidents").all();
      expect(rules.map((row) => row.rule_id)).not.toContain("rule_queue_named_a_19");
    });

    it("covers an agent who joined the team after the rule was created: teams are read per event", () => {
      const db = agentStore();
      // a_19 moves from team_1 to team_2; a team_2 rule created before the move covers them.
      insertRules(db, [
        adherenceRule({
          id: "rule_lead_2_team_adherence",
          owner_id: "lead_2",
          subject: { kind: "team", resource_ids: ["team_2"] },
        }),
      ]);
      db.prepare("update users set team_id = 'team_2' where id = 'a_19'").run();
      ingestAll(db, [48, 50].map(feedLine));

      const pending = db
        .prepare("select rule_id from incidents where subject_id = 'a_19' order by rule_id")
        .all();
      expect(pending.map((row) => row.rule_id)).toEqual([
        "rule_a_19_adherence",
        "rule_lead_2_team_adherence",
      ]);
    });

    it("stores the agent's state, corrected by an adherence check that disagrees (lines 53 and 86)", () => {
      const db = agentStore();
      ingestAll(db, [feedLine(53), feedLine(86)]);

      expect(getAgentState(db, "a_23")).toMatchObject({
        state: "in_meeting",
        state_since: at("10:15:30"),
        // The check gives no violation start, so it starts at the check.
        violation_since: at("10:15:30"),
      });
    });
  });

  describe("agent duration episodes", () => {
    function callLine(time: string) {
      return JSON.stringify({
        event_id: `call_${time}`, ts: `2026-05-26T${time}Z`,
        type: "agent_state_change", agent_id: "a_19", queue_ids: [],
        previous_state: "on_call", previous_state_duration_sec: 1800, new_state: "on_call",
      });
    }

    function checkLine(time: string, inViolation = false) {
      return JSON.stringify({
        event_id: `check_${time}`, ts: `2026-05-26T${time}Z`,
        type: "adherence_check", agent_id: "a_19", queue_ids: [],
        scheduled_state: "available", actual_state: "on_call",
        in_violation: inViolation,
        violation_started_at: inViolation ? "2026-05-26T09:00:00Z" : null,
      });
    }

    function callStore(forSeconds = 2700, inAdherence = false) {
      const db = openStore(":memory:");
      insertRules(db, [adherenceRule({
        id: "call", subject: { kind: "agent", resource_ids: ["a_19"] },
        for_seconds: forSeconds,
        conditions: [
          { field: "state", op: "=", value: "on_call" },
          ...(inAdherence ? [{ field: "in_violation", op: "=" as const, value: false }] : []),
        ],
      })]);
      return db;
    }

    it("ends a pending call and starts a fresh incident; confirming checks keep its clock", () => {
      const db = callStore();
      const results = ingestAll(db, [
        callLine("09:00:00"), callLine("09:30:00"),
        checkLine("09:45:00"), checkLine("10:14:59"), checkLine("10:15:00"),
      ]);
      expect(results.flatMap(r => r.notifications).map(n => [n.kind, n.at])).toEqual([
        ["opened", at("10:15:00")],
      ]);
      expect(db.prepare("select status, started_at, closed_at from incidents order by id").all())
        .toEqual([
          { status: "closed", started_at: at("09:00:00"), closed_at: at("09:30:00") },
          { status: "open", started_at: at("09:30:00"), closed_at: null },
        ]);
    });

    it("closes an open call and cancels its follow-ups before timing the next call", () => {
      const db = callStore(600);
      const results = ingestAll(db, [
        callLine("09:00:00"), checkLine("09:10:00"), callLine("09:20:00"),
        checkLine("09:25:00"), checkLine("09:30:00"),
      ]);
      const notifications = results.flatMap(r => r.notifications);
      expect(notifications.map(n => [n.kind, n.at])).toEqual([
        ["opened", at("09:10:00")], ["closed", at("09:20:00")],
        ["opened", at("09:30:00")],
      ]);
      expect(notifications[0]?.incident_id).toBe(notifications[1]?.incident_id);
      expect(notifications[2]?.incident_id).not.toBe(notifications[0]?.incident_id);
    });

    it("waits from first observing the whole conjunction and does not reset on every check", () => {
      const db = callStore(600, true);
      const results = ingestAll(db, [
        checkLine("09:00:00", true), checkLine("09:30:00"),
        checkLine("09:35:00"), checkLine("09:39:59"), checkLine("09:40:00"),
      ]);
      expect(results.flatMap(r => r.notifications).map(n => [n.kind, n.at])).toEqual([
        ["opened", at("09:40:00")],
      ]);
      expect(getLiveIncident(db, "call", "a_19")?.started_at).toBe(at("09:30:00"));
    });

    it("still ends a call when another matching condition has an unknown start", () => {
      const db = callStore(2700, true);
      const results = ingestAll(db, [
        callLine("09:00:00"), callLine("09:30:00"),
        checkLine("09:45:00"), checkLine("10:15:00"),
      ]);
      expect(results.flatMap(r => r.notifications).map(n => [n.kind, n.at])).toEqual([
        ["opened", at("10:15:00")],
      ]);
      expect(db.prepare("select count(*) as n from incidents").get()).toEqual({ n: 2 });
    });
  });

  describe("one transaction per event", () => {
    it("keeps nothing from an event when checking its rules fails", () => {
      const db = openStore(":memory:");
      // The rule names a field the catalog does not have, so evaluating it throws
      // after the event and the queue's state have already been written.
      insertRules(db, [breachRule({ conditions: [{ field: "sla_percent", op: ">", value: 100 }] })]);

      expect(() => handleEvent(db, feedLine(39), 0)).toThrow('Unknown queue field "sla_percent"');
      expect(db.prepare("select count(*) as n from events").get()).toEqual({ n: 0 });
      expect(getQueueState(db, "billing")).toBeNull();
    });
  });

  describe("rejects", () => {
    it("stores nothing for a malformed line and leaves the clock where it was", () => {
      const db = newStore();
      const result = handleEvent(db, "{not json", at("09:00:00"));

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
