import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from './schema';

/**
 * Embedding port — Phase 7.5. The `local` provider is a deterministic
 * lexical hash (bag-of-words hashed into a fixed-width L2-normalized
 * vector): reproducible, dependency-free, good enough to exercise the
 * pipeline and retrieval mechanics in dev/test. It is NOT semantic —
 * production wires a real embedding provider here (env EMBEDDING_PROVIDER);
 * the retrieval contract (ACL before scoring) does not change.
 */
export interface EmbeddingPort {
  readonly model: string;
  embed(texts: string[]): Promise<number[][]>;
}

@Injectable()
export class EmbeddingService implements EmbeddingPort {
  readonly model = EMBEDDING_MODEL;

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => lexicalHashVector(text, EMBEDDING_DIMENSIONS));
  }
}

/**
 * Deterministic lexical hashing: tokenize, hash each token into the
 * dimension space with sign folding, L2-normalize. Same text always yields
 * the same vector (idempotent re-ingestion); different texts collide only
 * spuriously, as with any hash.
 */
export function lexicalHashVector(text: string, dimensions: number): number[] {
  const vec = new Array<number>(dimensions).fill(0);
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
  for (const token of tokens) {
    const h = createHash('sha256').update(token).digest();
    const idx = ((h[0] << 8) | h[1]) % dimensions;
    const sign = h[2] % 2 === 0 ? 1 : -1;
    vec[idx] += sign;
  }
  const norm = Math.sqrt(vec.reduce((acc, v) => acc + v * v, 0));
  if (norm === 0) {
    return vec;
  }
  return vec.map((v) => v / norm);
}
