import { describe, expect, it } from "vitest";

import {
  type EvaluationInput,
  FOLLOW_UP_MS,
  type Incident,
  SETTLE_MS,
  onEvaluation,
  onTimer,
} from "../../src/engine/incidents.ts";
import { adherenceRule, agentState, at, breachRule, queueState } from "../testHelpers.ts";

const BREACH_SEEN = at("09:30:00");

/** A billing breach seen at 09:30 with nothing live yet. */
function evaluation(overrides: Partial<EvaluationInput> = {}): EvaluationInput {
  return {
    rule: breachRule(),
    state: queueState(),
    result: { holds: true, since: null },
    live: null,
    eventTs: BREACH_SEEN,
    now: BREACH_SEEN,
    ...overrides,
  };
}

/** The billing breach incident as it stands after opening at 09:30. */
function openIncident(overrides: Partial<Incident> = {}): Incident {
  return {
    id: 1,
    rule_id: "rule_billing_sla_breached",
    subject_id: "billing",
    status: "open",
    started_at: BREACH_SEEN,
    opened_at: BREACH_SEEN,
    last_notified_at: BREACH_SEEN,
    next_due_at: BREACH_SEEN + FOLLOW_UP_MS,
    follow_ups: 0,
    opened_values: { sla_pct: (130 / 120) * 100 },
    closed_at: null,
    ...overrides,
  };
}

describe("onEvaluation", () => {
  describe("with no live incident", () => {
    it("opens one and notifies the rule's owner when the rule becomes true", () => {
      expect(onEvaluation(evaluation())).toEqual({
        next: {
          rule_id: "rule_billing_sla_breached",
          subject_id: "billing",
          status: "open",
          started_at: BREACH_SEEN,
          opened_at: BREACH_SEEN,
          last_notified_at: BREACH_SEEN,
          next_due_at: at("09:45:00"),
          follow_ups: 0,
          opened_values: { sla_pct: (130 / 120) * 100 },
          closed_at: null,
        },
        notifications: [
          {
            recipient_id: "lead_1",
            kind: "opened",
            seq: 0,
            at: BREACH_SEEN,
            message: "queue billing: SLA used 108.3% (rule: SLA used above 100%)",
            detail: {
              tickets_waiting: 18,
              longest_wait_sec: 130,
              sla_target_sec: 120,
              agents_available: 0,
              agents_on_call: 4,
              volume_last_15m: 28,
              volume_forecast_next_15m: 38,
            },
          },
        ],
      });
    });

    it("does nothing when the rule is false", () => {
      expect(onEvaluation(evaluation({ result: { holds: false, since: null } }))).toBeNull();
    });

    it("waits as pending, due when the 'for' runs out, counted from the feed's start time", () => {
      const change = onEvaluation(
        evaluation({
          rule: adherenceRule(),
          state: agentState(),
          result: { holds: true, since: at("09:35:00") },
          eventTs: at("09:36:00"),
          now: at("09:36:00"),
        }),
      );

      expect(change).toEqual({
        next: expect.objectContaining({
          status: "pending",
          subject_id: "a_19",
          started_at: at("09:35:00"),
          opened_at: null,
          next_due_at: at("09:45:00"),
        }),
        notifications: [],
      });
    });

    it("counts from the event when the feed gives no start time", () => {
      const change = onEvaluation(evaluation({ rule: breachRule({ for_seconds: 600 }) }));
      expect(change?.next).toMatchObject({
        status: "pending",
        started_at: BREACH_SEEN,
        next_due_at: at("09:40:00"),
      });
    });

    it("opens at evaluation time when the deadline had already passed, with no invented follow-ups", () => {
      const change = onEvaluation(
        evaluation({
          rule: adherenceRule(),
          state: agentState(),
          result: { holds: true, since: at("09:35:00") },
          eventTs: at("09:36:00"),
          now: at("10:30:00"),
        }),
      );

      expect(change?.next).toMatchObject({
        status: "open",
        opened_at: at("10:30:00"),
        next_due_at: at("10:45:00"),
        follow_ups: 0,
      });
      expect(change?.notifications).toEqual([
        expect.objectContaining({
          kind: "opened",
          at: at("10:30:00"),
          message: "agent a_19: out of adherence for 55 min (rule: out of adherence for 10 min)",
        }),
      ]);
    });
  });

  describe("with a pending incident", () => {
    const pending = openIncident({
      status: "pending",
      opened_at: null,
      last_notified_at: null,
      opened_values: null,
      next_due_at: at("09:40:00"),
    });

    it("closes it with no message when the rule stops holding first", () => {
      const change = onEvaluation(
        evaluation({ live: pending, result: { holds: false, since: null }, now: at("09:38:00") }),
      );

      expect(change).toEqual({
        next: { ...pending, id: 1, status: "closed", next_due_at: null, closed_at: at("09:38:00") },
        notifications: [],
      });
    });

    it("leaves it waiting while the rule still holds", () => {
      expect(onEvaluation(evaluation({ live: pending }))).toBeNull();
    });
  });

  describe("with an open incident", () => {
    it("does nothing while the rule still holds: one message per incident, not per event", () => {
      expect(onEvaluation(evaluation({ live: openIncident() }))).toBeNull();
    });

    it("starts settling when a number rule stops holding, and says nothing yet", () => {
      const change = onEvaluation(
        evaluation({
          live: openIncident(),
          result: { holds: false, since: null },
          now: at("10:15:00"),
        }),
      );

      expect(change).toEqual({
        next: expect.objectContaining({
          status: "settling",
          next_due_at: at("10:15:00") + SETTLE_MS,
        }),
        notifications: [],
      });
    });

    it("closes at once, with a message, when a rule on states stops holding: no settle", () => {
      const live = openIncident({
        rule_id: "rule_lead_1_team_adherence",
        subject_id: "a_19",
        opened_at: at("09:45:00"),
        opened_values: { in_violation: true },
      });
      const change = onEvaluation(
        evaluation({
          rule: adherenceRule(),
          state: agentState({ violation_since: null, state: "available" }),
          live,
          result: { holds: false, since: null },
          now: at("10:10:30"),
        }),
      );

      expect(change?.next).toMatchObject({
        status: "closed",
        closed_at: at("10:10:30"),
        next_due_at: null,
      });
      expect(change?.notifications).toEqual([
        expect.objectContaining({
          kind: "closed",
          at: at("10:10:30"),
          message: "agent a_19: no longer true after 26 min: not out of adherence",
        }),
      ]);
    });
  });

  describe("with a settling incident", () => {
    const settling = openIncident({ status: "settling", next_due_at: at("09:43:00") });

    it("carries on as the same incident when the rule holds again, keeping the follow-up schedule", () => {
      const change = onEvaluation(evaluation({ live: settling, now: at("09:40:00") }));

      expect(change).toEqual({
        next: expect.objectContaining({ id: 1, status: "open", next_due_at: at("09:45:00") }),
        notifications: [],
      });
    });

    it("never schedules a follow-up in the past when it comes back late", () => {
      const change = onEvaluation(evaluation({ live: settling, now: at("09:50:00") }));
      expect(change?.next.next_due_at).toBe(at("09:50:00"));
    });

    it("keeps settling while the rule stays false", () => {
      expect(
        onEvaluation(evaluation({ live: settling, result: { holds: false, since: null } })),
      ).toBeNull();
    });
  });
});

