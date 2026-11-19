// validateRule: what the API accepts. A rule that passes must evaluate without
// throwing; anything else comes back as a list of reasons a person can act on.

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { Directory } from "../../src/shared/directory.ts";
import type { Rule } from "../../src/shared/rule.ts";
import { validateRule } from "../../src/shared/validate.ts";

const readData = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../data/${name}`, import.meta.url), "utf8"));
const directory: Directory = readData("directory.json");

/** lead_1: any of my agents goes on break. */
const breakDraft = () => ({
  owner_id: "lead_1",
  subject: { kind: "team", resource_ids: ["team_1"] },
  conditions: [{ field: "state", op: "=", value: "on_break" }],
  for_seconds: 0,
});

const errorsOf = (input: unknown): string[] => {
  const result = validateRule(input, directory);
  return result.ok ? [] : result.errors;
};

describe("validateRule", () => {
  it("accepts every shipped seed rule", () => {
    const seeds: Rule[] = readData("rules.seed.json");
    for (const { id: _id, ...draft } of seeds) {
      expect(errorsOf(draft)).toEqual([]);
    }
  });

  it("returns a clean copy, without fields the rule does not have", () => {
    const result = validateRule({ ...breakDraft(), id: "chosen_by_client", extra: 1 }, directory);

    expect(result).toEqual({ ok: true, draft: breakDraft() });
  });

  it("rejects an operator the field's type does not allow", () => {
    const draft = breakDraft();
    draft.conditions = [{ field: "state", op: ">", value: "on_break" }];

    expect(errorsOf(draft)).toEqual(['Condition 1: ">" cannot be used on state (use =, in)']);
  });

  it("rejects a value of the wrong type for its field", () => {
    expect(
      errorsOf({
        ...breakDraft(),
        conditions: [{ field: "in_violation", op: "=", value: "yes" }],
      }),
    ).toEqual(["Condition 1: out of adherence needs true or false"]);
    expect(
      errorsOf({
        owner_id: "lead_1",
        subject: { kind: "queue", resource_ids: ["billing"] },
        conditions: [{ field: "sla_pct", op: ">", value: "100" }],
        for_seconds: 0,
      }),
    ).toEqual(["Condition 1: SLA used needs a number"]);
  });

  it("rejects a state the catalog does not list, so a typo cannot silently never fire", () => {
    expect(
      errorsOf({ ...breakDraft(), conditions: [{ field: "state", op: "=", value: "on_brake" }] }),
    ).toEqual(["Condition 1: state has no value on_brake"]);
    expect(
      errorsOf({
        ...breakDraft(),
        conditions: [{ field: "state", op: "in", value: ["on_break", "lunch"] }],
      }),
    ).toEqual(["Condition 1: state has no value lunch"]);
  });

  it("rejects a field from the other kind of subject", () => {
    expect(
      errorsOf({ ...breakDraft(), conditions: [{ field: "sla_pct", op: ">", value: 100 }] }),
    ).toEqual(['Condition 1: agent rules have no field "sla_pct"']);
  });

  it("rejects ids the directory does not know", () => {
    expect(errorsOf({ ...breakDraft(), owner_id: "lead_9" })).toEqual(['Unknown owner "lead_9"']);
    expect(
      errorsOf({
        ...breakDraft(),
        subject: { kind: "queue", resource_ids: ["billing", "refunds"] },
      }),
    ).toEqual(["Unknown queue: refunds"]);
    expect(
      errorsOf({ ...breakDraft(), subject: { kind: "team", resource_ids: ["team_9"] } }),
    ).toEqual(["Unknown team: team_9"]);
  });

  it("rejects an empty subject, no conditions and a bad for_seconds, all at once", () => {
    expect(
      errorsOf({
        owner_id: "a_19",
        subject: { kind: "agent", resource_ids: [] },
        conditions: [],
        for_seconds: 1.5,
      }),
    ).toEqual([
      "A rule on agents must name at least one agent",
      "A rule needs at least one condition",
      "for_seconds must be a whole number of seconds, 0 or more",
    ]);
  });

  it("rejects something that is not a rule at all", () => {
    expect(errorsOf(null)).toEqual(["A rule must be an object"]);
    expect(errorsOf([])).toEqual(["A rule must be an object"]);
  });
});
