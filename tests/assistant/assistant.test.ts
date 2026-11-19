// The assistant with canned model answers: what it sends, and how it treats what
// comes back. Its rule must pass validateRule, belongs to whoever asked, and is never
// saved here. How well a real model translates sentences is checked separately
// (scripts/assistant-check.ts), because it needs a key and is not deterministic.

import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";

import { afterAll, describe, expect, it } from "vitest";

import { type ModelRequest, buildRequest, draftRule } from "../../src/assistant/assistant.ts";
import { createApiApp } from "../../src/functions/api.ts";
import type { Directory } from "../../src/shared/directory.ts";
import { listRules } from "../../src/store/store.ts";
import { seededStore } from "../../scripts/replay.ts";
import { simClock } from "../../scripts/simulate.ts";

const directory: Directory = JSON.parse(
  readFileSync(new URL("../../data/directory.json", import.meta.url), "utf8"),
);

/** A Responses API body whose answer is `answer`, as JSON text. */
const replyWith = (answer: unknown) => ({
  status: "completed",
  output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(answer) }] }],
});

const longCallAnswer = {
  unsupported: null,
  subject: { kind: "team", resource_ids: ["team_1"] },
  conditions: [{ field: "state", op: "=", value: "on_call" }],
  for_seconds: 2700,
};

const canned = (body: unknown) => async () => body;

describe("draftRule", () => {
  it("returns the model's rule, owned by whoever asked, checked by validateRule", async () => {
    const drafted = await draftRule(
      "ping me if any of my agents is on a call for 45 minutes",
      "lead_1",
      directory,
      "test-model",
      canned(replyWith(longCallAnswer)),
    );

    expect(drafted).toEqual({
      ok: true,
      draft: {
        owner_id: "lead_1",
        subject: { kind: "team", resource_ids: ["team_1"] },
        conditions: [{ field: "state", op: "=", value: "on_call" }],
        for_seconds: 2700,
      },
    });
  });

  it("refuses a rule that fails validation, with the reasons", async () => {
    const drafted = await draftRule(
      "tell me when refunds backs up",
      "lead_1",
      directory,
      "test-model",
      canned(
        replyWith({
          ...longCallAnswer,
          subject: { kind: "queue", resource_ids: ["refunds"] },
          conditions: [{ field: "tickets_waiting", op: ">", value: 20 }],
          for_seconds: 0,
        }),
      ),
    );

    expect(drafted).toEqual({
      ok: false,
      errors: ["The assistant's rule: Unknown queue: refunds"],
    });
  });

  it("passes on the model's reason when a sentence cannot be a rule", async () => {
    const drafted = await draftRule(
      "tell me when three of my agents are on break at once",
      "lead_1",
      directory,
      "test-model",
      canned(replyWith({ ...longCallAnswer, unsupported: "Rules cannot count agents." })),
    );

    expect(drafted).toEqual({ ok: false, errors: ["Rules cannot count agents."] });
  });

  it("reports a refusal, an API error, an unfinished answer and broken JSON", async () => {
    const draft = (body: unknown) =>
      draftRule("anything", "lead_1", directory, "test-model", canned(body));

    expect(
      await draft({
        status: "completed",
        output: [{ type: "message", content: [{ type: "refusal", refusal: "No." }] }],
      }),
    ).toEqual({ ok: false, errors: ["The assistant declined: No."] });
    expect(await draft({ error: { message: "Invalid API key" } })).toEqual({
      ok: false,
      errors: ["The assistant failed: Invalid API key"],
    });
    expect(await draft({ status: "incomplete", output: [] })).toEqual({
      ok: false,
      errors: ["The assistant did not finish (incomplete)"],
    });
    expect(
      await draft({
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: "{oops" }] }],
      }),
    ).toEqual({ ok: false, errors: ["The assistant's answer was not valid JSON"] });
  });
});

describe("buildRequest", () => {
  const request: ModelRequest = buildRequest("hello", "lead_1", directory, "test-model");
  const system = request.input[0]!.content;

  it("asks for strict JSON in the rule's shape, with the sentence as the user's turn", () => {
    expect(request.model).toBe("test-model");
    expect(request.text.format).toMatchObject({ type: "json_schema", strict: true });
    expect(request.input[1]).toEqual({ role: "user", content: "hello" });
  });

  it("gives the model the catalog, the directory and who 'my team' is", () => {
    expect(system).toContain("- state: state, string; operators: = in; values: available");
    expect(system).toContain("Queues: billing, tier_2, vip");
    expect(system).toContain('"My agents" or "my team" means a team rule naming team_1');
  });

  it("tells an agent that 'me' is their own agent id", () => {
    const agent = buildRequest("hello", "a_19", directory, "test-model").input[0]!.content;
    expect(agent).toContain('"Me" or "I" means an agent rule naming a_19');
  });
});

describe("the assistant over the config API", () => {
  const db = seededStore();
  const rulesBefore = listRules(db).length;
  const withModel = createApiApp(db, simClock(), {
    model: "test-model",
    ask: canned(replyWith(longCallAnswer)),
  }).listen(0);
  const withoutKey = createApiApp(db, simClock()).listen(0);
  const url = (server: typeof withModel, path: string) =>
    `http://localhost:${(server.address() as AddressInfo).port}${path}`;
  afterAll(() => {
    withModel.close();
    withoutKey.close();
  });

  const postDraft = async (server: typeof withModel, body: unknown) => {
    const response = await fetch(url(server, "/rules/draft"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };

  it("drafts a rule and says it in words, without saving it", async () => {
    const { status, body } = await postDraft(withModel, {
      owner_id: "lead_1",
      sentence: "ping me if any of my agents is on a call for 45 minutes",
    });

    expect(status).toBe(200);
    expect(body.draft.owner_id).toBe("lead_1");
    expect(body.description).toBe("state is on_call for 45 min");
    expect(listRules(db)).toHaveLength(rulesBefore);
  });

  it("is switched off without a key, and says so", async () => {
    expect(await (await fetch(url(withoutKey, "/assistant"))).json()).toEqual({ enabled: false });
    expect(await (await fetch(url(withModel, "/assistant"))).json()).toEqual({ enabled: true });

    const { status, body } = await postDraft(withoutKey, { owner_id: "lead_1", sentence: "hi" });
    expect(status).toBe(503);
    expect(body.errors).toEqual(["The assistant is not set up"]);
  });

  it("needs an owner and a sentence", async () => {
    expect((await postDraft(withModel, { owner_id: "lead_1", sentence: " " })).status).toBe(400);
  });
});
