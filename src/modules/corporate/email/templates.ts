/**
 * Template registry. Every outbound email shape lives here — the single
 * place marketing/legal can audit. Interpolation escapes for HTML context;
 * codes and tokens are already URL-safe strings by construction.
 */
export interface EmailTemplate {
  subject: (vars: Record<string, string>) => string;
  text: (vars: Record<string, string>) => string;
  html?: (vars: Record<string, string>) => string;
}

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function render(template: string, vars: Record<string, string>): string {
  return template.replace(/\{([a-z_]+)\}/g, (_, key: string) => vars[key] ?? '');
}

const wrapHtml = (title: string, bodyHtml: string): string => `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(title)}</title></head>
<body style="font-family:system-ui,-apple-system,sans-serif;line-height:1.6;color:#111;max-width:560px;margin:0 auto;padding:24px">
${bodyHtml}
<hr style="border:none;border-top:1px solid #e5e5e5;margin-top:32px">
<p style="font-size:12px;color:#777">Neryva · This is an automated message from Neryva. If you did not expect it, ignore it.</p>
</body></html>`;

export const Templates: Record<string, EmailTemplate> = {
  'identity.login-code': {
    subject: (v) => `Your Neryva sign-in code: ${v.code}`,
    text: (v) =>
      render(
        'Enter this code to sign in to Neryva:\n\n  {code}\n\nThe code expires in {ttl_minutes} minutes.\nIf you did not try to sign in, ignore this email.\n',
        v,
      ),
    html: (v) =>
      wrapHtml(
        'Your Neryva sign-in code',
        `<p>Enter this code to sign in to Neryva:</p>
<p style="font-size:28px;letter-spacing:6px;font-weight:600;margin:16px 0">${esc(v.code)}</p>
<p>The code expires in ${esc(v.ttl_minutes)} minutes.</p>
<p style="color:#777">If you did not try to sign in, ignore this email.</p>`,
      ),
  },

  'identity.password-changed': {
    subject: () => 'Your Neryva password was changed',
    text: () => 'Your Neryva account password was just changed.\nIf this was not you, contact support immediately.\n',
    html: () =>
      wrapHtml(
        'Your Neryva password was changed',
        '<p>Your Neryva account password was just changed.</p><p style="color:#777">If this was not you, contact support immediately.</p>',
      ),
  },

  'org.invite': {
    subject: (v) => `${v.inviter} invited you to join ${v.org_name} on Neryva`,
    text: (v) =>
      render(
        '{inviter} invited you to join "{org_name}" on Neryva as {role}.\n\nAccept the invitation within {ttl_days} days:\n{accept_url}\n\nIf you do not have a Neryva account yet, the link creates one with this email.\n',
        v,
      ),
    html: (v) =>
      wrapHtml(
        `Join ${v.org_name} on Neryva`,
        `<p><strong>${esc(v.inviter)}</strong> invited you to join <strong>${esc(v.org_name)}</strong> on Neryva as <strong>${esc(v.role)}</strong>.</p>
<p><a href="${esc(v.accept_url)}" style="display:inline-block;background:#111;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">Accept invitation</a></p>
<p style="color:#777">This link expires in ${esc(v.ttl_days)} days. If you do not have a Neryva account yet, the link creates one with this email.</p>`,
      ),
  },

  'newsletter.double-opt-in': {
    subject: () => 'Confirm your Neryva newsletter subscription',
    text: (v) => render('Confirm your subscription:\n{confirm_url}\n\nIf you did not subscribe, ignore this email.\n', v),
    html: (v) =>
      wrapHtml(
        'Confirm your subscription',
        `<p>Confirm your Neryva newsletter subscription:</p>
<p><a href="${esc(v.confirm_url)}" style="display:inline-block;background:#111;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">Confirm subscription</a></p>`,
      ),
  },
};

export function renderTemplate(name: string, vars: Record<string, string>): { subject: string; text: string; html?: string } {
  const template = Templates[name];
  if (!template) {
    throw new Error(`unknown email template: ${name}`);
  }
  return { subject: template.subject(vars), text: template.text(vars), html: template.html?.(vars) };
}
