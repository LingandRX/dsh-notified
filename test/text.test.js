import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assistantText,
  basenameOf,
  collapseWhitespace,
  composeBody,
  composeMergedSummary,
  composeTitle,
  formatDuration,
  stripMarkdown,
  truncateChars,
  utf8Bytes,
} from "../lib/text.js";

test("truncateChars keeps text that already fits", () => {
  assert.equal(truncateChars("hello", 10), "hello");
  assert.equal(truncateChars("hello", 5), "hello");
});

test("truncateChars appends an ellipsis and respects the budget", () => {
  const result = truncateChars("abcdefghij", 5);
  assert.equal(Array.from(result).length, 5);
  assert.equal(result, "abcd\u2026");
});

test("truncateChars returns empty for a non-positive budget", () => {
  assert.equal(truncateChars("abc", 0), "");
  assert.equal(truncateChars("abc", -1), "");
});

test("truncateChars never splits an astral character", () => {
  const result = truncateChars("\u{1F600}\u{1F600}\u{1F600}", 2);
  // Two code points kept: one emoji plus the ellipsis.
  assert.equal(Array.from(result).length, 2);
  assert.ok(result.startsWith("\u{1F600}"));
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u.test(result));
});

test("collapseWhitespace flattens newlines and trims", () => {
  assert.equal(collapseWhitespace("  a\n\n  b\t c  "), "a b c");
  assert.equal(collapseWhitespace("\n\n"), "");
});

test("stripMarkdown removes fenced code blocks", () => {
  const result = stripMarkdown("before\n```js\nconst x = 1;\n```\nafter");
  assert.ok(!result.includes("const x = 1"));
  assert.ok(result.includes("before"));
  assert.ok(result.includes("after"));
});

test("stripMarkdown unwraps inline code and links", () => {
  assert.equal(collapseWhitespace(stripMarkdown("use `npm test` here")), "use npm test here");
  assert.equal(collapseWhitespace(stripMarkdown("[docs](https://x.test/a)")), "docs");
  assert.equal(collapseWhitespace(stripMarkdown("![alt](https://x.test/a.png)")), "alt");
});

test("stripMarkdown removes headings, quotes, and list markers", () => {
  assert.equal(collapseWhitespace(stripMarkdown("## Title\n- one\n  * two\n1. three\n> quoted")), "Title one two three quoted");
});

test("stripMarkdown removes emphasis without eating underscores inside words", () => {
  assert.equal(collapseWhitespace(stripMarkdown("a **bold** and *em* and ~~gone~~")), "a bold and em and gone");
  assert.ok(collapseWhitespace(stripMarkdown("snake_case_name stays")).includes("snake_case_name"));
});

test("stripMarkdown flattens table separators", () => {
  const table = "| a | b |\n| --- | --- |\n| 1 | 2 |";
  const result = collapseWhitespace(stripMarkdown(table));
  assert.ok(!result.includes("|"));
  assert.ok(result.includes("a"));
  assert.ok(result.includes("2"));
});

test("composeBody composes prose plus duration", () => {
  const body = composeBody({ text: "All done.", turnDurationMs: 4200, maxChars: 200 });
  assert.equal(body, "All done. (4s)");
});

test("composeBody appends a suffix before the duration", () => {
  const body = composeBody({ text: "Ready", turnDurationMs: 1000, maxChars: 200, suffix: "Reply sent" });
  assert.equal(body, "Ready Reply sent (1s)");
});

test("composeBody honors the character budget", () => {
  const body = composeBody({ text: "x".repeat(500), turnDurationMs: 0, maxChars: 40 });
  assert.equal(Array.from(body).length, 40);
});

test("composeBody reserves room for the duration instead of truncating it away", () => {
  // The regression: the tail used to be appended last and then cut off, so a
  // long reply lost its duration entirely despite showDuration being on.
  // Budget 40 - tail "(4s)" 4 - separator 1 leaves 35 slots for the excerpt.
  const body = composeBody({ text: "x".repeat(500), turnDurationMs: 4200, maxChars: 40 });
  assert.equal(body, `${"x".repeat(34)}\u2026 (4s)`);
  assert.equal(Array.from(body).length, 40);
});

test("composeBody keeps the duration for every budget that fits the tail", () => {
  for (const maxChars of [40, 60, 140]) {
    const body = composeBody({ text: "y".repeat(999), turnDurationMs: 65_000, maxChars });
    assert.ok(body.endsWith("(1m 05s)"), `budget ${maxChars}: ${body}`);
    assert.equal(Array.from(body).length, maxChars, `budget ${maxChars}: ${body}`);
  }
});

test("composeBody preserves the reserved tail when the budget cannot fit prose too", () => {
  // A budget smaller than the tail alone: the excerpt yields the line rather
  // than leaving a bare ellipsis stub, and the reserved tail survives intact.
  const body = composeBody({ text: "x".repeat(500), turnDurationMs: 4200, maxChars: 3 });
  assert.equal(body, "(4s)");
});

