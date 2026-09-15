import { ApiError } from '../../common/http/api-error';

/**
 * E-2 — source slug policy (pin addresses, not display names).
 *
 * A source slug is the immutable, org-unique address a knowledge pin
 * references. Kebab-case, 3–64 chars, starts/ends alphanumeric — the same
 * shape as agent/template slugs so one mental model covers every address
 * in the system.
 */

/** Normalize + validate a user-supplied slug (upload intent, rename). */
export function normalizeSourceSlug(raw: unknown): string {
  const slug = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(slug) || slug.length > 64) {
    throw ApiError.validation({
      source_slug: 'must be 3-64 characters: lowercase letters, digits, hyphens; starts and ends with a letter or digit',
    });
  }
  return slug;
}

/**
 * Derive a deterministic slug when the caller supplies none. One document
 * per artifact, so the artifact id suffix is unique by construction and
 * stable across ingestion retries of the same session.
 */
export function deriveSourceSlug(artifactId: string): string {
  const hex = artifactId.toLowerCase().replace(/[^a-z0-9]/g, '');
  return `doc-${hex.slice(0, 12)}`;
}

/** Derive a slug from a connector/seed title (best-effort; caller dedupes). */
export function slugifyTitle(title: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 56);
  return base.length >= 3 ? base : '';
}
