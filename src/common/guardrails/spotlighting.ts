/**
 * Spotlighting — untrusted-content marking for prompt assembly
 * (ai_harness_plan.md H0.5; technique per arXiv:2403.14720).
 *
 * Untrusted content (knowledge snippets, memory text, tool results, channel
 * free text) is delimited AND datamarked before it is placed near trusted
 * instructions, so the model can distinguish data from instructions. This is
 * a probabilistic defense layer, not a security boundary: the hard boundary
 * remains tool authorization + Engine policy checks. The format is shared
 * with Agent Studio (packages/security) — keep the prefix and delimiters
 * byte-identical in both implementations.
 */

export const SPOTLIGHT_PREFIX = 'nv-untrusted:v1';
const OPEN = `<${SPOTLIGHT_PREFIX}>`;
const CLOSE = `</${SPOTLIGHT_PREFIX}>`;
/** Datamark inserted at confusable boundaries inside the payload. */
const DATAMARK = '·';

export type UntrustedSource = 'knowledge' | 'memory' | 'tool_result' | 'channel_input' | 'user_attachment';

function sanitizePayload(payload: string): string {
  // A payload containing the closing delimiter could break out of the
  // spotlight; neutralize any occurrence before wrapping.
  const withoutDelims = payload.split(CLOSE).join(CLOSE.replace('<', '‹').replace('>', '›'));
  return withoutDelims.split(OPEN).join(OPEN.replace('<', '‹').replace('>', '›'));
}

/**
 * Wrap untrusted content for prompt inclusion. `datamark` additionally
 * inserts boundary markers between every confusable run (newlines and
 * long whitespace), the "datamarking" variant of spotlighting.
 */
export function spotlight(input: { source: UntrustedSource; content: string; datamark?: boolean }): string {
  const inner = sanitizePayload(input.content);
  const marked = input.datamark
    ? inner.replace(/(\r?\n|[ \t]{4,})/g, `${DATAMARK}$1`)
    : inner;
  return `${OPEN}source=${input.source}\n${marked}\n${CLOSE}`;
}

/** True when the payload is already spotlighted (idempotent assembly). */
export function isSpotlighted(payload: string): boolean {
  return payload.startsWith(OPEN) && payload.endsWith(CLOSE);
}
