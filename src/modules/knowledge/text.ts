/**
 * Pure text utilities for the knowledge pipeline — no env, no DB, no I/O.
 * Kept dependency-free so unit tests import them hermetically.
 */

/** Bounded paragraph-aware chunking with hard caps. */
export function chunkText(text: string, chunkChars: number, maxChunks: number): Array<{ text: string; byteStart: number; byteEnd: number }> {
  const out: Array<{ text: string; byteStart: number; byteEnd: number }> = [];
  let cursor = 0;
  while (cursor < text.length && out.length < maxChunks) {
    let end = Math.min(cursor + chunkChars, text.length);
    if (end < text.length) {
      const breakAt = text.lastIndexOf('\n', end);
      if (breakAt > cursor + chunkChars / 2) {
        end = breakAt + 1;
      }
    }
    const piece = text.slice(cursor, end).trim();
    if (piece.length > 0) {
      out.push({ text: piece, byteStart: cursor, byteEnd: end });
    }
    cursor = end;
  }
  return out;
}
