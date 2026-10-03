/**
 * Pure text helpers for one toast notification.
 *
 * Every function here is deterministic and free of I/O, so the table below is
 * the single place notification copy can be wrong. `lib/index.js` extracts the
 * facts (title, last assistant reply, turn duration) and `lib/toast.js` only
 * transports the result.
 *
 * @module dsh-notified/text
 */

/** Appended when a string had to be shortened. */
const ELLIPSIS = "\u2026";

/**
 * Smallest prose slot worth keeping: one code point plus the truncation
 * ellipsis. Below this the result would be a bare "…" stub, which reads as
 * noise, so the prose yields the whole line to the reserved tail instead.
 */
const MIN_PROSE_CHARS = 2;

/**
 * Count the UTF-8 bytes one string occupies.
 * @param input - text to measure.
 * @returns the byte length of its UTF-8 encoding.
 */
export function utf8Bytes(input) {
  return Buffer.byteLength(input, "utf8");
}

/**
 * Shorten text to a code-point budget without splitting a surrogate pair.
 *
 * Counting code points (not UTF-16 units) keeps astral characters such as
 * emoji intact, which matters because a lone surrogate renders as a
 * replacement glyph in the notification.
 * @param input - already-normalized text.
 * @param maxChars - maximum number of code points to keep; `<= 0` yields `""`.
 * @returns the input when it fits, otherwise a prefix plus an ellipsis.
 */
export function truncateChars(input, maxChars) {
  if (maxChars <= 0) return "";
  const points = Array.from(input);
  if (points.length <= maxChars) return input;
  // The ellipsis occupies one slot, so the visible body is maxChars - 1.
  return points.slice(0, Math.max(0, maxChars - 1)).join("") + ELLIPSIS;
}

/**
 * Collapse every whitespace run to a single space and trim the ends.
 * @param input - raw text, possibly containing newlines and indentation.
 * @returns one single-line string.
 */
export function collapseWhitespace(input) {
  return input.replace(/\s+/gu, " ").trim();
}

/**
 * Turn model-authored Markdown into one line of plain prose.
 *
 * A toast body is a single unformatted line, so syntax would show as noise.
 * Only the constructs that are unambiguous to strip are removed; anything
 * else survives verbatim rather than risking a wrong rewrite.
 * @param input - assistant reply text, possibly Markdown.
 * @returns readable plain text with Markdown syntax removed.
 */
export function stripMarkdown(input) {
  let text = input;
  // Fenced code blocks carry no readable prose; drop the whole fence.
  text = text.replace(/```[\s\S]*?```/gu, " ");
  text = text.replace(/~~~[\s\S]*?~~~/gu, " ");
  // Inline code: unwrap, keep the content.
  text = text.replace(/`([^`\n]*)`/gu, "$1");
  // Images then links, before the emphasis passes consume the brackets.
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1");
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1");
  // Reference-style link definitions (`[id]: https://...`) are not prose.
  text = text.replace(/^\s*\[[^\]]+\]:\s+\S+.*$/gmu, " ");
  // ATX headings and blockquote markers.
  text = text.replace(/^\s{0,3}#{1,6}\s+/gmu, "");
  text = text.replace(/^\s{0,3}>\s?/gmu, "");
  // Bullet and ordered list markers at the start of a line.
  text = text.replace(/^\s{0,3}(?:[-*+]|\d{1,9}[.)])\s+/gmu, "");
  // Horizontal rules.
  text = text.replace(/^\s{0,3}(?:[-*_]\s*){3,}$/gmu, " ");
  // Table divider rows (`| --- | :--: |`).
  text = text.replace(/^\s{0,3}\|?(?:\s*:?-{2,}:?\s*\|)+\s*$/gmu, " ");
  // Table cell separators become spaces so cells stay readable.
  text = text.replace(/\|/gu, " ");
  // Emphasis: strongest markers first so `***x***` resolves in one pass each.
  text = text.replace(/(\*\*\*|___)(?=\S)([\s\S]*?\S)\1/gu, "$2");
  text = text.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/gu, "$2");
  text = text.replace(/(?<![A-Za-z0-9])(\*|_)(?=\S)([^*_\n]*?\S)\1(?![A-Za-z0-9])/gu, "$2");
  // Strikethrough.
  text = text.replace(/~~(?=\S)([\s\S]*?\S)~~/gu, "$1");
  return text;
}

