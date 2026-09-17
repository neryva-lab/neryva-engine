import { describe, it, expect } from 'vitest';
import { ValidationPipe } from '@nestjs/common';
import { CreateVersionDto, ImportVersionDto } from '../../src/modules/assistants/dto';

/**
 * R-1 regression (team_setup_ledger.md §3): the assistants service consumes
 * the FULL AssistantPayload on version writes (instructions / model_params /
 * budget_policy live on the version row), so CreateVersionDto must admit
 * those keys — the global forbidNonWhitelisted pipe 400s anything the DTO
 * does not declare. Pure pipe test, no DB.
 */

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: { enableImplicitConversion: false },
});

const policies = {
  model_policy: { allowed_models: ['acme/reasoner-1'] },
  context_policy: { history_limit: 20 },
  tool_policy: { tools: [{ name: 'search_knowledge', access: 'read' }] },
  guardrail_policy: { input_policy: 'default', output_policy: 'brand-safe' },
};

async function transform(body: unknown): Promise<unknown> {
  return pipe.transform(body, { type: 'body', metatype: CreateVersionDto });
}

describe('CreateVersionDto (R-1 full-payload admission)', () => {
  it('accepts the five policy keys alone (legacy shape)', async () => {
    const out = (await transform({ ...policies })) as CreateVersionDto;
    expect(out.model_policy.allowed_models).toEqual(['acme/reasoner-1']);
  });

  it('admits instructions / model_params / budget_policy alongside the policies', async () => {
    const out = (await transform({
      ...policies,
      instructions: 'You are a support concierge. Cite sources.',
      model_params: { temperature: 0.3, max_output_tokens: 1024 },
      budget_policy: { max_total_tokens: 180000, max_tool_calls: 12, max_model_calls: 8 },
    })) as CreateVersionDto;
    expect(out.instructions).toBe('You are a support concierge. Cite sources.');
    expect(out.model_params).toMatchObject({ temperature: 0.3 });
    expect(out.budget_policy).toMatchObject({ max_total_tokens: 180000 });
  });

  it('still refuses unknown top-level keys (fail closed)', async () => {
    // NOTE: `brand` used to be the example here — it is a first-class key
    // since G4. max_context_tokens stays consumer-side only.
    await expect(transform({ ...policies, max_context_tokens: 32000 })).rejects.toThrow();
  });

  it('leaves presence enforcement to the service (zod requires the four policy objects)', async () => {
    // @ValidateNested() skips undefined — the pipe admits, the service 422s
    // via assistantPayloadSchema (model/context/tool/guardrail are required
    // there). Assert the service half here so the contract stays pinned.
    const { validateAssistantPayload } = await import('../../src/modules/assistants/validation');
    const result = validateAssistantPayload({ instructions: 'x' });
    expect(result.ok).toBe(false);
  });

  it('admits brand voice on version writes (G4 first-class, ≤2000)', async () => {
    const out = (await transform({ ...policies, brand: 'Warm, precise.' })) as CreateVersionDto;
    expect(out.brand).toBe('Warm, precise.');
    await expect(transform({ ...policies, brand: 'x'.repeat(2001) })).rejects.toThrow();
  });

  it('admits full export envelopes on import (G5 round-trip)', async () => {
    const envelope = {
      schema_version: 2,
      instructions: 'You are a probe.',
      model_params: { temperature: 0.3 },
      budget_policy: { max_tool_calls: 5 },
      brand: 'Warm.',
      ...policies,
      hash: 'h'.repeat(64),
    };
    const out = (await pipe.transform(envelope, { type: 'body', metatype: ImportVersionDto })) as ImportVersionDto;
    expect(out.brand).toBe('Warm.');
    expect(out.instructions).toBe('You are a probe.');
  });
});
