// Chat-log parsing shared by the desktop and mobile UIs.
//
// Model: the textarea text is the single source of truth. parseLog() derives the
// list of messages from it (idempotently — same text always yields the same list,
// so re-running on every keystroke never accumulates duplicates). Each message
// records the line range [start, end] it occupies in the source so the block can
// delete it from the source and the input overlay can highlight it.

export const PATTERN = /^\s*([^:：]{1,24}?)\s*[:：]\s*(\S.*)$/;

export type ParsedMsg = {
  name: string;     // display name ("You" for self-senders)
  rawName: string;  // the name exactly as written
  text: string;
  self: boolean;
  start: number;    // first source line index of this message
  end: number;      // last source line index (continuation lines absorbed)
};

export function isSelfName(name: string, selfNames: string[]) {
  const t = (name || '').trim().toLowerCase();
  return selfNames.some((n) => (n || '').trim().toLowerCase() === t);
}

// Parse a "name: message" log. Any line matching the pattern with a non-empty name
// (even a single one) becomes a message; text without a "name:" colon shape stays as
// a free reply. Lines without a "name:" prefix continue the preceding message and the
// newline is PRESERVED (multi-line message body), so nothing is collapsed into spaces.
export function parseLog(text: string, selfNames: string[]): ParsedMsg[] {
  const lines = text.split('\n');
  const msgs: ParsedMsg[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(PATTERN);
    if (m && m[1].trim()) {
      const rawName = m[1].trim();
      const self = isSelfName(rawName, selfNames);
      msgs.push({ name: self ? 'You' : rawName, rawName, text: m[2].trim(), self, start: i, end: i });
    } else if (line.trim() && msgs.length) {
      // continuation of the previous message — append every line since the message's
      // last content line, so INTERNAL blank lines are kept in the body too (they're
      // also highlighted in the input). Trailing blanks after the last content line
      // are never reached, so they stay out of the message. Whitespace kept verbatim.
      const last = msgs[msgs.length - 1];
      for (let k = last.end + 1; k <= i; k++) last.text += '\n' + lines[k];
      last.end = i;
    }
    // else: a line before any message, or a trailing blank line → not part of a message
  }
  return msgs;
}

function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Build the mirror HTML for the highlight overlay behind the textarea: every parsed
// line gets its own per-line <span class="ls-hl"> (text-width, hugging the glyphs).
// Blank lines inside a message body still get a (non-zero-width) highlight via a
// no-break space so the "next lines" of a multi-line message are marked too.
export function buildHighlightHtml(value: string, ranges: { start: number; end: number }[]) {
  const parsed = new Set<number>();
  for (const r of ranges) for (let i = r.start; i <= r.end; i++) parsed.add(i);
  const lines = value.split('\n');
  let html = lines
    .map((ln, i) => {
      const esc = escapeHtml(ln);
      return parsed.has(i) ? `<span class="ls-hl">${esc || ' '}</span>` : esc;
    })
    .join('\n');
  // a trailing newline needs a placeholder glyph so the overlay keeps the textarea's empty last line
  if (value.endsWith('\n')) html += '​';
  return html;
}
