// The two deployed functions: the events webhook over real HTTP, and the scheduled
// tick. Both read "now" from the clock they are given.

import type { AddressInfo } from "node:net";

import { afterAll, describe, expect, it } from "vitest";

import type { Source } from "../src/functions/clock.ts";
import { createEventsApp } from "../src/functions/events.ts";
import { runTick } from "../src/functions/ticker.ts";
import type { Notification } from "../src/store/store.ts";
import { seededStore } from "../scripts/replay.ts";
import { simClock } from "../scripts/simulate.ts";
import { at, feedLine } from "./testHelpers.ts";

const db = seededStore();
const clock = simClock();
clock.time = at("09:30:00");
const delivered: [Source, Notification[]][] = [];
const server = createEventsApp(db, clock, (notifications, source) => {
  delivered.push([source, notifications]);
}).listen(0);
const url = `http://localhost:${(server.address() as AddressInfo).port}/events`;
afterAll(() => server.close());

const post = async (body: string) => {
  const response = await fetch(url, { method: "POST", body });
  return { status: response.status, body: await response.json() };
};

describe("events webhook", () => {
  it("applies a line, and delivers what it fired as the webhook", async () => {
    // Line 39 is billing at 09:30, already over its SLA.
    const { status, body } = await post(feedLine(39));

    expect(status).toBe(200);
    expect(body).toEqual({ outcome: "applied", reason: null, notifications: 1 });
    expect(delivered.at(-1)?.[0]).toBe("webhook");
  });

  it("answers 200 to a duplicate, so the sender stops retrying", async () => {
    const { status, body } = await post(feedLine(39));

    expect(status).toBe(200);
    expect(body.outcome).toBe("duplicate");
  });

  it("answers 400 to a line it cannot read", async () => {
    const { status, body } = await post("{not json");

    expect(status).toBe(400);
    expect(body.outcome).toBe("rejected");
  });
});

describe("scheduled tick", () => {
  it("fires the 09:45 follow-up when the clock reaches it, delivered as the ticker", () => {
    clock.time = at("09:45:00");
    runTick(db, clock, (notifications, source) => delivered.push([source, notifications]));

    const [source, notifications] = delivered.at(-1)!;
    expect(source).toBe("ticker");
    expect(notifications.map((n) => n.kind)).toEqual(["follow_up"]);
  });
});
