/**
 * Extraction ports (FL-2.6) — the ingestion pipeline's EXTRACT stage
 * dispatches by media type across these adapters. Everything is a bounded
 * HTTP port to a self-hosted service (OCR: OCRmyPDF/Tesseract-style worker;
 * transcription: Whisper-class /v1/audio/transcriptions); when the env URL
 * is absent the adapter is not registered and the pipeline fails with a
 * clear `unsupported media type` instead of silently indexing garbage.
 *
 * Table-aware chunking lives in text.ts (chunkText prefers boundaries that
 * do not split markdown table rows).
 */

export interface ExtractionResult {
  text: string;
  parserVersion: string;
}

export interface TextExtractorPort {
  readonly parserVersion: string;
  supports(mediaType: string): boolean;
  extract(input: { bytes: Buffer; mediaType: string }): Promise<ExtractionResult>;
}

/** text/* + application/json — the original Phase 7 path. */
export class PlainTextExtractor implements TextExtractorPort {
  readonly parserVersion = 'text-v1';

  supports(mediaType: string): boolean {
    return mediaType.startsWith('text/') || mediaType === 'application/json';
  }

  async extract(input: { bytes: Buffer; mediaType: string }): Promise<ExtractionResult> {
    void input.mediaType;
    return { text: input.bytes.toString('utf8'), parserVersion: this.parserVersion };
  }
}

/** Scanned documents (PDF/images) via an OCR HTTP worker. */
export class HttpOcrExtractor implements TextExtractorPort {
  readonly parserVersion = 'ocr-v1';

  constructor(private readonly url: string) {}

  supports(mediaType: string): boolean {
    return mediaType === 'application/pdf' || mediaType.startsWith('image/');
  }

  async extract(input: { bytes: Buffer; mediaType: string }): Promise<ExtractionResult> {
    const res = await fetch(this.url.replace(/\/$/, '') + '/extract', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ media_type: input.mediaType, data_base64: input.bytes.toString('base64') }),
    });
    if (!res.ok) {
      throw new Error(`ocr worker HTTP ${res.status}`);
    }
    const body = (await res.json()) as { text?: string };
    return { text: String(body.text ?? '').slice(0, 1_000_000), parserVersion: this.parserVersion };
  }
}

/** Audio/video via a Whisper-class transcription HTTP worker. */
export class HttpTranscribeExtractor implements TextExtractorPort {
  readonly parserVersion = 'asr-v1';

  constructor(private readonly url: string) {}

  supports(mediaType: string): boolean {
    return mediaType.startsWith('audio/') || mediaType.startsWith('video/');
  }

  async extract(input: { bytes: Buffer; mediaType: string }): Promise<ExtractionResult> {
    const res = await fetch(this.url.replace(/\/$/, '') + '/transcribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ media_type: input.mediaType, data_base64: input.bytes.toString('base64') }),
    });
    if (!res.ok) {
      throw new Error(`transcription worker HTTP ${res.status}`);
    }
    const body = (await res.json()) as { text?: string };
    return { text: String(body.text ?? '').slice(0, 1_000_000), parserVersion: this.parserVersion };
  }
}

/**
 * Build the extractor chain from typed env — the ORDER is the dispatch
 * priority (plain text first: a text/csv never routes to OCR). Absent URLs
 * simply drop the corresponding adapter.
 */
export function buildExtractorChain(opts: { ocrUrl?: string; transcribeUrl?: string }): TextExtractorPort[] {
  const chain: TextExtractorPort[] = [new PlainTextExtractor()];
  if (opts.ocrUrl) {
    chain.push(new HttpOcrExtractor(opts.ocrUrl));
  }
  if (opts.transcribeUrl) {
    chain.push(new HttpTranscribeExtractor(opts.transcribeUrl));
  }
  return chain;
}
