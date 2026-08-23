/**
 * The outbound email port (corporate E-1). Templates render to both text
 * (deliverability, triage) and HTML (product surfaces). Values in braces
 * are interpolated by the template registry — never by callers building
 * strings, so every outbound body passes one chokepoint.
 */
export interface EmailMessage {
  template: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Transport-level headers (List-Unsubscribe et al.) — providers accept them natively. */
  headers?: Record<string, string>;
}

export interface EmailTransport {
  readonly name: string;
  send(message: EmailMessage): Promise<void>;
}
