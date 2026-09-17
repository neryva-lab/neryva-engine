import { describe, it, expect } from 'vitest';
import { ValidationPipe } from '@nestjs/common';
import { SearchDto } from '../../src/modules/knowledge/knowledge.controller';

/**
 * Search query coercion (team_setup_ledger.md live verification): query
 * params arrive as strings, and the global pipe runs with implicit
 * conversion OFF — without @Type(() => Number), ?limit=5 400d every
 * limited search. Pure pipe test, no DB.
 */

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: { enableImplicitConversion: false },
});

async function transform(query: unknown): Promise<SearchDto> {
  return pipe.transform(query, { type: 'query', metatype: SearchDto }) as Promise<SearchDto>;
}

describe('SearchDto query coercion', () => {
  it('coerces string limits from the query string', async () => {
    const out = await transform({ query: 'refund', limit: '5' });
    expect(out.limit).toBe(5);
  });

  it('works without a limit (service default applies)', async () => {
    const out = await transform({ query: 'refund' });
    expect(out.limit).toBeUndefined();
  });

  it('still refuses non-integer limits', async () => {
    await expect(transform({ query: 'refund', limit: 'many' })).rejects.toThrow();
  });

  it('still requires the query', async () => {
    await expect(transform({ limit: '5' })).rejects.toThrow();
  });
});
