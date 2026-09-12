/**
 * PII redaction executor — deterministic pattern-based v1
 * (ai_harness_plan.md H0.5). Applied to what the MODEL sees (manifest
 * content), never to stored history: messages are immutable and the user's
 * own words are business truth. Provider-classifier redaction plugs in later
 * behind the same interface.
 *
 * Never log matches or originals — redaction output only.
 */

export interface RedactionResult {
  redacted: string;
  matchCount: number;
}

interface Rule {
  name: string;
  pattern: RegExp;
  /** Fixed replacement keeps redaction deterministic for hashing/idempotency. */
  replacement: string;
}

const RULES: Rule[] = [
  { name: 'email', pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, replacement: '[EMAIL]' },
  // International-ish phone numbers: +country, or (xxx) xxx-xxxx, or xxx-xxx-xxxx.
  { name: 'phone', pattern: /(?:\+?\d{1,3}[-. ]?)?\(?\d{3}\)?[-. ]\d{3}[-. ]\d{4}/g, replacement: '[PHONE]' },
  // Payment cards with separators or 13-19 raw digits (IIN-range agnostic v1).
  { name: 'card', pattern: /\b(?:\d[ -]?){13,19}\b/g, replacement: '[PAYMENT_CARD]' },
  // High-confidence identifiers.
  { name: 'iban', pattern: /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g, replacement: '[IBAN]' },
  { name: 'ssn', pattern: /\b\d{3}-\d{2}-\d{4}\b/g, replacement: '[US_SSN]' },
  // Bearer-shaped secrets — never let a token leak into a prompt.
  { name: 'bearer', pattern: /\b(?:Bearer|sk-|nrv_live_|nk_live_|ghp_|github_pat_)[A-Za-z0-9._-]{8,}/g, replacement: '[REDACTED_SECRET]' },
];

export function redactPii(text: string): RedactionResult {
  let out = text;
  let matchCount = 0;
  for (const rule of RULES) {
    out = out.replace(rule.pattern, () => {
      matchCount += 1;
      return rule.replacement;
    });
  }
  return { redacted: out, matchCount };
}
