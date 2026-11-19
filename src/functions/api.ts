// The config API: the deployed function behind the rules page. People create, list
// and delete their rules, and read the notifications sent to them. The page (and
// the assistant, later) send rules here; every rule is checked by validateRule
// before it is saved. A rule notifies its owner, so "my notifications" is a filter
// on recipient.
//
// No login: authentication is out of scope, so the caller says who they are
// (`owner_id` on a rule, `?owner=` and `?recipient=` on reads).
//
// A rule saved here applies from its subject's next event; nothing is back-filled.
//
// The assistant (POST /rules/draft) only drafts: it returns a checked rule for the
// form to show, and saves nothing. Without an OpenAI key it is switched off, and
// GET /assistant says so, so the page can explain why.

import { randomUUID } from "node:crypto";

import express from "express";

import { type AskModel, draftRule } from "../assistant/assistant.ts";
import { describeRule } from "../engine/messages.ts";
import { OPERATORS, listFields } from "../shared/catalog.ts";
import type { Rule } from "../shared/rule.ts";
import { validateRule } from "../shared/validate.ts";
import {
  type Db,
  deleteRule,
  getDirectory,
  insertRules,
  listNotifications,
  listRules,
  transaction,
} from "../store/store.ts";
import type { Clock } from "./clock.ts";

/** The model the assistant asks, or null when no key is configured. */
export type Assistant = { model: string; ask: AskModel } | null;

export function createApiApp(db: Db, clock: Clock, assistant: Assistant = null): express.Express {
  const app = express();

  // Who can be named in a rule: queues, teams, and everyone on them.
  app.get("/directory", (_req, res) => {
    res.json(getDirectory(db));
  });

  // What a rule can test, so the form never hard-codes a field or an operator.
  app.get("/catalog", (_req, res) => {
    const fields = (kind: "queue" | "agent") =>
      listFields(kind).map((field) => ({
        name: field.name,
        label: field.label,
        type: field.type,
        unit: field.unit ?? null,
        values: field.values ?? null,
        operators: OPERATORS[field.type],
      }));
    res.json({ queue: fields("queue"), agent: fields("agent") });
  });

  // A person's rules, each with the sentence the notifications use for it.
  app.get("/rules", (req, res) => {
    const owner = req.query.owner;
    if (typeof owner !== "string") return void res.status(400).json({ error: "owner is required" });
    const rules = listRules(db).filter((rule) => rule.owner_id === owner);
    res.json(rules.map((rule) => ({ ...rule, description: describeRule(rule) })));
  });

  app.post("/rules", express.json(), (req, res) => {
    const checked = validateRule(req.body, getDirectory(db));
    if (!checked.ok) return void res.status(400).json({ errors: checked.errors });
    const rule: Rule = { id: `rule_${randomUUID()}`, ...checked.draft };
    insertRules(db, [rule]);
    res.status(201).json({ ...rule, description: describeRule(rule) });
  });

  app.get("/assistant", (_req, res) => {
    res.json({ enabled: assistant !== null });
  });

  // A sentence in, a checked draft out. The person reviews it in the form and saves it.
  app.post("/rules/draft", express.json(), async (req, res) => {
    if (!assistant) return void res.status(503).json({ errors: ["The assistant is not set up"] });
    const { owner_id: ownerId, sentence } = req.body ?? {};
    if (typeof ownerId !== "string" || typeof sentence !== "string" || sentence.trim() === "") {
      return void res.status(400).json({ errors: ["owner_id and a sentence are required"] });
    }
    try {
      const drafted = await draftRule(
        sentence,
        ownerId,
        getDirectory(db),
        assistant.model,
        assistant.ask,
      );
      if (!drafted.ok) return void res.status(422).json({ errors: drafted.errors });
      res.json({ draft: drafted.draft, description: describeRule({ id: "", ...drafted.draft }) });
    } catch (err) {
      res
        .status(502)
        .json({ errors: [`Could not reach the assistant: ${(err as Error).message}`] });
    }
  });

  // Keeps the rule's row for its history; its live incidents close without a message.
  app.delete("/rules/:id", (req, res) => {
    const deleted = transaction(db, () => deleteRule(db, req.params.id, clock.now()));
    res.status(deleted ? 204 : 404).end();
  });

  app.get("/notifications", (req, res) => {
    const recipient = req.query.recipient;
    if (typeof recipient !== "string")
      return void res.status(400).json({ error: "recipient is required" });
    res.json(listNotifications(db, recipient));
  });

  return app;
}
