// The words in a notification. Every phrase is built from the catalog's labels,
// so a new field reads properly in messages without touching this file.

import { type Field, type FieldValue, type SubjectState, findField } from "../shared/catalog.ts";
import { type Condition, type Rule, stateKindOf } from "../shared/rule.ts";

/** The tested fields' values now, by field name. An incident keeps these from when it opened. */
export function seenValues(rule: Rule, state: SubjectState): Record<string, FieldValue> {
  return Object.fromEntries(uniqueFields(rule).map((field) => [field.name, field.read(state)]));
}

/** Tested field values in words: "SLA used 108.3%", "state on_call", "out of adherence". */
export function describeValues(rule: Rule, values: Record<string, FieldValue>): string {
  return uniqueFields(rule)
    .map((field) => describeValue(field, values[field.name] ?? null))
    .join(", ");
}

/** The tested fields as they are now, in words. */
export function describeSeen(rule: Rule, state: SubjectState): string {
  return describeValues(rule, seenValues(rule, state));
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
  if (op === "in") return `${field.label} is ${value.join(" or ")}`;
  const words = { ">": "above", ">=": "at least", "<": "below", "<=": "at most", "=": "is" }[op];
  return `${field.label} ${words} ${String(value)}${field.unit ?? ""}`;
}

function describeValue(field: Field, value: FieldValue): string {
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