/**
 * Compose the one-line body shown under the notification title.
 *
 * The tail — the optional suffix plus the duration — is reserved *before* the
 * prose is laid out. Appending first and truncating the whole line instead
 * silently destroyed the duration on any long reply: the prose filled the
 * whole budget and the tail fell off the end, so `showDuration` defaulted to
 * on while never once appearing on a substantive answer. Reserving the tail
 * makes the setting always observable, at the cost of a shorter excerpt.
 *
 * When the budget cannot fit both, the prose yields first and then vanishes
 * entirely rather than shrinking to a bare "…" stub. The reserved tail itself
 * is never truncated, even if it alone exceeds `maxChars`: it is the part the
 * settings promised.
 * @param input - assistant reply text, turn facts, and the fallback copy.
 * @returns the ready-to-display body line.
 */
export function composeBody(input) {
  const { text, turnDurationMs, maxChars, suffix, emptyBody } = input;

  const tailParts = [];
  if (suffix !== undefined && suffix.length > 0) tailParts.push(suffix);
  if (turnDurationMs !== undefined && turnDurationMs >= 0) {
    tailParts.push(`(${formatDuration(turnDurationMs)})`);
  }
  const tail = tailParts.join(" ");

  const prose = collapseWhitespace(stripMarkdown(text ?? ""));
  let excerpt = prose;
  if (excerpt.length === 0 && typeof emptyBody === "string" && emptyBody.length > 0) {
    // A reply can reduce to nothing (a code-only answer, for example); the
    // fallback replaces it so the toast never shows a bare duration.
    excerpt = collapseWhitespace(stripMarkdown(emptyBody));
  }

  const budget = Number.isFinite(maxChars) ? maxChars : Number.POSITIVE_INFINITY;
  if (excerpt.length > 0) {
    // One slot is spent on the space that separates the excerpt from the tail.
    const separator = tail.length > 0 ? 1 : 0;
    const proseBudget = budget - Array.from(tail).length - separator;
    excerpt = proseBudget >= MIN_PROSE_CHARS ? truncateChars(excerpt, proseBudget) : "";
  }

  if (excerpt.length === 0) return tail;
  return tail.length === 0 ? excerpt : `${excerpt} ${tail}`;
}

/**
 * Format an elapsed duration as a compact ASCII label.
 * @param elapsedMs - non-negative elapsed milliseconds.
 * @returns labels such as `4s`, `1m 05s`, or `1h 02m`.
 */
export function formatDuration(elapsedMs) {
  const totalSeconds = Math.floor(Math.max(0, elapsedMs) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

/**
 * Join the text blocks of one assistant message.
 * @param content - the message's content block list.
 * @returns concatenated text, with blocks separated by a blank line.
 */
export function assistantText(content) {
  if (!Array.isArray(content)) return "";
  const chunks = [];
  for (const block of content) {
    if (block === null || typeof block !== "object") continue;
    if (block.type !== "text") continue;
    if (typeof block.text !== "string") continue;
    if (block.text.trim().length === 0) continue;
    chunks.push(block.text);
  }
  return chunks.join("\n\n");
}

/**
 * Resolve the notification title from the session's available identities.
 *
 * The chain prefers the generated conversation title, then the workspace
 * folder name, so a toast is never titled with an opaque session id.
 * @param input - candidate titles in descending preference.
 * @returns the first usable one-line title, or `""` when none is usable.
 */
export function composeTitle(input) {
  const { sessionTitle, cwd, fallback } = input;
  const candidates = [sessionTitle, basenameOf(cwd), fallback];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const line = collapseWhitespace(candidate);
    if (line.length > 0) return truncateChars(line, 64);
  }
  return "";
}

/**
 * Take the last path segment of a Windows or POSIX path.
 * @param path - a filesystem path, or any value that is not a string.
 * @returns the final segment, or `undefined`.
 */
export function basenameOf(path) {
  if (typeof path !== "string") return undefined;
  const trimmed = path.trim().replace(/[\\/]+$/u, "");
  if (trimmed.length === 0) return undefined;
  const index = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  return index === -1 ? trimmed : trimmed.slice(index + 1);
}

/**
 * Format the body line for a notification that merged several turns.
 * @param count - number of settled turns folded into one toast.
 * @param template - a template containing `{count}`.
 * @returns the pluralized summary line.
 */
export function composeMergedSummary(count, template) {
  return template.replace(/\{count\}/gu, String(count));
}
