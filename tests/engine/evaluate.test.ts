import { describe, expect, it } from "vitest";

import { conditionsHold, ruleCoversQueue } from "../../src/engine/evaluate.ts";
import type { Condition } from "../../src/shared/rule.ts";
import { breachRule, queueState } from "../testHelpers.ts";

describe("ruleCoversQueue", () => {
  it("covers a queue the scope names", () => {
    expect(ruleCoversQueue(breachRule(), "billing")).toBe(true);
  });

  it("does not cover a queue the scope leaves out", () => {
    expect(ruleCoversQueue(breachRule(), "tier_2")).toBe(false);
  });
});

describe("conditionsHold", () => {
  it("holds when the longest wait is past the SLA target", () => {
    expect(conditionsHold(breachRule(), queueState({ longest_wait_sec: 130 }))).toBe(true);
  });

  it("does not hold at exactly the SLA target: breached means exceeded", () => {
    expect(conditionsHold(breachRule(), queueState({ longest_wait_sec: 120 }))).toBe(false);
  });

  it("does not hold for a queue with no SLA target, where sla_pct is unknown", () => {
    expect(conditionsHold(breachRule(), queueState({ sla_target_sec: 0 }))).toBe(false);
  });

  it("needs every condition to hold", () => {
    const rule = breachRule({
      conditions: [
        { field: "sla_pct", op: ">", value: 100 },
        { field: "tickets_waiting", op: ">", value: 20 },
      ],
    });

    expect(conditionsHold(rule, queueState({ tickets_waiting: 18 }))).toBe(false);
    expect(conditionsHold(rule, queueState({ tickets_waiting: 22 }))).toBe(true);
  });

  it.each([
    [">", 18, false],
    [">=", 18, true],
    ["<", 18, false],
    ["<=", 18, true],
    ["<", 19, true],
  ] as const)("compares tickets_waiting 18 %s %d", (op, value, expected) => {
    const rule = breachRule({ conditions: [{ field: "tickets_waiting", op, value }] });
    expect(conditionsHold(rule, queueState({ tickets_waiting: 18 }))).toBe(expected);
  });

  it("throws on a field the catalog does not have", () => {
    const rule = breachRule({ conditions: [{ field: "sla_percent", op: ">", value: 100 }] });
    expect(() => conditionsHold(rule, queueState())).toThrow('Unknown queue field "sla_percent"');
  });

  it("throws on an operator it does not know", () => {
    const typo = { field: "sla_pct", op: "=>", value: 100 } as unknown as Condition;
    expect(() => conditionsHold(breachRule({ conditions: [typo] }), queueState())).toThrow(
      'Unknown operator "=>"',
    );
  });
});
