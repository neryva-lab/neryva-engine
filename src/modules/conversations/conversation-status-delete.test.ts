/**
 * A3-06 — soft-delete via conversation status.
 *
 * `status: 'deleted'` is the user-facing delete: the row is kept for
 * audit/retention, lists hide it, and direct reads 404. This test pins the
 * DTO contract (only 'active' | 'archived' | 'deleted' validate).
 */
import { describe, expect, it } from 'vitest';
import { validate } from 'class-validator';
import { UpdateConversationStatusDto } from './dto';

async function validateStatus(status: unknown): Promise<string[]> {
  const dto = new UpdateConversationStatusDto();
  (dto as { status: unknown }).status = status;
  const errors = await validate(dto);
  return errors.flatMap((e) => Object.values(e.constraints ?? {}));
}

describe('UpdateConversationStatusDto', () => {
  it.each(['active', 'archived', 'deleted'])('accepts %s', async (status) => {
    expect(await validateStatus(status)).toEqual([]);
  });

  it.each(['', 'purged', 'ACTIVE', null, undefined, 42])('rejects %j', async (status) => {
    const messages = await validateStatus(status);
    expect(messages.length).toBeGreaterThan(0);
  });
});
