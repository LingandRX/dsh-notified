import assert from "node:assert/strict";
import { test } from "node:test";

import { isSubagentSession, shouldNotify } from "../lib/policy.js";

/** The permissive baseline every case narrows from. */
const base = {
  enabled: true,
  reason: "completed",
  notifyOn: ["completed"],
  sawAssistantOutput: true,
  turnDurationMs: 5000,
  minTurnDurationMs: 0,
  isSubagent: false,
  includeSubagents: false,
};

test("notifies for an ordinary completed turn", () => {
  assert.deepEqual(shouldNotify(base), { notify: true, reason: undefined });
});

test("stays silent while the plugin is disabled", () => {
  assert.equal(shouldNotify({ ...base, enabled: false }).reason, "disabled");
});

test("filters out reasons the user did not opt into", () => {
  assert.equal(shouldNotify({ ...base, reason: "aborted" }).reason, "reason-filtered");
  assert.equal(shouldNotify({ ...base, reason: "error" }).reason, "reason-filtered");
});

test("honors a wider reason opt-in", () => {
  const wide = { ...base, notifyOn: ["completed", "aborted", "error", "interrupted"] };
  assert.equal(shouldNotify({ ...wide, reason: "aborted" }).notify, true);
  assert.equal(shouldNotify({ ...wide, reason: "error" }).notify, true);
  assert.equal(shouldNotify({ ...wide, reason: "interrupted" }).notify, true);
});

test("stays silent for a turn that produced no assistant text", () => {
  assert.equal(shouldNotify({ ...base, sawAssistantOutput: false }).reason, "no-output");
});

test("treats a non-true output flag as no output", () => {
  assert.equal(shouldNotify({ ...base, sawAssistantOutput: undefined }).reason, "no-output");
  assert.equal(shouldNotify({ ...base, sawAssistantOutput: 1 }).reason, "no-output");
});

test("suppresses delegated subagents by default", () => {
  assert.equal(shouldNotify({ ...base, isSubagent: true }).reason, "subagent");
});

test("allows subagents when the user opts in", () => {
  assert.equal(shouldNotify({ ...base, isSubagent: true, includeSubagents: true }).notify, true);
});

test("applies the minimum duration floor", () => {
  assert.equal(shouldNotify({ ...base, turnDurationMs: 400, minTurnDurationMs: 1000 }).reason, "too-short");
  assert.equal(shouldNotify({ ...base, turnDurationMs: 1000, minTurnDurationMs: 1000 }).notify, true);
});

test("a zero or absent duration floor never filters", () => {
  assert.equal(shouldNotify({ ...base, turnDurationMs: 1, minTurnDurationMs: 0 }).notify, true);
  assert.equal(shouldNotify({ ...base, turnDurationMs: 1 }).notify, true);
});

test("rejects an unusable reason list without throwing", () => {
  assert.equal(shouldNotify({ ...base, notifyOn: undefined }).reason, "reason-filtered");
  assert.equal(shouldNotify({ ...base, notifyOn: [] }).reason, "reason-filtered");
});

test("the filter order reports the first matching rule", () => {
  // Disabled wins over everything, so a disabled plugin reports `disabled`
  // rather than a downstream filter that also applies.
  assert.equal(
    shouldNotify({ ...base, enabled: false, sawAssistantOutput: false, reason: "aborted" }).reason,
    "disabled",
  );
  // Reason is checked before output, matching the documented order.
  assert.equal(shouldNotify({ ...base, reason: "aborted", sawAssistantOutput: false }).reason, "reason-filtered");
});

test("isSubagentSession requires both the parent link and the subagent origin", () => {
  assert.equal(isSubagentSession({ parentSession: "s-1", origin: "subagent" }), true);
  assert.equal(isSubagentSession({ parentSession: "s-1" }), false);
  assert.equal(isSubagentSession({ origin: "subagent" }), false);
  assert.equal(isSubagentSession({}), false);
});

test("isSubagentSession tolerates a missing or malformed header", () => {
  assert.equal(isSubagentSession(undefined), false);
  assert.equal(isSubagentSession(null), false);
  assert.equal(isSubagentSession("header"), false);
});
