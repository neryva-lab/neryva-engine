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

  'identity.password-reset': {
    subject: (v) => 'Reset your Neryva password',
    text: (v) => render('Reset your Neryva password (link expires in {ttl_minutes} minutes):\n{reset_url}\n\nIf you did not request a reset, ignore this email — your password is unchanged.\n', v),
    html: (v) =>
      wrapHtml(
        'Reset your Neryva password',
        `<p>Reset your Neryva password (link expires in ${esc(v.ttl_minutes)} minutes):</p>
<p><a href="${esc(v.reset_url)}" style="display:inline-block;background:#111;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">Reset password</a></p>
<p style="color:#777">If you did not request a reset, ignore this email — your password is unchanged.</p>`,
      ),
  },

  'identity.email-verification': {
    subject: () => 'Verify your Neryva email address',
    text: (v) => render('Confirm your email address (link expires in {ttl_minutes} minutes):\n{verify_url}\n\nIf you did not create a Neryva account, ignore this email.\n', v),
    html: (v) =>
      wrapHtml(
        'Verify your email address',
        `<p>Confirm your email address for Neryva (link expires in ${esc(v.ttl_minutes)} minutes):</p>
<p><a href="${esc(v.verify_url)}" style="display:inline-block;background:#111;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">Verify email</a></p>
<p style="color:#777">If you did not create a Neryva account, ignore this email.</p>`,
      ),
  },

  'identity.mfa-enabled': {
    subject: () => 'Two-factor authentication enabled on your Neryva account',
    text: () => 'Two-factor authentication (TOTP) was just enabled on your Neryva account.\nIf this was not you, contact support immediately.\n',
    html: () =>
      wrapHtml(
        'Two-factor authentication enabled',
        '<p>Two-factor authentication (TOTP) was just enabled on your Neryva account.</p><p style="color:#777">If this was not you, contact support immediately.</p>',
      ),
  },

  'identity.mfa-disabled': {
    subject: () => 'Two-factor authentication disabled on your Neryva account',
    text: () => 'Two-factor authentication was just disabled on your Neryva account.\nIf this was not you, contact support immediately.\n',
    html: () =>
      wrapHtml(
        'Two-factor authentication disabled',
        '<p>Two-factor authentication was just disabled on your Neryva account.</p><p style="color:#777">If this was not you, contact support immediately.</p>',
      ),
  },

  'org.ownership-transferred': {
    subject: (v) => `Ownership of ${v.org_name} on Neryva was transferred to you`,
    text: (v) => render('You are now the owner of "{org_name}" on Neryva (transferred by {from_email}).\nThe previous owner is now an admin.\n', v),
    html: (v) =>
      wrapHtml(
        `You now own ${v.org_name}`,
        `<p>You are now the <strong>owner</strong> of <strong>${esc(v.org_name)}</strong> on Neryva (transferred by ${esc(v.from_email)}).</p><p>The previous owner is now an admin.</p>`,
      ),
  },

  'org.role-changed': {
    subject: (v) => `Your role in ${v.org_name} on Neryva is now ${v.role}`,
    text: (v) => render('Your role in "{org_name}" on Neryva was changed from {from_role} to {to_role} by {actor_email}.\n', v),
    html: (v) =>
      wrapHtml(
        `Your role in ${v.org_name} changed`,
        `<p>Your role in <strong>${esc(v.org_name)}</strong> on Neryva was changed from <strong>${esc(v.from_role)}</strong> to <strong>${esc(v.to_role)}</strong> by ${esc(v.actor_email)}.</p>`,
      ),
  },

  'org.member-suspended': {
    subject: (v) => `Your access to ${v.org_name} on Neryva was suspended`,
    text: (v) => render('A member of "{org_name}" on Neryva suspended your access ({actor_email}).\nContact an administrator of the organization if you believe this is a mistake.\n', v),
    html: (v) =>
      wrapHtml(
        `Your access to ${v.org_name} was suspended`,
        `<p>A member of <strong>${esc(v.org_name)}</strong> on Neryva suspended your access (${esc(v.actor_email)}).</p><p style="color:#777">Contact an administrator of the organization if you believe this is a mistake.</p>`,
      ),
  },

  'org.member-removed': {
    subject: (v) => `You were removed from ${v.org_name} on Neryva`,
    text: (v) => render('You were removed from "{org_name}" on Neryva by {actor_email}.\nYou no longer have access to the organization\'s resources.\n', v),
    html: (v) =>
      wrapHtml(
        `You were removed from ${v.org_name}`,
        `<p>You were removed from <strong>${esc(v.org_name)}</strong> on Neryva by ${esc(v.actor_email)}.</p><p style="color:#777">You no longer have access to the organization's resources.</p>`,
      ),
  },

  'org.deletion-requested': {
    subject: (v) => `Deletion of ${v.org_name} on Neryva was scheduled`,
    text: (v) =>
      render(
        'Deletion of "{org_name}" on Neryva was requested.\n\nAll product entitlements were expired, invites and API keys revoked immediately.\nThe organization will be permanently purged on {purge_date}.\nUntil then you can cancel from Settings, or export your data.\n',
        v,
      ),
    html: (v) =>
      wrapHtml(
        `Deletion of ${v.org_name} was scheduled`,
        `<p>Deletion of <strong>${esc(v.org_name)}</strong> on Neryva was requested.</p>
<p>All product entitlements were expired; invites and API keys were revoked immediately.</p>
<p>The organization will be permanently purged on <strong>${esc(v.purge_date)}</strong>. Until then you can cancel from Settings, or export your data.</p>`,
      ),
  },

  'org.deletion-cancelled': {
    subject: (v) => `Deletion of ${v.org_name} on Neryva was cancelled`,
    text: (v) => render('The scheduled deletion of "{org_name}" on Neryva was cancelled.\nNote: expired entitlements and revoked keys are NOT restored automatically — contact billing to re-enable products.\n', v),
    html: (v) =>
      wrapHtml(
        `Deletion of ${v.org_name} was cancelled`,
        `<p>The scheduled deletion of <strong>${esc(v.org_name)}</strong> on Neryva was cancelled.</p><p style="color:#777">Expired entitlements and revoked keys are not restored automatically — contact billing to re-enable products.</p>`,
      ),
  },

  'notification.generic': {
    subject: (v) => v.title,
    text: (v) => render('{title}\n\n{body}\n', v),
    html: (v) => wrapHtml(esc(v.title), `<p>${esc(v.body)}</p>`),
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

  'corporate.contact-ack': {
    subject: () => 'We received your message — Neryva',
    text: (v) => render('Hi {name},\n\nThank you for reaching out to Neryva. We received your message and will reply within one business day.\n\n— The Neryva team\n', v),
    html: (v) =>
      wrapHtml(
        'We received your message',
        `<p>Hi ${esc(v.name)},</p>
<p>Thank you for reaching out to Neryva. We received your message and will reply within one business day.</p>
<p>— The Neryva team</p>`,
      ),
  },

  'corporate.career-ack': {
    subject: (v) => `Application received — ${v.position} at Neryva`,
    text: (v) => render('Hi {name},\n\nThank you for applying for the {position} role at Neryva. We review every application and will be in touch about next steps.\n\n— The Neryva team\n', v),
    html: (v) =>
      wrapHtml(
        'Application received',
        `<p>Hi ${esc(v.name)},</p>
<p>Thank you for applying for the <strong>${esc(v.position)}</strong> role at Neryva. We review every application and will be in touch about next steps.</p>
<p>— The Neryva team</p>`,
      ),
  },

  'newsletter.campaign': {
    subject: (v) => v.subject,
    text: (v) => render('{subject}\n\n{preheader}\n\n{body_text}\n\n— Neryva\n\nUnsubscribe: {unsubscribe_url}\n', v),
    html: (v) =>
      wrapHtml(
        v.subject,
        `${v.preheader ? `<p style="color:#777;font-size:14px">${esc(v.preheader)}</p>` : ''}
<div style="font-size:15px;white-space:pre-wrap">${esc(v.body_text)}</div>
<hr style="border:none;border-top:1px solid #e5e5e5;margin-top:32px">
<p style="font-size:12px;color:#777">You receive this because you subscribed at neryva.com. <a href="${esc(v.unsubscribe_url)}" style="color:#777">Unsubscribe</a>.</p>`,
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
