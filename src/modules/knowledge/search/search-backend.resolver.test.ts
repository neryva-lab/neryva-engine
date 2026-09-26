import { describe, expect, it } from 'vitest';
import {
  isAtlasTopology,
  resolveSearchBackendKind,
} from './search-backend';

/**
 * Resolver unit tests (P4) — the automatic search-backend selection is a
 * pure function, so the whole priority table is provable without any
 * database. The fail-closed branches assert the error NAMES what is
 * missing (operator-actionable), never a silent fallback.
 */
describe('search backend resolver', () => {
  describe('isAtlasTopology', () => {
    it('detects standard Atlas hosts on both schemes', () => {
      expect(
        isAtlasTopology('mongodb+srv://user:pass@cluster0.abc123.mongodb.net/neryva'),
      ).toBe(true);
      expect(
        isAtlasTopology('mongodb://user:pass@cluster0.abc123.mongodb.net:27017/neryva'),
      ).toBe(true);
    });
    it('rejects self-hosted topologies', () => {
      expect(isAtlasTopology('mongodb://localhost:27017/neryva')).toBe(false);
      expect(isAtlasTopology('mongodb://mongo.internal:27017/neryva')).toBe(false);
      // SRV alone is not enough — a self-hosted cluster can publish SRV.
      expect(isAtlasTopology('mongodb+srv://mongo.internal/neryva')).toBe(false);
    });
    it('rejects garbage without throwing', () => {
      expect(isAtlasTopology('')).toBe(false);
      expect(isAtlasTopology('not-a-uri')).toBe(false);
    });
  });

  describe('resolveSearchBackendKind', () => {
    it('1. postgres → pgvector regardless of anything else', () => {
      expect(
        resolveSearchBackendKind({
          dbProvider: 'postgres',
          mongoUri: 'mongodb+srv://x@cluster0.abc.mongodb.net/db',
          qdrantUrl: 'http://qdrant:6333',
          qdrantReachable: true,
        }),
      ).toBe('pgvector');
    });

    it('2. mongodb + Atlas → atlas-vector-search (Qdrant ignored)', () => {
      expect(
        resolveSearchBackendKind({
          dbProvider: 'mongodb',
          mongoUri: 'mongodb+srv://u:p@cluster0.abc123.mongodb.net/neryva',
          qdrantUrl: 'http://qdrant:6333',
          qdrantReachable: true,
        }),
      ).toBe('atlas-vector-search');
    });

    it('3. mongodb + reachable QDRANT_URL → qdrant', () => {
      expect(
        resolveSearchBackendKind({
          dbProvider: 'mongodb',
          mongoUri: 'mongodb://localhost:27017/neryva',
          qdrantUrl: 'http://qdrant:6333',
          qdrantReachable: true,
        }),
      ).toBe('qdrant');
    });

    it('4a. mongodb, QDRANT_URL set but unreachable → fail closed naming the URL', () => {
      expect(() =>
        resolveSearchBackendKind({
          dbProvider: 'mongodb',
          mongoUri: 'mongodb://localhost:27017/neryva',
          qdrantUrl: 'http://qdrant:6333',
          qdrantReachable: false,
          qdrantProbeError: 'fetch failed',
        }),
      ).toThrow(/QDRANT_URL=http:\/\/qdrant:6333.*unreachable.*fetch failed/);
    });

    it('4b. mongodb, no Atlas, no QDRANT_URL → fail closed naming the options', () => {
      expect(() =>
        resolveSearchBackendKind({
          dbProvider: 'mongodb',
          mongoUri: 'mongodb://localhost:27017/neryva',
        }),
      ).toThrow(/MongoDB Atlas.*QDRANT_URL/);
    });

    it('never suggests lexical-only as acceptable', () => {
      let message = '';
      try {
        resolveSearchBackendKind({
          dbProvider: 'mongodb',
          mongoUri: 'mongodb://localhost:27017/neryva',
        });
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toMatch(/refusing to boot/i);
      expect(message).not.toMatch(/lexical-only.*fallback|fallback.*lexical/i);
    });
  });
});
