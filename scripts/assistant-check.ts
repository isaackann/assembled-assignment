// Command line: node scripts/assistant-check.ts
// Checks how well the real model turns sentences into rules: a fixed list of
// sentences, each with the rule a person would expect, sent to OpenAI with the key
// and model in .env. Not part of `npm test`: it needs a key, costs a little, and a
// model's answers can change. Prints each sentence as PASS or FAIL with what came back.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { draftRule, openAiAsker } from "../src/assistant/assistant.ts";
import type { Directory } from "../src/shared/directory.ts";
import type { Condition } from "../src/shared/rule.ts";
import type { RuleDraft } from "../src/shared/validate.ts";

interface Case {
  owner: string;
  sentence: string;
  /** The rule a person would expect, or "unsupported" when no rule can say it. */
  expected: Omit<RuleDraft, "owner_id"> | "unsupported";
}

const CASES: Case[] = [
  {
    owner: "a_19",
    sentence: "notify me when I've been out of adherence for more than ten minutes",
    expected: {
      subject: { kind: "agent", resource_ids: ["a_19"] },
      conditions: [{ field: "in_violation", op: "=", value: true }],
      for_seconds: 600,
    },
  },
  {
    owner: "lead_1",
    sentence: "tell me when the billing queue has more than 20 tickets waiting",
    expected: {
      subject: { kind: "queue", resource_ids: ["billing"] },
      conditions: [{ field: "tickets_waiting", op: ">", value: 20 }],
      for_seconds: 0,
    },
  },
  {
    owner: "lead_1",
    sentence: "ping me if any of my agents has been on a single call for over 45 minutes",
    expected: {
      subject: { kind: "team", resource_ids: ["team_1"] },
      conditions: [{ field: "state", op: "=", value: "on_call" }],
      for_seconds: 2700,
    },
  },
  {
    owner: "lead_2",
    sentence: "let me know whenever one of my agents goes on break",
    expected: {
      subject: { kind: "team", resource_ids: ["team_2"] },
      conditions: [{ field: "state", op: "=", value: "on_break" }],
      for_seconds: 0,
    },
  },
  {
    owner: "lead_1",
    sentence: "warn me when tier 2 is close to breaching its SLA",
    expected: {
      subject: { kind: "queue", resource_ids: ["tier_2"] },
      conditions: [
        { field: "sla_pct", op: ">=", value: 80 },
        { field: "sla_pct", op: "<=", value: 100 },
      ],
      for_seconds: 0,
    },
  },
  {
    owner: "lead_1",
    sentence: "tell me when billing or vip breach SLA",
    expected: {
      subject: { kind: "queue", resource_ids: ["billing", "vip"] },
      conditions: [{ field: "sla_pct", op: ">", value: 100 }],
      for_seconds: 0,
    },
  },
  {
    owner: "lead_1",
    sentence: "tell me when three of my agents are on break at the same time",
    expected: "unsupported",
  },
];

/** The same rule written two ways compares equal: `in` with one value is `=`, order ignored. */
function normal(rule: Omit<RuleDraft, "owner_id">): string {
  const conditions = rule.conditions
    .map((c): Condition =>
      c.op === "in" && c.value.length === 1 ? { ...c, op: "=", value: c.value[0]! } : c,
    )
    .map((c) => JSON.stringify(c))
    .sort();
  return JSON.stringify({
    subject: { kind: rule.subject.kind, resource_ids: [...rule.subject.resource_ids].sort() },
    conditions,
    for_seconds: rule.for_seconds,
  });
}

if (import.meta.main) {
  process.loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url)));
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL;
  if (!apiKey || !model) {
    console.error("Set OPENAI_API_KEY and OPENAI_MODEL in .env");
    process.exit(1);
  }
  const directory: Directory = JSON.parse(
    readFileSync(new URL("../data/directory.json", import.meta.url), "utf8"),
  );

  let passed = 0;
  for (const { owner, sentence, expected } of CASES) {
    const drafted = await draftRule(sentence, owner, directory, model, openAiAsker(apiKey));
    // Our own messages start "The assistant" (an API error, a refusal, a rule that failed
    // validation). Only the model's own reason counts as it saying "this cannot be a rule".
    const ourError = !drafted.ok && drafted.errors[0]!.startsWith("The assistant");
    if (ourError && /failed:|did not finish/.test(drafted.errors[0]!)) {
      console.error(`Stopped: ${drafted.errors[0]}`);
      process.exit(1);
    }
    const got = drafted.ok ? normal(drafted.draft) : drafted.errors.join("; ");
    const pass =
      expected === "unsupported"
        ? !drafted.ok && !ourError
        : drafted.ok && got === normal(expected);
    if (pass) passed += 1;
    console.log(`${pass ? "PASS" : "FAIL"}  ${owner}: "${sentence}"`);
    if (!pass || expected === "unsupported") console.log(`      got ${got}`);
  }
  console.log(`\n${passed} of ${CASES.length} as expected (${model}).`);
}
