// Turns a sentence ("ping me if any of my agents is on a call for 45 minutes") into a
// draft rule for the form. The model is given the field catalog, the directory and who
// is asking, and must answer in the rule's own shape (a strict JSON schema). Its answer
// goes through validateRule like any form submission, and nothing is saved: the
// person reviews the filled-in form and saves it themselves. The model is never
// involved in evaluating events.

import { OPERATORS, listFields } from "../shared/catalog.ts";
import type { Directory } from "../shared/directory.ts";
import { type RuleDraft, validateRule } from "../shared/validate.ts";

/** Sends one request body to the model and resolves to its raw HTTP response body. */
export type AskModel = (request: ModelRequest) => Promise<unknown>;

/** The request body for OpenAI's Responses API. */
export interface ModelRequest {
  model: string;
  input: { role: "system" | "user"; content: string }[];
  text: { format: { type: "json_schema"; name: string; strict: true; schema: object } };
}

/** A draft for the form, or why there is none. */
export type Drafted = { ok: true; draft: RuleDraft } | { ok: false; errors: string[] };

/**
 * The model's answer, in the rule's shape minus the owner (always the person asking).
 * `unsupported` is set instead when the sentence asks for something a rule cannot say.
 */
const ANSWER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["unsupported", "subject", "conditions", "for_seconds"],
  properties: {
    unsupported: { type: ["string", "null"] },
    subject: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "resource_ids"],
      properties: {
        kind: { type: "string", enum: ["queue", "agent", "team"] },
        resource_ids: { type: "array", items: { type: "string" } },
      },
    },
    conditions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["field", "op", "value"],
        properties: {
          field: { type: "string" },
          op: { type: "string", enum: [">", ">=", "<", "<=", "=", "in"] },
          value: {
            anyOf: [
              { type: "number" },
              { type: "string" },
              { type: "boolean" },
              { type: "array", items: { type: "string" } },
            ],
          },
        },
      },
    },
    for_seconds: { type: "integer" },
  },
};

/** Asks the model for a rule matching `sentence`, owned by `ownerId`, and checks it. */
export async function draftRule(
  sentence: string,
  ownerId: string,
  directory: Directory,
  model: string,
  ask: AskModel,
): Promise<Drafted> {
  const response = await ask(buildRequest(sentence, ownerId, directory, model));
  const text = answerText(response);
  if (!text.ok) return { ok: false, errors: [text.error] };

  let answer: Record<string, unknown>;
  try {
    answer = JSON.parse(text.text);
  } catch {
    return { ok: false, errors: ["The assistant's answer was not valid JSON"] };
  }
  if (typeof answer.unsupported === "string") return { ok: false, errors: [answer.unsupported] };

  const { unsupported: _unsupported, ...rule } = answer;
  const checked = validateRule({ ...rule, owner_id: ownerId }, directory);
  if (!checked.ok) {
    return { ok: false, errors: checked.errors.map((e) => `The assistant's rule: ${e}`) };
  }
  return checked;
}

/** The request: what a rule is, what it can test, who exists, and who is asking. */
export function buildRequest(
  sentence: string,
  ownerId: string,
  directory: Directory,
  model: string,
): ModelRequest {
  return {
    model,
    input: [
      { role: "system", content: instructions(ownerId, directory) },
      { role: "user", content: sentence },
    ],
    text: { format: { type: "json_schema", name: "rule", strict: true, schema: ANSWER_SCHEMA } },
  };
}

function instructions(ownerId: string, directory: Directory): string {
  const fieldLines = (kind: "queue" | "agent") =>
    listFields(kind)
      .map((field) => {
        const values = field.values ? `; values: ${field.values.join(", ")}` : "";
        const unit = field.unit ? ` (${field.unit})` : "";
        return `- ${field.name}: ${field.label}${unit}, ${field.type}; operators: ${OPERATORS[field.type].join(" ")}${values}`;
      })
      .join("\n");
  const ownTeam = directory.teams.find((team) => team.lead_id === ownerId);
  const memberOf = directory.teams.find((team) => team.agent_ids.includes(ownerId));
  const who = ownTeam
    ? `${ownerId} is the lead of ${ownTeam.id}. "My agents" or "my team" means a team rule naming ${ownTeam.id}.`
    : memberOf
      ? `${ownerId} is an agent on ${memberOf.id}. "Me" or "I" means an agent rule naming ${ownerId}.`
      : `${ownerId} is not on any team.`;

  return `You turn one sentence from a contact-center team lead or agent into a notification rule.
The person asking is ${ownerId}; they receive the rule's notifications. ${who}

A rule watches a subject and fires when all of its conditions hold for at least for_seconds:
- subject.kind "queue": resource_ids are queue ids. Conditions use queue fields.
- subject.kind "agent": resource_ids are agent ids. Conditions use agent fields.
- subject.kind "team": resource_ids are team ids; it watches every agent on those teams. Conditions use agent fields.
- for_seconds: how long the conditions must hold first (10 minutes = 600). 0 fires as soon as they hold.
  It counts from when the current value began: every new call starts a new on_call, so "on a single call for 45 minutes" is state = on_call for 2700 seconds.

Queue fields:
${fieldLines("queue")}
Agent fields:
${fieldLines("agent")}

Value types: number fields take a number; "in" takes a list of text values; "=" takes one value of the field's type.
"Near" or "at risk of" breaching SLA means sla_pct >= 80 and sla_pct <= 100. "Breached" means sla_pct > 100.

Queues: ${directory.queues.join(", ")}
Teams: ${directory.teams.map((team) => `${team.id} (lead ${team.lead_id}; agents ${team.agent_ids.join(", ")})`).join("; ")}

If the sentence cannot be expressed this way (for example counts like "three agents at once", trends, or two different subjects in one rule), set unsupported to a short reason in plain words and fill the other fields with any valid placeholder. Otherwise set unsupported to null.`;
}

/** The answer's text from a Responses API body, or why there is none. */
function answerText(response: unknown): { ok: true; text: string } | { ok: false; error: string } {
  const body = response as {
    status?: string;
    error?: { message?: string } | null;
    output?: { type?: string; content?: { type?: string; text?: string; refusal?: string }[] }[];
  };
  if (body?.error?.message)
    return { ok: false, error: `The assistant failed: ${body.error.message}` };
  if (body?.status && body.status !== "completed") {
    return { ok: false, error: `The assistant did not finish (${body.status})` };
  }
  const parts = (body?.output ?? [])
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content ?? []);
  const refusal = parts.find((part) => part.type === "refusal");
  if (refusal) return { ok: false, error: `The assistant declined: ${refusal.refusal ?? ""}` };
  const text = parts.find((part) => part.type === "output_text")?.text;
  return text ? { ok: true, text } : { ok: false, error: "The assistant gave no answer" };
}

/** Calls OpenAI's Responses API over HTTP. */
export function openAiAsker(apiKey: string): AskModel {
  return async (request) => {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(30_000),
    });
    return response.json();
  };
}
