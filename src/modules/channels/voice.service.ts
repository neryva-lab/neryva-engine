import { Injectable, Logger } from '@nestjs/common';
import { env } from '../../common/config/env';
import { ChannelAccount } from './schema';
import { ChannelsService } from './channels.service';
import { META_GRAPH_VERSION } from './dto';

/**
 * FL-3.1 — voice pipeline (inbound ASR + outbound TTS) over the channel
 * plane. Realtime speech-to-speech (~800ms bar) needs a hosted vendor +
 * WebRTC transport and stays a DOCUMENTED SEAM (fl3_frontier_decisions.md);
 * the store-and-forward path here covers voice notes end-to-end:
 *
 *   inbound:  platform media id → bounded download → ASR port → text run
 *   outbound: reply text → TTS port → audio → GENERATED_MEDIA media send
 *
 * Every hop is bounded (10 MiB) and fail-soft: a missing port URL or a port
 * failure records the event without blocking the conversation — a voice
 * capability outage must never take text messaging down with it.
 */

const MAX_MEDIA_BYTES = 10 * 1024 * 1024;
const DOWNLOAD_DEADLINE_MS = 15_000;
const PORT_DEADLINE_MS = 20_000;

export interface VoiceMedia {
  account: ChannelAccount;
  mediaFamily: 'audio' | 'image' | 'document';
  mediaId: string;
  mediaUrl?: string;
  mimeType?: string;
}

@Injectable()
export class VoiceService {
  private static readonly logger = new Logger(VoiceService.name);

  constructor(private readonly channels: ChannelsService) {}

  /** Resolve the provider media id to bytes (bounded). Platform-specific. */
  async downloadMedia(media: VoiceMedia): Promise<Uint8Array | null> {
    const creds = this.channels.decryptCredentials(media.account);
    let url: string | null = null;
    let token: string | undefined;
    if (media.mediaUrl) {
      // Messenger/Instagram hands a CDN URL directly.
      url = media.mediaUrl;
    } else if (media.account.platform === 'whatsapp') {
      const mediaId = media.mediaId;
      url = mediaId ? `https://graph.facebook.com/${META_GRAPH_VERSION}/${mediaId}` : null;
      token = String(creds.access_token ?? '');
    } else if (media.account.platform === 'telegram') {
      const botToken = String(creds.bot_token ?? '');
      if (!botToken || !media.mediaId) {
        return null;
      }
      const path = await this.telegramFilePath(botToken, media.mediaId);
      url = path ? `https://api.telegram.org/file/bot${botToken}/${path}` : null;
    }
    if (!url) {
      return null;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_DEADLINE_MS);
    timer.unref();
    try {
      const res = await fetch(url, { headers: token ? { authorization: `Bearer ${token}` } : {}, signal: controller.signal });
      if (!res.ok) {
        throw new Error(`media download returned ${res.status}`);
      }
      const declared = Number(res.headers.get('content-length') ?? 0);
      if (declared > MAX_MEDIA_BYTES) {
        throw new Error(`media exceeds ${MAX_MEDIA_BYTES} bytes`);
      }
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.byteLength > MAX_MEDIA_BYTES) {
        throw new Error(`media exceeds ${MAX_MEDIA_BYTES} bytes`);
      }
      return buf;
    } catch (err) {
      VoiceService.logger.warn(`voice media download failed (${media.account.platform}): ${(err as Error).message}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** ASR port — POST {audio_base64, media_type} → {text}. Unset = unsupported. */
  async transcribe(audio: Uint8Array, mediaType: string): Promise<string | null> {
    const url = env.CHANNELS__VOICE_ASR_URL;
    if (!url) {
      return null;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PORT_DEADLINE_MS);
    timer.unref();
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ audio_base64: Buffer.from(audio).toString('base64'), media_type: mediaType.slice(0, 100) }),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`asr endpoint returned ${res.status}`);
      }
      const body = (await res.json()) as { text?: unknown };
      const text = typeof body.text === 'string' ? body.text.trim().slice(0, 8000) : '';
      return text.length > 0 ? text : null;
    } catch (err) {
      VoiceService.logger.warn(`voice transcription failed: ${(err as Error).message}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** TTS port — POST {text, voice} → {audio_base64, media_type}. Unset = off. */
  async synthesize(text: string): Promise<{ audio: Uint8Array; mediaType: string } | null> {
    const url = env.HARNESS__TTS_URL;
    if (!url) {
      return null;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PORT_DEADLINE_MS);
    timer.unref();
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: text.slice(0, 4000), voice: env.HARNESS__TTS_VOICE }),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`tts endpoint returned ${res.status}`);
      }
      const body = (await res.json()) as { audio_base64?: unknown; media_type?: unknown };
      if (typeof body.audio_base64 !== 'string' || body.audio_base64.length === 0) {
        throw new Error('tts payload malformed');
      }
      const audio = Buffer.from(body.audio_base64, 'base64');
      if (audio.byteLength > MAX_MEDIA_BYTES) {
        throw new Error(`tts audio exceeds ${MAX_MEDIA_BYTES} bytes`);
      }
      return { audio: new Uint8Array(audio), mediaType: typeof body.media_type === 'string' ? body.media_type : 'audio/mpeg' };
    } catch (err) {
      VoiceService.logger.warn(`voice synthesis failed: ${(err as Error).message}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private async telegramFilePath(botToken: string, fileId: string): Promise<string | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_DEADLINE_MS);
    timer.unref();
    try {
      const res = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`, { signal: controller.signal });
      if (!res.ok) {
        return null;
      }
      const body = (await res.json()) as { result?: { file_path?: unknown } };
      const path = body.result?.file_path;
      return typeof path === 'string' ? path : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
