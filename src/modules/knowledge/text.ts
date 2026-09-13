/**
 * Pure text utilities for the knowledge pipeline — no env, no DB, no I/O.
 * Kept dependency-free so unit tests import them hermetically.
 */

/** Bounded paragraph-aware chunking with hard caps and optional overlap (FL-2.3). */
export function chunkText(
  text: string,
  chunkChars: number,
  maxChunks: number,
  overlapChars = 0,
): Array<{ text: string; byteStart: number; byteEnd: number }> {
  const out: Array<{ text: string; byteStart: number; byteEnd: number }> = [];
  const overlap = Math.min(Math.max(0, overlapChars), Math.floor(chunkChars / 2));
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
    // Overlap: the next chunk re-opens inside the previous one so boundary
    // sentences appear in both — a recall lever, bounded to half a chunk.
    cursor = end > overlap && end < text.length ? end - overlap : end;
  }
  return out;
}
