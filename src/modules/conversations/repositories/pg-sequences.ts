import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

/**
 * Message sequence allocation shared by the pg run + escalation
 * implementations. The caller holds the conversation row lock (FOR UPDATE)
 * before calling, which makes the MAX(sequence)+1 allocation airtight
 * against any second writer.
 */
export async function nextMessageSequence(
  tx: NodePgDatabase,
  conversationId: string,
): Promise<number> {
  const res = await tx.execute(
    sql`select coalesce(max(sequence), 0) + 1 as next from messages where conversation_id = ${conversationId}::uuid`,
  );
  return Number((res.rows[0] as { next: string | number }).next);
}
