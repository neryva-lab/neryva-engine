import { describe, it, expect } from 'vitest';
import { ValidationPipe } from '@nestjs/common';
import { MintSessionDto, WidgetMessageDto } from '../../src/modules/channels/widget.controller';

/**
 * G1 live-verification fix: the widget DTOs were decorator-less classes, so
 * the global forbidNonWhitelisted pipe 400d EVERY widget message body. The
 * real DTOs are imported (never mirrored — mirrors drift). Pure pipe test.
 */

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: { enableImplicitConversion: false },
});

describe('widget DTOs (G1 message path)', () => {
  it('admits message text', async () => {
    const out = (await pipe.transform({ text: 'Hello, refunds?' }, { type: 'body', metatype: WidgetMessageDto })) as WidgetMessageDto;
    expect(out.text).toBe('Hello, refunds?');
  });

  it('tolerates the header-mirrored idempotency key without reading it', async () => {
    const out = (await pipe.transform({ text: 'Hi', idempotency_key: 'k' }, { type: 'body', metatype: WidgetMessageDto })) as WidgetMessageDto;
    expect(out.text).toBe('Hi');
  });

  it('refuses empty/oversize text and unknown keys', async () => {
    await expect(pipe.transform({ text: '' }, { type: 'body', metatype: WidgetMessageDto })).rejects.toThrow();
    await expect(pipe.transform({ text: 'x'.repeat(16_001) }, { type: 'body', metatype: WidgetMessageDto })).rejects.toThrow();
    await expect(pipe.transform({ text: 'Hi', forged: true }, { type: 'body', metatype: WidgetMessageDto })).rejects.toThrow();
  });

  it('admits empty and turnstile-bearing session mints', async () => {
    await expect(pipe.transform({}, { type: 'body', metatype: MintSessionDto })).resolves.toBeDefined();
    const out = (await pipe.transform({ turnstile_token: 'tok' }, { type: 'body', metatype: MintSessionDto })) as MintSessionDto;
    expect(out.turnstile_token).toBe('tok');
  });
});
