import { describe, expect, it } from "vitest";

import { evaluateRule, ruleCovers } from "../../src/engine/evaluate.ts";
import type { Condition } from "../../src/shared/rule.ts";
import { adherenceRule, agentState, at, breachRule, queueState } from "../testHelpers.ts";

const TEAM_1 = ["a_07", "a_19", "a_31", "a_42"];

describe("ruleCovers", () => {
  it("covers a queue the rule names, and no other", () => {
    expect(ruleCovers(breachRule(), "billing", [])).toBe(true);
    expect(ruleCovers(breachRule(), "tier_2", [])).toBe(false);
  });

  it("covers each agent an agent rule names (an agent's own rule names just them)", () => {
    const rule = adherenceRule({ subject: { kind: "agent", resource_ids: ["a_19", "a_88"] } });

    expect(ruleCovers(rule, "a_19", [])).toBe(true);
    expect(ruleCovers(rule, "a_88", [])).toBe(true);
    expect(ruleCovers(rule, "a_23", [])).toBe(false);
  });

  it("covers the agents on the rule's teams, as the caller read them from the directory", () => {
    expect(ruleCovers(adherenceRule(), "a_19", TEAM_1)).toBe(true);
    expect(ruleCovers(adherenceRule(), "a_88", TEAM_1)).toBe(false);
  });

  it("a team rule does not cover an agent on none of its teams", () => {
    expect(ruleCovers(adherenceRule(), "a_19", [])).toBe(false);
  });

  it("covers nothing when it names nothing", () => {
    expect(
      ruleCovers(breachRule({ subject: { kind: "queue", resource_ids: [] } }), "billing", []),
    ).toBe(false);
  });
});

describe("evaluateRule on a queue", () => {
  const holds = (rule = breachRule(), queue = queueState()) => evaluateRule(rule, queue).holds;

  it("holds when the longest wait is past the SLA target", () => {
    expect(holds(breachRule(), queueState({ longest_wait_sec: 130 }))).toBe(true);
  });

  it("does not hold at exactly the SLA target: breached means exceeded", () => {
    expect(holds(breachRule(), queueState({ longest_wait_sec: 120 }))).toBe(false);
  });

  it("does not hold for a queue with no SLA target, where sla_pct is unknown", () => {
    expect(holds(breachRule(), queueState({ sla_target_sec: 0 }))).toBe(false);
  });

  it("needs every condition to hold", () => {
    const rule = breachRule({
      conditions: [
        { field: "sla_pct", op: ">", value: 100 },
        { field: "tickets_waiting", op: ">", value: 20 },
      ],
    });

    expect(holds(rule, queueState({ tickets_waiting: 18 }))).toBe(false);
    expect(holds(rule, queueState({ tickets_waiting: 22 }))).toBe(true);
  });

  it.each([
    [">", 18, false],
    [">=", 18, true],
    ["<", 18, false],
    ["<=", 18, true],
    ["<", 19, true],
  ] as const)("compares tickets_waiting 18 %s %d", (op, value, expected) => {
    const rule = breachRule({ conditions: [{ field: "tickets_waiting", op, value }] });
    expect(holds(rule, queueState({ tickets_waiting: 18 }))).toBe(expected);
  });

  it("has no start time: queue fields do not say when a value began", () => {
    expect(evaluateRule(breachRule(), queueState())).toEqual({ holds: true, since: null });
  });

  it("throws on a field the catalog does not have", () => {
    const rule = breachRule({ conditions: [{ field: "sla_percent", op: ">", value: 100 }] });
    expect(() => holds(rule)).toThrow('Unknown queue field "sla_percent"');
  });

  it("throws on an operator it does not know", () => {
    const typo = { field: "sla_pct", op: "=>", value: 100 } as unknown as Condition;
    expect(() => holds(breachRule({ conditions: [typo] }))).toThrow('Unknown operator "=>"');
  });
});

describe("evaluateRule on an agent", () => {
  it("tests yes/no with '=' and takes the feed's violation start as since", () => {
    expect(evaluateRule(adherenceRule(), agentState())).toEqual({
      holds: true,
      since: at("09:35:00"),
    });
    expect(evaluateRule(adherenceRule(), agentState({ in_violation: false })).holds).toBe(false);
  });

  it("tests a state with '=' and takes the state's start as since", () => {
    const rule = adherenceRule({ conditions: [{ field: "state", op: "=", value: "on_call" }] });
    const onCall = agentState({ state: "on_call", state_since: at("09:10:00") });

    expect(evaluateRule(rule, onCall)).toEqual({ holds: true, since: at("09:10:00") });
    expect(evaluateRule(rule, agentState({ state: "on_break" })).holds).toBe(false);
  });

  it("tests a state with 'in'", () => {
    const rule = adherenceRule({
      conditions: [{ field: "state", op: "in", value: ["on_break", "in_meeting"] }],
    });

    expect(evaluateRule(rule, agentState({ state: "in_meeting" })).holds).toBe(true);
    expect(evaluateRule(rule, agentState({ state: "on_call" })).holds).toBe(false);
  });

  it("with several conditions, holds since the latest of their starts", () => {
    const rule = adherenceRule({
      conditions: [
        { field: "state", op: "=", value: "on_break" },
        { field: "in_violation", op: "=", value: true },
      ],
    });
    const agent = agentState({ state_since: at("09:35:00"), violation_since: at("09:40:00") });

    expect(evaluateRule(rule, agent)).toEqual({ holds: true, since: at("09:40:00") });
  });

  it.each([false, true])("does not backdate with an unknown start, reversed order: %s", (reverse) => {
    const rule = adherenceRule({ conditions: [
      { field: "state", op: "=", value: "on_call" },
      { field: "in_violation", op: "=", value: false },
    ] });
    if (reverse) rule.conditions.reverse();
    expect(evaluateRule(rule, agentState({
      state: "on_call", state_since: at("09:00:00"),
      in_violation: false, violation_since: null,
    }))).toEqual({ holds: true, since: null });
  });

  it("throws when a number comparison names a text field", () => {
    const rule = adherenceRule({ conditions: [{ field: "state", op: ">", value: 3 }] });
    expect(() => evaluateRule(rule, agentState())).toThrow('Operator ">" needs a number');
  });
});
