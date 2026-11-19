import { describe, expect, it } from "vitest";

import {
  type AdherenceCheck,
  type AgentStateChange,
  normalize,
} from "../../src/engine/normalize.ts";
import { applyAgentEvent } from "../../src/engine/state.ts";
import { agentState, at, feedLine } from "../testHelpers.ts";

/** A real agent event from the feed, normalised. */
function agentEvent(lineNumber: number): AgentStateChange | AdherenceCheck {
  const parsed = normalize(feedLine(lineNumber));
  if (!parsed.ok || parsed.event.type === "queue_snapshot")
    throw new Error(`line ${lineNumber} is not an agent event`);
  return parsed.event;
}

describe("applyAgentEvent", () => {
  it("starts an agent from their first state change, which has no previous state (line 4)", () => {
    expect(applyAgentEvent(null, agentEvent(4))).toEqual({
      agent_id: "a_31",
      state: "available",
      state_since: at("09:00:00"),
      violation_since: null,
      last_event_ts: at("09:00:00"),
    });
  });

  it("starts the new state's clock at the state change (line 38: a_31 goes on a call at 09:30)", () => {
    const before = agentState({
      agent_id: "a_31",
      state: "available",
      state_since: at("09:20:00"),
      violation_since: null,
    });
    expect(applyAgentEvent(before, agentEvent(38))).toMatchObject({
      state: "on_call",
      state_since: at("09:30:00"),
    });
  });

  it("restarts the clock on a state change into the same state: a second call is a new call", () => {
    const firstCall = agentState({
      agent_id: "a_31",
      state: "on_call",
      state_since: at("09:00:00"),
      violation_since: null,
    });
    // Line 38 is a_31 going on a call at 09:30; here it follows another call.
    expect(applyAgentEvent(firstCall, agentEvent(38))).toMatchObject({
      state: "on_call",
      state_since: at("09:30:00"),
    });
  });

  it("keeps the state's start when an adherence check agrees (line 56: a_31 still on the call at 09:45)", () => {
    const onCall = agentState({
      agent_id: "a_31",
      state: "on_call",
      state_since: at("09:30:00"),
      violation_since: null,
    });
    expect(applyAgentEvent(onCall, agentEvent(56))).toMatchObject({
      state: "on_call",
      state_since: at("09:30:00"),
      last_event_ts: at("09:45:00"),
    });
  });

  it("corrects the state when an adherence check disagrees, starting it at the check (line 86: a_23)", () => {
    // The state stream last put a_23 on a call at 09:45; the 10:15:30 check says in_meeting.
    const onCall = agentState({
      agent_id: "a_23",
      state: "on_call",
      state_since: at("09:45:00"),
      violation_since: null,
    });

    expect(applyAgentEvent(onCall, agentEvent(86))).toEqual({
      agent_id: "a_23",
      state: "in_meeting",
      state_since: at("10:15:30"),
      // The check gives no violation start, and a_23 was not in violation before.
      violation_since: at("10:15:30"),
      last_event_ts: at("10:15:30"),
    });
  });

  it("takes the violation start from the check when it gives one (line 50: a_19 since 09:35)", () => {
    const onBreak = agentState({ state: "on_break", violation_since: null });
    expect(applyAgentEvent(onBreak, agentEvent(50))).toMatchObject({
      violation_since: at("09:35:00"),
    });
  });

  it("keeps the first start of a violation when a later check gives none", () => {
    const check: AdherenceCheck = {
      ...(agentEvent(86) as AdherenceCheck),
      ts: at("10:30:00"),
    };
    const alreadyOut = agentState({
      agent_id: "a_23",
      state: "in_meeting",
      violation_since: at("10:15:30"),
    });

    expect(applyAgentEvent(alreadyOut, check)).toMatchObject({ violation_since: at("10:15:30") });
  });

  it("clears the violation when a check says the agent is back in adherence (line 76: a_19)", () => {
    expect(applyAgentEvent(agentState(), agentEvent(76))).toMatchObject({
      violation_since: null,
    });
  });

  it("carries adherence through a state change, which does not report it (line 75)", () => {
    // a_19 is back to available at 10:10, but only the 10:10:30 check says the violation ended.
    expect(applyAgentEvent(agentState(), agentEvent(75))).toMatchObject({
      state: "available",
      violation_since: at("09:35:00"),
    });
  });
});
