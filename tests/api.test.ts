// The config API over real HTTP: rules are checked before they are saved, each
// person sees their own rules and notifications, and deleting a rule closes its live
// incidents without a message and without breaking the ticker.

import type { AddressInfo } from "node:net";

import { afterAll, describe, expect, it } from "vitest";

import { createApiApp } from "../src/functions/api.ts";
import { handleEvent, tick } from "../src/ingest.ts";
import { listLiveIncidents } from "../src/store/store.ts";
import { seededStore } from "../scripts/replay.ts";
import { simClock } from "../scripts/simulate.ts";
import { at, feedLine } from "./testHelpers.ts";

const db = seededStore();
const clock = simClock();
const server = createApiApp(db, clock).listen(0);
const base = `http://localhost:${(server.address() as AddressInfo).port}`;
afterAll(() => server.close());

const get = async (path: string) => {
  const response = await fetch(`${base}${path}`);
  return { status: response.status, body: await response.json() };
};
const post = async (path: string, body: unknown) => {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
};
const remove = async (path: string) => (await fetch(`${base}${path}`, { method: "DELETE" })).status;

const breakRule = {
  owner_id: "lead_1",
  subject: { kind: "team", resource_ids: ["team_1"] },
  conditions: [{ field: "state", op: "=", value: "on_break" }],
  for_seconds: 0,
};

describe("config API", () => {
  it("lists the directory and the catalog the form is built from", async () => {
    const directory = await get("/directory");
    expect(directory.body.queues).toEqual(["billing", "tier_2", "vip"]);
    expect(directory.body.teams[0]).toEqual({
      id: "team_1",
      lead_id: "lead_1",
      agent_ids: ["a_07", "a_19", "a_31", "a_42"],
    });

    const catalog = await get("/catalog");
    expect(catalog.body.agent[0]).toMatchObject({
      name: "state",
      type: "string",
      operators: ["=", "in"],
    });
  });

  it("saves a valid rule with a server-chosen id, and lists it for its owner only", async () => {
    const created = await post("/rules", { ...breakRule, id: "my_own_id" });

    expect(created.status).toBe(201);
    expect(created.body.id).toMatch(/^rule_/);
    expect(created.body.description).toBe("state is on_break");

    const mine = await get("/rules?owner=lead_1");
    expect(mine.body.map((rule: { id: string }) => rule.id)).toContain(created.body.id);
    const theirs = await get("/rules?owner=lead_2");
    expect(theirs.body.map((rule: { id: string }) => rule.id)).not.toContain(created.body.id);
    expect(theirs.body.every((rule: { owner_id: string }) => rule.owner_id === "lead_2")).toBe(
      true,
    );
  });

  it("refuses an invalid rule with every reason, and saves nothing", async () => {
    const before = (await get("/rules?owner=lead_1")).body.length;
    const refused = await post("/rules", {
      ...breakRule,
      subject: { kind: "team", resource_ids: ["team_9"] },
      for_seconds: -1,
    });

    expect(refused.status).toBe(400);
    expect(refused.body.errors).toEqual([
      "Unknown team: team_9",
      "for_seconds must be a whole number of seconds, 0 or more",
    ]);
    expect((await get("/rules?owner=lead_1")).body.length).toBe(before);
  });

  it("lists a person's notifications, and only theirs", async () => {
    clock.time = at("09:30:00");
    handleEvent(db, feedLine(39), clock.now()); // billing breaches its SLA: lead_1 is told

    const lead1 = await get("/notifications?recipient=lead_1");
    expect(lead1.body).toHaveLength(1);
    expect(lead1.body[0]).toMatchObject({ kind: "opened", recipient_id: "lead_1" });
    expect(lead1.body[0].detail).toMatchObject({ longest_wait_sec: 130, sla_target_sec: 120 });
    expect((await get("/notifications?recipient=lead_2")).body).toEqual([]);
  });

  it("deletes a rule: its live incident closes silently, and the ticker carries on", async () => {
    const live = () => listLiveIncidents(db).filter((i) => i.rule_id === "rule_sla_breached");
    expect(live()).toHaveLength(1);
    const sent = (await get("/notifications?recipient=lead_1")).body.length;

    clock.time = at("09:40:00");
    expect(await remove("/rules/rule_sla_breached")).toBe(204);

    expect(live()).toEqual([]);
    expect(tick(db, at("10:00:00"))).toEqual([]); // the 09:45 follow-up is not sent
    expect((await get("/notifications?recipient=lead_1")).body.length).toBe(sent);
    expect(
      (await get("/rules?owner=lead_1")).body.map((rule: { id: string }) => rule.id),
    ).not.toContain("rule_sla_breached");
  });

  it("answers 404 to deleting a rule that is gone", async () => {
    expect(await remove("/rules/rule_sla_breached")).toBe(404);
    expect(await remove("/rules/no_such_rule")).toBe(404);
  });
});