describe("onTimer", () => {
  it("opens a pending incident, stamped with the due time", () => {
    const pending = openIncident({
      rule_id: "rule_lead_1_team_adherence",
      subject_id: "a_19",
      status: "pending",
      started_at: at("09:35:00"),
      opened_at: null,
      last_notified_at: null,
      opened_values: null,
      next_due_at: at("09:45:00"),
    });
    const change = onTimer({
      rule: adherenceRule(),
      incident: pending,
      state: agentState(),
      at: at("09:45:00"),
    });

    expect(change.next).toMatchObject({
      status: "open",
      opened_at: at("09:45:00"),
      next_due_at: at("10:00:00"),
    });
    expect(change.notifications).toEqual([
      expect.objectContaining({
        kind: "opened",
        at: at("09:45:00"),
        message: "agent a_19: out of adherence for 10 min (rule: out of adherence for 10 min)",
      }),
    ]);
  });

  it("follows up on an open incident with what changed, and schedules the next", () => {
    const change = onTimer({
      rule: breachRule(),
      incident: openIncident(),
      state: queueState({ longest_wait_sec: 240 }),
      at: at("09:45:00"),
    });

    expect(change.next).toMatchObject({
      follow_ups: 1,
      last_notified_at: at("09:45:00"),
      next_due_at: at("10:00:00"),
    });
    expect(change.notifications).toEqual([
      expect.objectContaining({
        kind: "follow_up",
        seq: 1,
        at: at("09:45:00"),
        message: "queue billing: still true after 15 min: SLA used 200% (was SLA used 108.3%)",
      }),
    ]);
  });

  it("says no '(was …)' when the value has not changed as written", () => {
    // 108.31 and 108.33 both read "108.3%": a change too small to show is not reported.
    const change = onTimer({
      rule: breachRule(),
      incident: openIncident({ opened_values: { sla_pct: 108.31 } }),
      state: queueState(),
      at: at("09:45:00"),
    });

    expect(change.notifications[0]?.message).toBe(
      "queue billing: still true after 15 min: SLA used 108.3%",
    );
  });

  it("closes a settling incident once the settle time has passed", () => {
    const settling = openIncident({ status: "settling", next_due_at: at("10:20:00") });
    const change = onTimer({
      rule: breachRule(),
      incident: settling,
      state: queueState({ longest_wait_sec: 90 }),
      at: at("10:20:00"),
    });

    expect(change.next).toMatchObject({
      status: "closed",
      closed_at: at("10:20:00"),
      next_due_at: null,
    });
    expect(change.notifications).toEqual([
      expect.objectContaining({
        kind: "closed",
        message: "queue billing: no longer true after 50 min: SLA used 75%",
      }),
    ]);
  });

  it("refuses a closed incident", () => {
    const closed = openIncident({ status: "closed" });
    expect(() =>
      onTimer({ rule: breachRule(), incident: closed, state: queueState(), at: BREACH_SEEN }),
    ).toThrow("is closed");
  });
});
