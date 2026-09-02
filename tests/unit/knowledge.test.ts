import { describe, it, expect } from 'vitest';
import { chunkText } from '../../src/modules/knowledge/text';
import { lexicalHashVector } from '../../src/modules/knowledge/embedding.service';
import { EMBEDDING_DIMENSIONS } from '../../src/modules/knowledge/schema';

/**
 * Phase 7 unit tests — bounded chunking + deterministic embedding (pure
 * functions, no DB/S3). Pipeline stages, RLS, and retrieval are exercised by
 * the integration/isolation suites against real PostgreSQL + MinIO.
 */
describe('knowledge chunking', () => {
  it('respects the chunk cap and produces ordered, non-empty pieces', () => {
    const text = Array.from({ length: 400 }, (_, i) => `paragraph ${i} ${'x'.repeat(50)}`).join('\n');
    const chunks = chunkText(text, 1000, 500);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.length).toBeLessThanOrEqual(500);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].byteStart).toBeGreaterThanOrEqual(chunks[i - 1].byteEnd);
      expect(chunks[i].text.length).toBeGreaterThan(0);
    }
  });

  it('returns nothing for empty content (ingestion fails loudly instead)', () => {
    expect(chunkText('', 1000, 500)).toHaveLength(0);
    expect(chunkText('   \n  \n ', 1000, 500)).toHaveLength(0);
  });

  it('keeps every piece within the char budget (trimmed)', () => {
    const text = 'word '.repeat(5_000);
    const chunks = chunkText(text, 500, 100);
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(500);
    }
  });
});

describe('local embedding', () => {
  it('is deterministic and L2-normalized', () => {
    const a = lexicalHashVector('refund policy for enterprise plans', EMBEDDING_DIMENSIONS);
    const b = lexicalHashVector('refund policy for enterprise plans', EMBEDDING_DIMENSIONS);
    expect(a).toEqual(b);
    const norm = Math.sqrt(a.reduce((acc, v) => acc + v * v, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  it('different texts produce different vectors', () => {
    const a = lexicalHashVector('quarterly revenue report', EMBEDDING_DIMENSIONS);
    const b = lexicalHashVector('how do I reset my password', EMBEDDING_DIMENSIONS);
    const dot = a.reduce((acc, v, i) => acc + v * b[i], 0);
    expect(dot).toBeLessThan(0.99);
  });
});
