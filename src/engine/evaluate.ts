// Answers: does the rule watch this queue or agent, do all of its conditions hold right
// now, and since when? Rules are not validated on the way in yet (that is the
// API's job), so an invalid rule throws here.

import { type FieldValue, type SubjectState, findField } from "../shared/catalog.ts";
import { type Condition, type Rule, stateKindOf } from "../shared/rule.ts";

/** Whether the rule holds, and when all its conditions began holding. */
export interface Evaluation {
  holds: boolean;
  /** Null when any condition's start is unknown (queue fields never know). */
  since: number | null;
}

/**
 * Whether the rule watches this queue or agent. A team rule covers the agents on
 * any of its teams, read from the directory when the event arrives
 * (`teamAgentIds`), so it follows the roster as it changes. The caller has already
 * matched what the rule watches (queue or agent) to what the event is about.
 */
export function ruleCovers(rule: Rule, subjectId: string, teamAgentIds: string[]): boolean {
  return rule.subject.kind === "team"
    ? teamAgentIds.includes(subjectId)
    : rule.subject.resource_ids.includes(subjectId);
}

/**
 * Whether every condition holds. When they do, `since` is the latest of their start
 * times, provided every start is known: "on a call and out of adherence" has
 * held only since both became true. Otherwise the caller uses first observation.
 */
export function evaluateRule(rule: Rule, state: SubjectState): Evaluation {
  let since: number | null = null;
  let unknownStart = false;
  for (const condition of rule.conditions) {
    const field = findField(stateKindOf(rule.subject), condition.field);
    if (!conditionHolds(condition, field.read(state))) return { holds: false, since: null };

    const started = field.since?.(state) ?? null;
    if (started === null) unknownStart = true;
    if (started !== null && (since === null || started > since)) since = started;
  }
  return { holds: true, since: unknownStart ? null : since };
}

// A field with no value (for example sla_pct on a queue with no SLA target) matches nothing.
function conditionHolds(condition: Condition, actual: FieldValue): boolean {
  if (actual === null) return false;
  const { op, value } = condition;

  switch (op) {
    case "=":
      return actual === value;
    case "in":
      return Array.isArray(value) && typeof actual === "string" && value.includes(actual);
    case ">":
    case ">=":
    case "<":
    case "<=":
      if (typeof actual !== "number" || typeof value !== "number") {
        throw new Error(
          `Operator "${op}" needs a number field and a number value (${condition.field})`,
        );
      }
      if (op === ">") return actual > value;
      if (op === ">=") return actual >= value;
      if (op === "<") return actual < value;
      return actual <= value;
    default:
      throw new Error(`Unknown operator "${String(op)}"`);
  }
}
