/**
 * Notification policy: which settled turns are worth interrupting the user for.
 *
 * Kept separate from `lib/index.js` so the rules can be exercised directly,
 * without a live loader tree, a session object, or a real notification. The
 * listener in `lib/index.js` only gathers facts and calls these functions.
 *
 * @module dsh-notified/policy
 */

import { assistantText } from "./text.js";

/**
 * Decide whether one settled turn should notify.
 *
 * Every rejection carries a machine-readable `reason` so a verbose run explains
 * itself in the log instead of silently doing nothing.
 * @param input - the turn's facts plus the effective configuration.
 * @returns `{ notify: true }`, or `{ notify: false, reason }` naming the filter.
 */
export function shouldNotify(input) {
  const {
    enabled,
    reason,
    notifyOn,
    sawAssistantOutput,
    turnDurationMs,
    minTurnDurationMs,
    isSubagent,
    includeSubagents,
  } = input;

  if (!enabled) return { notify: false, reason: "disabled" };
  if (!Array.isArray(notifyOn) || !notifyOn.includes(reason)) return { notify: false, reason: "reason-filtered" };
  // A settle with no assistant text means the turn only ran tools, so the
  // conversation is still in progress and the user is not waiting on an answer.
  if (sawAssistantOutput !== true) return { notify: false, reason: "no-output" };
  if (isSubagent === true && includeSubagents !== true) return { notify: false, reason: "subagent" };
  if (
    Number.isFinite(minTurnDurationMs) &&
    minTurnDurationMs > 0 &&
    Number.isFinite(turnDurationMs) &&
    turnDurationMs < minTurnDurationMs
  ) {
    return { notify: false, reason: "too-short" };
  }
  return { notify: true, reason: undefined };
}

/**
 * Recognize a delegated child session from the durable session header.
 *
 * The header is the authority: it is persisted, monotone, and written by the
 * subagent service itself when it creates a child.
 * @param header - a session header, possibly absent or partial.
 * @returns whether this session is a delegated subagent.
 */
export function isSubagentSession(header) {
  if (header === undefined || header === null || typeof header !== "object") return false;
  return header.parentSession !== undefined && header.origin === "subagent";
}

/**
 * Fold one session event into the per-turn tracking state.
 *
 * The tracker is the only mutable part of the decision path, so it lives here
 * rather than in the listener: a caller supplies the previous state, this
 * returns the next one, and `null` means the turn closed (the state is spent).
 * @param state - the previous tracking state, or `undefined` before the first event.
 * @param event - the session event to fold.
 * @returns the next tracking state, or `undefined` when the turn closed.
 */
export function foldTurnState(state, event) {
  const type = event?.type;
  if (type === "turn/start") {
    return { turn: event.data?.turn, startTime: event.time ?? 0, sawAssistantOutput: false, lastText: "" };
  }
  if (state === undefined) return undefined;
  if (type === "assistant/message") {
    const text = assistantTextOf(event);
    if (text.length === 0) return state;
    return { ...state, sawAssistantOutput: true, lastText: text };
  }
  if (type === "turn/end") {
    // A settle for a turn this process never opened (for example a resumed
    // session's inherited history) is not a completion this plugin observed.
    if (state.turn === undefined || event.data?.turn !== state.turn) return undefined;
    return undefined;
  }
  return state;
}

/**
 * Join the text blocks of one assistant message carried by a session event.
 * @param event - an `assistant/message` session event.
 * @returns concatenated text, or `""` when the message carries none.
 */
export function assistantTextOf(event) {
  return assistantText(event?.data?.message?.content);
}

/**
 * Decide what one `turn/end` event should do.
 *
 * Pure by construction: it receives the turn's tracking state and returns the
 * facts needed to notify, so the whole policy — including the exact duration
 * and body text — is testable without a loader tree or a real notification.
 * @param input - tracking state, the settle event, header facts, and config.
 * @returns `{ notify: false, reason }` or `{ notify: true, request }`.
 */
export function decideTurnEnd(input) {
  const { state, event, header, config } = input;
  const turn = event?.data?.turn;
  if (state === undefined || state.turn === undefined || turn !== state.turn) {
    return { notify: false, reason: "unknown-turn" };
  }
  const reason = event?.data?.reason?.kind ?? "completed";
  const turnDurationMs = Math.max(0, (event.time ?? 0) - state.startTime);
  const decision = shouldNotify({
    enabled: config.enabled,
    reason,
    notifyOn: config.notifyOn,
    sawAssistantOutput: state.sawAssistantOutput,
    turnDurationMs,
    minTurnDurationMs: config.minTurnDurationMs,
    isSubagent: isSubagentSession(header),
    includeSubagents: config.includeSubagents,
  });
  if (!decision.notify) return { notify: false, reason: decision.reason };
  return {
    notify: true,
    reason: undefined,
    request: {
      cwd: header?.cwd,
      bodyText: state.lastText,
      turnDurationMs,
      reason,
    },
  };
}
