// Answers: does the rule cover this queue, and do all of its conditions hold right now?
// Rules are not validated on the way in yet, so throws on invalid rules

import { type QueueState, readQueueField } from "../shared/catalog.ts";
import type { Condition, Rule } from "../shared/rule.ts";

/** Whether the rule's scope includes this queue. */
export function ruleCoversQueue(rule: Rule, queueId: string): boolean {
  if (rule.subject !== "queue" || rule.scope.kind !== "queues") {
    throw new Error(`Rule ${rule.id}: unsupported subject or scope`);
  }
  return rule.scope.queue_ids.includes(queueId);
}

/** Whether every condition of the rule holds for this queue. */
export function conditionsHold(rule: Rule, queue: QueueState): boolean {
  return rule.conditions.every((condition) => conditionHolds(condition, queue));
}

// A field with no value (for example sla_pct on a queue with no SLA target) matches nothing.
function conditionHolds(condition: Condition, queue: QueueState): boolean {
  const actual = readQueueField(condition.field, queue);
  if (actual === null) return false;

  switch (condition.op) {
    case ">":
      return actual > condition.value;
    case ">=":
      return actual >= condition.value;
    case "<":
      return actual < condition.value;
    case "<=":
      return actual <= condition.value;
    default:
      throw new Error(`Unknown operator "${String(condition.op)}"`);
  }
}
