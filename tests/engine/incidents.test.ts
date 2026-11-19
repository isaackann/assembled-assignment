import { describe, expect, it } from "vitest";

import { type Incident, type IncidentInput, stepIncident } from "../../src/engine/incidents.ts";
import { at, breachRule, queueState } from "../testHelpers.ts";

const BREACH_SEEN = at("09:30:00");

function base(overrides: Partial<IncidentInput> = {}): IncidentInput {
  return {
    rule: breachRule(),
    queue: queueState(),
    holds: true,
    live: null,
    startedAt: BREACH_SEEN,
    now: BREACH_SEEN,
    ...overrides,
  };
}

describe("stepIncident", () => {
  it("opens an incident and notifies the rule's owner when the rule becomes true", () => {
    expect(stepIncident(base())).toEqual({
      incident: {
        rule_id: "rule_billing_sla_breached",
        subject_id: "billing",
        status: "open",
        started_at: BREACH_SEEN,
        opened_at: BREACH_SEEN,
      },
      notifications: [
        {
          recipient_id: "lead_1",
          kind: "opened",
          seq: 0,
          at: BREACH_SEEN,
          message: "queue billing: sla_pct is 108.3 (rule: sla_pct > 100)",
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

  it("does nothing when the rule is true and the incident is already open", () => {
    const live: Incident = { ...stepIncident(base())!.incident, id: 1 };

    expect(stepIncident(base({ live }))).toBeNull();
  });

  it("does nothing when the rule is false", () => {
    expect(stepIncident(base({ holds: false }))).toBeNull();
  });

  it("stamps the notification with evaluation time, not the time the condition started", () => {
    const later = BREACH_SEEN + 30 * 60 * 1000;
    const change = stepIncident(base({ now: later }));

    expect(change?.incident).toMatchObject({ started_at: BREACH_SEEN, opened_at: later });
    expect(change?.notifications[0]?.at).toBe(later);
  });
});
