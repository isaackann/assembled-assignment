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

import { randomUUID } from "node:crypto";

import express from "express";

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

export function createApiApp(db: Db, clock: Clock): express.Express {
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
