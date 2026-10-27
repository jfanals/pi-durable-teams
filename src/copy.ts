// Copy-on-select gives the screen's rows: wrapped at the terminal width, with markdown drawn (no `**`, fences kept but
// code wrapped, tables boxed). This finds the same words in the messages' markdown and copies that instead.

const word = /[\p{L}\p{N}]/u;

/** The letters and digits of `text`, with each one's offset in `text`. */
function letters(text: string) {
  let chars = ""; const at: number[] = [];
  for (let i = 0; i < text.length; i++) if (word.test(text[i]!)) { chars += text[i]; at.push(i); }
  return { chars, at };
}

/**
 * The markdown behind a terminal selection: the latest message containing the selected words in order. A selection
 * across lines widens to the markdown syntax around it (`- `, `**`, fences, table pipes) and to whole lines where only
 * syntax lies between it and the line's edge. No single message holds it (tool output, several messages): the screen
 * text as selected.
 */
export function markdownForSelection(selected: string, messages: readonly string[]): string {
  const wanted = letters(selected).chars;
  if (wanted.length < 2) return selected;
  for (let m = messages.length - 1; m >= 0; m--) {
    const source = messages[m]!;
    const { chars, at } = letters(source);
    const found = chars.lastIndexOf(wanted);
    if (found < 0) continue;
    let start = at[found]!, end = at[found + wanted.length - 1]! + 1;
    if (!selected.includes("\n")) return source.slice(start, end);
    while (start > 0 && !/\s/.test(source[start - 1]!) && !word.test(source[start - 1]!)) start--;
    const lineStart = source.lastIndexOf("\n", start - 1) + 1;
    if (!/[\p{L}\p{N}]/u.test(source.slice(lineStart, start))) start = lineStart;
    while (end < source.length && !/\s/.test(source[end]!) && !word.test(source[end]!)) end++;
    const lineEnd = source.indexOf("\n", end) < 0 ? source.length : source.indexOf("\n", end);
    if (!/[\p{L}\p{N}]/u.test(source.slice(end, lineEnd))) end = lineEnd;
    // Selected rows with no letters (a closing fence, a rule) count when the source has that exact line next to it.
    const rows = selected.split("\n").map(row => row.trim());
    for (let r = rows.length - 1; r >= 0 && rows[r] && !word.test(rows[r]!); r--) {
      const next = source.indexOf("\n", end + 1) < 0 ? source.length : source.indexOf("\n", end + 1);
      if (source[end] !== "\n" || source.slice(end + 1, next).trim() !== rows[r]) break;
      end = next;
    }
    for (let r = 0; r < rows.length && rows[r] && !word.test(rows[r]!); r++) {
      const previous = source.lastIndexOf("\n", start - 2) + 1;
      if (start === 0 || source[start - 1] !== "\n" || source.slice(previous, start - 1).trim() !== rows[r]) break;
      start = previous;
    }
    return source.slice(start, end);
  }
  return selected;
}