test("composeBody drops the prose stub rather than showing only an ellipsis", () => {
  // "(0s)" costs 4 plus the separator, so 7 slots still leave the 2-slot floor.
  assert.equal(composeBody({ text: "x".repeat(500), turnDurationMs: 0, maxChars: 7 }), "x\u2026 (0s)");
  // One slot below the floor the excerpt yields the whole line.
  assert.equal(composeBody({ text: "x".repeat(500), turnDurationMs: 0, maxChars: 6 }), "(0s)");
});

test("composeBody reserves room for the suffix as well as the duration", () => {
  const body = composeBody({ text: "z".repeat(500), turnDurationMs: 1000, maxChars: 30, suffix: "Reply sent" });
  assert.equal(body, `${"z".repeat(13)}\u2026 Reply sent (1s)`);
  assert.equal(Array.from(body).length, 30);
});

test("composeBody spends the whole budget on prose when there is no tail", () => {
  const body = composeBody({ text: "x".repeat(500), maxChars: 10 });
  assert.equal(body, `${"x".repeat(9)}\u2026`);
  assert.equal(Array.from(body).length, 10);
});

test("composeBody tolerates missing text", () => {
  assert.equal(composeBody({ text: undefined, turnDurationMs: 2000, maxChars: 80 }), "(2s)");
});

test("composeBody substitutes the fallback when the reply strips to nothing", () => {
  const body = composeBody({ text: "```js\nconst x = 1;\n```", turnDurationMs: 1000, maxChars: 80, emptyBody: "Turn finished" });
  assert.equal(body, "Turn finished (1s)");
});

test("composeBody still prefers real prose over the fallback", () => {
  const body = composeBody({ text: "real prose", turnDurationMs: 0, maxChars: 80, emptyBody: "Turn finished" });
  assert.equal(body, "real prose (0s)");
});

test("composeBody ignores an empty fallback", () => {
  assert.equal(composeBody({ text: "", turnDurationMs: 1000, maxChars: 80, emptyBody: "" }), "(1s)");
});

test("formatDuration switches units at each boundary", () => {
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(999), "0s");
  assert.equal(formatDuration(1000), "1s");
  assert.equal(formatDuration(59_000), "59s");
  assert.equal(formatDuration(60_000), "1m 00s");
  assert.equal(formatDuration(65_000), "1m 05s");
  assert.equal(formatDuration(3_600_000), "1h 00m");
  assert.equal(formatDuration(3_780_000), "1h 03m");
  assert.equal(formatDuration(-5), "0s");
});

test("assistantText joins only non-empty text blocks", () => {
  const content = [
    { type: "text", text: "first" },
    { type: "reasoning", text: "hidden" },
    { type: "text", text: "   " },
    { type: "text", text: "second" },
  ];
  assert.equal(assistantText(content), "first\n\nsecond");
  assert.equal(assistantText([]), "");
  assert.equal(assistantText(undefined), "");
});

test("assistantText ignores malformed blocks", () => {
  assert.equal(assistantText([null, 7, { type: "text" }, { type: "text", text: "ok" }]), "ok");
});

test("composeTitle prefers the session title", () => {
  assert.equal(composeTitle({ sessionTitle: "Fix the parser", cwd: "C:\\work\\other", fallback: "F" }), "Fix the parser");
});

test("composeTitle falls back to the workspace folder name", () => {
  assert.equal(composeTitle({ sessionTitle: "  ", cwd: "C:\\Users\\YLL\\Documents\\ChatGPT\\dsh-notified", fallback: "F" }), "dsh-notified");
  assert.equal(composeTitle({ sessionTitle: undefined, cwd: "/home/y/rockingdom/", fallback: "F" }), "rockingdom");
});

test("composeTitle uses the constant when nothing else is usable", () => {
  assert.equal(composeTitle({ sessionTitle: undefined, cwd: undefined, fallback: "DeepSeek Harness" }), "DeepSeek Harness");
  assert.equal(composeTitle({ sessionTitle: "", cwd: "", fallback: "" }), "");
});

test("basenameOf handles both separators and trailing slashes", () => {
  assert.equal(basenameOf("C:\\a\\b"), "b");
  assert.equal(basenameOf("/a/b/"), "b");
  assert.equal(basenameOf("solo"), "solo");
  assert.equal(basenameOf(""), undefined);
  assert.equal(basenameOf(undefined), undefined);
});

test("composeMergedSummary substitutes the count", () => {
  assert.equal(composeMergedSummary(3, "{count} conversations finished"), "3 conversations finished");
});

test("utf8Bytes measures encoded length, not code points", () => {
  assert.equal(utf8Bytes("abc"), 3);
  assert.equal(utf8Bytes("\u4e2d"), 3);
  assert.equal(utf8Bytes("\u{1F600}"), 4);
});
