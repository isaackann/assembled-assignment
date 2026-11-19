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
// The type rules out an operator and value that disagree, but rules arrive as JSON,
// so a mismatch is checked again here and throws: it must never quietly read as false.
function conditionHolds(condition: Condition, actual: FieldValue): boolean {
  const { op, value } = condition;
  const invalid = (needs: string) =>
    new Error(`Operator "${op}" needs ${needs} (${condition.field})`);

  switch (op) {
    case "=":
      if (Array.isArray(value)) throw invalid("a single value, not a list");
      return actual === value;
    case "in":
      if (!Array.isArray(value)) throw invalid("a list of text values");
      if (actual === null) return false;
      if (typeof actual !== "string") throw invalid("a text field");
      return value.includes(actual);
    case ">":
    case ">=":
    case "<":
    case "<=":
      if (typeof value !== "number") throw invalid("a number value");
      if (actual === null) return false;
      if (typeof actual !== "number") throw invalid("a number field");
      if (op === ">") return actual > value;
      if (op === ">=") return actual >= value;
      if (op === "<") return actual < value;
      return actual <= value;
    default:
      throw new Error(`Unknown operator "${String(op)}"`);
  }
}
