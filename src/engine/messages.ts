// The words in a notification. Every phrase is built from the catalog's labels,
// so a new field reads properly in messages without touching this file.

import { type Field, type SubjectState, findField } from "../shared/catalog.ts";
import { type Condition, type Rule, stateKindOf } from "../shared/rule.ts";

/** The tested fields as they are now: "SLA used 108.3%", "state on_call", "out of adherence". */
export function describeSeen(rule: Rule, state: SubjectState): string {
  const fields = uniqueFields(rule);
  return fields.map((field) => describeValue(field, field.read(state))).join(", ");
}

/** What the rule asks for: "SLA used above 100%", "state is on_call for 45 min". */
export function describeRule(rule: Rule): string {
  const asked = rule.conditions
    .map((c) => describeCondition(findField(stateKindOf(rule.subject), c.field), c))
    .join(" and ");
  return rule.for_seconds > 0 ? `${asked} for ${minutes(rule.for_seconds * 1000)} min` : asked;
}

function describeCondition(field: Field, condition: Condition): string {
  const { op, value } = condition;
  if (field.type === "boolean" && op === "=")
    return value === true ? field.label : `not ${field.label}`;
  if (op === "in" && Array.isArray(value)) return `${field.label} is ${value.join(" or ")}`;
  const words = {
    ">": "above",
    ">=": "at least",
    "<": "below",
    "<=": "at most",
    "=": "is",
    in: "in",
  }[op];
  return `${field.label} ${words} ${String(value)}${field.unit ?? ""}`;
}

function describeValue(field: Field, value: unknown): string {
  if (value === null) return `${field.label} unknown`;
  if (field.type === "boolean") return value ? field.label : `not ${field.label}`;
  if (typeof value === "number")
    return `${field.label} ${Number(value.toFixed(1))}${field.unit ?? ""}`;
  return `${field.label} ${String(value)}`;
}

/** Each field once, in the order the rule names them (a band names sla_pct twice). */
function uniqueFields(rule: Rule): Field[] {
  const names = [...new Set(rule.conditions.map((c) => c.field))];
  return names.map((name) => findField(stateKindOf(rule.subject), name));
}

export function minutes(ms: number): number {
  return Math.round(ms / 60_000);
}
