import { describe, expect, it } from "vitest";

import { type FeedEvent, formatTime, normalize } from "../../src/engine/normalize.ts";
import { at, feedLine, feedLines, snapshotLine } from "../testHelpers.ts";

function eventOf(line: string): FeedEvent {
  const result = normalize(line);
  if (!result.ok) throw new Error(`Expected an event, got reject: ${result.reason}`);
  return result.event;
}

function rejectReason(line: string): string {
  const result = normalize(line);
  if (result.ok) throw new Error("Expected a reject, got an event");
  return result.reason;
}

describe("normalize", () => {
  it("reads a queue snapshot, with its time as epoch milliseconds", () => {
    // Line 39: the first breached billing snapshot.
    expect(eventOf(feedLine(39))).toEqual({
      event_id: "evt_01HXYZ039",
      ts: at("09:30:00"),
      type: "queue_snapshot",
      queue_id: "billing",
      tickets_waiting: 18,
      longest_wait_sec: 130,
      sla_target_sec: 120,
      agents_available: 0,
      agents_on_call: 4,
      volume_last_15m: 28,
      volume_forecast_next_15m: 38,
    });
  });

  it("accepts every line of the sample feed", () => {
    const lines = feedLines().filter((line) => line !== "");
    expect(lines).toHaveLength(96);
    expect(lines.filter((line) => !normalize(line).ok)).toEqual([]);
  });

  describe("dirt found in the sample feed", () => {
    it("keeps a missing forecast as null (line 68)", () => {
      expect(eventOf(feedLine(68))).toMatchObject({
        queue_id: "billing",
        volume_forecast_next_15m: null,
      });
    });

    it("turns queue_ids: null into no queues (line 73)", () => {
      expect(eventOf(feedLine(73))).toMatchObject({ agent_id: "a_05", queue_ids: [] });
    });

    it("keeps an empty queue_ids list (line 74)", () => {
      expect(eventOf(feedLine(74))).toMatchObject({ agent_id: "a_05", queue_ids: [] });
    });

    it("accepts a violation with no start time (line 86)", () => {
      expect(eventOf(feedLine(86))).toMatchObject({
        agent_id: "a_23",
        in_violation: true,
        violation_started_at: null,
      });
    });

    it("accepts a first state change, which has no previous state (line 4)", () => {
      expect(eventOf(feedLine(4))).toMatchObject({
        agent_id: "a_31",
        previous_state: null,
        previous_state_duration_sec: null,
        new_state: "available",
      });
    });

    it("keeps a reported duration as reported, even where timestamps disagree (line 90)", () => {
      expect(eventOf(feedLine(90))).toMatchObject({
        agent_id: "a_31",
        previous_state_duration_sec: 3900,
      });
    });

    it("reads a violation start time as epoch milliseconds (line 50)", () => {
      expect(eventOf(feedLine(50))).toMatchObject({
        violation_started_at: at("09:35:00"),
      });
    });
  });

  // The sample feed has no malformed lines, so these are made by hand.
  describe("rejects", () => {
    it.each([
      ["text that is not JSON", "{not json", "not valid JSON"],
      ["JSON that is not an object", "[1, 2]", "not a JSON object"],
      ["an unknown type", snapshotLine({ type: "queue_closed" }), 'unknown type "queue_closed"'],
      ["a missing event id", snapshotLine({ event_id: undefined }), "event_id must be"],
      ["a missing time", snapshotLine({ ts: undefined }), "ts must be"],
      ["a time with no zone", snapshotLine({ ts: "2026-05-26T09:00:00" }), "ts must be"],
      ["a missing required field", snapshotLine({ queue_id: undefined }), "queue_id must be"],
      ["a number sent as text", snapshotLine({ tickets_waiting: "23" }), "tickets_waiting must be"],
      ["a negative number", snapshotLine({ longest_wait_sec: -1 }), "longest_wait_sec must be"],
      [
        "a nullable field left out entirely",
        snapshotLine({ volume_forecast_next_15m: undefined }),
        "volume_forecast_next_15m must be",
      ],
    ])("rejects %s", (_name, line, reason) => {
      expect(rejectReason(line)).toContain(reason);
    });
  });
});

describe("formatTime", () => {
  it("writes a time the way the feed does", () => {
    expect(formatTime(Date.parse("2026-05-26T09:30:00Z"))).toBe("2026-05-26T09:30:00Z");
  });
});
