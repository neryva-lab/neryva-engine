/**
 * Shared model-alias qualification — used by both the manifest assembly
 * (mcp-authority.service.ts) and the publish-time snapshot resolution
 * (manifest-resolution.service.ts).
 *
 * Rules: an alias already containing '/' passes through untouched; a bare
 * alias matching exactly one active catalog row becomes `provider/model_id`;
 * anything else (unknown, or ambiguous across providers) passes through
 * unchanged — a genuinely unknown model must fail loudly downstream
 * (fail-closed), never be silently rewritten to a guess.
 */
export function qualifyModelAliases(
  aliases: string[],
  catalog: Array<{ provider: string; modelId: string }>,
): string[] {
  const providersByModelId = new Map<string, string[]>();
  for (const row of catalog) {
    const list = providersByModelId.get(row.modelId) ?? [];
    list.push(row.provider);
    providersByModelId.set(row.modelId, list);
  }
  return aliases.map((alias) => {
    if (alias.includes('/')) return alias;
    const providers = providersByModelId.get(alias) ?? [];
    const sole = providers.length === 1 ? providers[0] : undefined;
    if (sole === undefined) return alias;
    return `${sole}/${alias}`;
  });
}
