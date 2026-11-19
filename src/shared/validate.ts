// Checks a rule that arrives from outside (the API, the form, the assistant) before
// it is saved. A rule that passes can be evaluated without throwing: every field is
// in the catalog, every operator suits its field's type, every value suits its
// operator, and every id names something in the directory. Every problem is
// reported, not just the first, so the form can show them all at once.

import { type Field, OPERATORS, lookupField } from "./catalog.ts";
import type { Directory } from "./directory.ts";
import { type Condition, type Rule, type Subject, stateKindOf } from "./rule.ts";

/** A rule as a client sends it: everything but the id, which the server gives it. */
export type RuleDraft = Omit<Rule, "id">;

/** The result of checking a draft: a clean copy of it, or every problem found. */
export type Validated = { ok: true; draft: RuleDraft } | { ok: false; errors: string[] };

type Raw = Record<string, unknown>;

const SUBJECT_KINDS: Subject["kind"][] = ["queue", "agent", "team"];

/** Checks a draft rule against the catalog and the directory. */
export function validateRule(input: unknown, directory: Directory): Validated {
  if (!isObject(input)) return { ok: false, errors: ["A rule must be an object"] };

  const errors: string[] = [];
  const people = peopleOf(directory);

  const owner = input.owner_id;
  if (typeof owner !== "string" || !people.includes(owner)) {
    errors.push(`Unknown owner "${String(owner)}"`);
  }

  const subject = checkSubject(input.subject, directory, errors);

  const conditions: Condition[] = [];
  if (!Array.isArray(input.conditions) || input.conditions.length === 0) {
    errors.push("A rule needs at least one condition");
  } else if (subject) {
    input.conditions.forEach((raw, index) => {
      const condition = checkCondition(raw, subject, `Condition ${index + 1}`, errors);
      if (condition) conditions.push(condition);
    });
  }

  const forSeconds = input.for_seconds;
  if (typeof forSeconds !== "number" || !Number.isInteger(forSeconds) || forSeconds < 0) {
    errors.push("for_seconds must be a whole number of seconds, 0 or more");
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    draft: {
      owner_id: owner as string,
      subject: subject!,
      conditions,
      for_seconds: forSeconds as number,
    },
  };
}

/** Everyone who can own a rule: every lead and every agent. */
export function peopleOf(directory: Directory): string[] {
  return directory.teams.flatMap((team) => [team.lead_id, ...team.agent_ids]);
}

function checkSubject(raw: unknown, directory: Directory, errors: string[]): Subject | null {
  if (!isObject(raw)) {
    errors.push("A rule needs a subject: { kind, resource_ids }");
    return null;
  }
  const kind = raw.kind as Subject["kind"];
  if (!SUBJECT_KINDS.includes(kind)) {
    errors.push(`Subject kind must be queue, agent or team, not "${String(raw.kind)}"`);
    return null;
  }
  const ids = raw.resource_ids;
  if (!Array.isArray(ids) || ids.length === 0) {
    errors.push(`A rule on ${kind}s must name at least one ${kind}`);
    return null;
  }
  const known =
    kind === "queue"
      ? directory.queues
      : kind === "team"
        ? directory.teams.map((team) => team.id)
        : directory.teams.flatMap((team) => team.agent_ids);
  const unknown = ids.filter((id) => typeof id !== "string" || !known.includes(id));
  if (unknown.length > 0) {
    errors.push(`Unknown ${kind}: ${unknown.map(String).join(", ")}`);
    return null;
  }
  return { kind, resource_ids: [...new Set(ids as string[])] };
}

function checkCondition(
  raw: unknown,
  subject: Subject,
  where: string,
  errors: string[],
): Condition | null {
  if (!isObject(raw)) {
    errors.push(`${where} must be { field, op, value }`);
    return null;
  }
  const kind = stateKindOf(subject);
  const field = typeof raw.field === "string" ? lookupField(kind, raw.field) : null;
  if (!field) {
    errors.push(`${where}: ${kind} rules have no field "${String(raw.field)}"`);
    return null;
  }
  const op = raw.op as Condition["op"];
  if (!OPERATORS[field.type].includes(op)) {
    errors.push(
      `${where}: "${String(raw.op)}" cannot be used on ${field.label} (use ${OPERATORS[field.type].join(", ")})`,
    );
    return null;
  }
  const problem = valueProblem(field, op, raw.value);
  if (problem) {
    errors.push(`${where}: ${problem}`);
    return null;
  }
  return { field: field.name, op, value: raw.value } as Condition;
}

/** Why a value does not suit its field and operator, or null when it does. */
function valueProblem(field: Field, op: Condition["op"], value: unknown): string | null {
  if (op === "in") {
    if (!Array.isArray(value) || value.length === 0) return `${field.label} needs a list of values`;
    const bad = value.filter((item) => !allowedText(field, item));
    return bad.length > 0 ? `${field.label} has no value ${bad.map(String).join(", ")}` : null;
  }
  if (field.type === "number") {
    return typeof value === "number" && Number.isFinite(value)
      ? null
      : `${field.label} needs a number`;
  }
  if (field.type === "boolean") {
    return typeof value === "boolean" ? null : `${field.label} needs true or false`;
  }
  return allowedText(field, value) ? null : `${field.label} has no value ${String(value)}`;
}

function allowedText(field: Field, value: unknown): boolean {
  return typeof value === "string" && (!field.values || field.values.includes(value));
}

function isObject(value: unknown): value is Raw {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
