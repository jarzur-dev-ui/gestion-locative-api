// ---------------------------------------------------------------------------
// Email templates
// ---------------------------------------------------------------------------
//
// All templates return `{ subject, html, text }`. The HTML is intentionally
// simple (600px centred container, inline styles, no <table>-based layout) so
// it renders consistently across Gmail, Apple Mail and Outlook without a build
// step. The plain-text variant is the deliverability fallback for clients that
// strip HTML and for spam-score reasons.
//
// All caller-supplied values go through `escapeHtml` before being interpolated
// into the HTML, so a `<script>` in a recipient name cannot leak into the
// rendered message body.
// ---------------------------------------------------------------------------

/**
 * Minimal HTML escaper — covers the five characters that have a syntactic role
 * in HTML element / attribute contexts. Sufficient for our template usage
 * because we never interpolate inside `<script>`, `<style>` or unquoted URL
 * attributes.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Wrap a body fragment in the shared shell : 600px centred container, neutral
 * background, small "zeleph" footer. Kept as a single function so a tweak to
 * the look-and-feel propagates to every template at once.
 */
function shell(bodyHtml: string): string {
  return `<!doctype html>
<html lang="fr">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body style="margin:0;padding:0;background-color:#f4f4f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1f2937;">
    <div style="max-width:600px;margin:0 auto;padding:32px 16px;">
      <div style="background-color:#ffffff;border-radius:8px;padding:32px;box-shadow:0 1px 3px rgba(0,0,0,0.06);">
        ${bodyHtml}
      </div>
      <p style="text-align:center;font-size:12px;color:#9ca3af;margin-top:24px;">
        Cet email vous est envoyé par Zeleph — Gestion locative.
      </p>
    </div>
  </body>
</html>`;
}

function button(label: string, url: string): string {
  // `url` is a magic link / app URL we control — not escaped. Label IS escaped.
  return `<p style="text-align:center;margin:32px 0;">
    <a href="${url}" style="display:inline-block;background-color:#2563eb;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:6px;font-weight:600;">${escapeHtml(label)}</a>
  </p>`;
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export function renderInvitationEmail(opts: {
  recipientName: string;
  inviterName: string;
  magicLink: string;
}): { subject: string; html: string; text: string } {
  const subject = `${opts.inviterName} vous invite sur Zeleph`;

  const html = shell(`
    <h1 style="font-size:20px;margin:0 0 16px;">Bonjour ${escapeHtml(opts.recipientName)},</h1>
    <p style="line-height:1.5;margin:0 0 16px;">
      <strong>${escapeHtml(opts.inviterName)}</strong> vous invite à créer votre compte sur Zeleph pour consulter vos documents de location en ligne (bail, quittances, avis d'échéance…).
    </p>
    <p style="line-height:1.5;margin:0 0 16px;">
      Cliquez sur le bouton ci-dessous pour définir votre mot de passe et accéder à votre espace :
    </p>
    ${button('Créer mon compte', opts.magicLink)}
    <p style="line-height:1.5;margin:0 0 8px;font-size:13px;color:#6b7280;">
      Ce lien est personnel et valable 7 jours. Si vous n'êtes pas le destinataire, vous pouvez ignorer cet email.
    </p>
  `);

  const text = [
    `Bonjour ${opts.recipientName},`,
    '',
    `${opts.inviterName} vous invite à créer votre compte sur Zeleph pour consulter vos documents de location en ligne (bail, quittances, avis d'échéance…).`,
    '',
    'Cliquez sur le lien ci-dessous pour définir votre mot de passe :',
    opts.magicLink,
    '',
    "Ce lien est personnel et valable 7 jours. Si vous n'êtes pas le destinataire, vous pouvez ignorer cet email.",
  ].join('\n');

  return { subject, html, text };
}

export function renderRentNoticeEmail(opts: {
  recipientName: string;
  landlordName: string;
  propertyAddress: string;
  periodLabel: string;
  totalDueLabel: string;
  dueDateLabel: string;
  appUrl: string;
}): { subject: string; html: string; text: string } {
  const subject = `Avis d'échéance — ${opts.periodLabel}`;

  const html = shell(`
    <h1 style="font-size:20px;margin:0 0 16px;">Bonjour ${escapeHtml(opts.recipientName)},</h1>
    <p style="line-height:1.5;margin:0 0 16px;">
      Vous trouverez ci-joint votre avis d'échéance pour le logement situé :
    </p>
    <p style="line-height:1.5;margin:0 0 16px;padding:12px 16px;background-color:#f9fafb;border-radius:6px;">
      ${escapeHtml(opts.propertyAddress)}
    </p>
    <p style="line-height:1.6;margin:0 0 8px;">
      <strong>Période :</strong> ${escapeHtml(opts.periodLabel)}<br/>
      <strong>Montant dû :</strong> ${escapeHtml(opts.totalDueLabel)}<br/>
      <strong>Échéance :</strong> ${escapeHtml(opts.dueDateLabel)}
    </p>
    ${button("Consulter l'avis d'échéance", opts.appUrl)}
    <p style="line-height:1.5;margin:24px 0 0;font-size:13px;color:#6b7280;">
      Bailleur : ${escapeHtml(opts.landlordName)}
    </p>
  `);

  const text = [
    `Bonjour ${opts.recipientName},`,
    '',
    "Vous trouverez ci-joint votre avis d'échéance pour le logement situé :",
    opts.propertyAddress,
    '',
    `Période : ${opts.periodLabel}`,
    `Montant dû : ${opts.totalDueLabel}`,
    `Échéance : ${opts.dueDateLabel}`,
    '',
    `Consulter l'avis d'échéance : ${opts.appUrl}`,
    '',
    `Bailleur : ${opts.landlordName}`,
  ].join('\n');

  return { subject, html, text };
}

export function renderRentReceiptEmail(opts: {
  recipientName: string;
  landlordName: string;
  propertyAddress: string;
  periodLabel: string;
  totalPaidLabel: string;
  appUrl: string;
}): { subject: string; html: string; text: string } {
  const subject = `Quittance de loyer — ${opts.periodLabel}`;

  const html = shell(`
    <h1 style="font-size:20px;margin:0 0 16px;">Bonjour ${escapeHtml(opts.recipientName)},</h1>
    <p style="line-height:1.5;margin:0 0 16px;">
      Vous trouverez ci-joint votre quittance de loyer pour le logement situé :
    </p>
    <p style="line-height:1.5;margin:0 0 16px;padding:12px 16px;background-color:#f9fafb;border-radius:6px;">
      ${escapeHtml(opts.propertyAddress)}
    </p>
    <p style="line-height:1.6;margin:0 0 8px;">
      <strong>Période :</strong> ${escapeHtml(opts.periodLabel)}<br/>
      <strong>Montant réglé :</strong> ${escapeHtml(opts.totalPaidLabel)}
    </p>
    ${button('Consulter la quittance', opts.appUrl)}
    <p style="line-height:1.5;margin:24px 0 0;font-size:13px;color:#6b7280;">
      Bailleur : ${escapeHtml(opts.landlordName)}
    </p>
  `);

  const text = [
    `Bonjour ${opts.recipientName},`,
    '',
    'Vous trouverez ci-joint votre quittance de loyer pour le logement situé :',
    opts.propertyAddress,
    '',
    `Période : ${opts.periodLabel}`,
    `Montant réglé : ${opts.totalPaidLabel}`,
    '',
    `Consulter la quittance : ${opts.appUrl}`,
    '',
    `Bailleur : ${opts.landlordName}`,
  ].join('\n');

  return { subject, html, text };
}

export function renderShareEmail(opts: {
  documentLabel: string;
  shareUrl: string;
  expiresAtLabel: string;
}): { subject: string; html: string; text: string } {
  const subject = `Un document a été partagé avec vous — ${opts.documentLabel}`;

  const html = shell(`
    <h1 style="font-size:20px;margin:0 0 16px;">Document partagé</h1>
    <p style="line-height:1.5;margin:0 0 16px;">
      Un document a été partagé avec vous : <strong>${escapeHtml(opts.documentLabel)}</strong>.
    </p>
    <p style="line-height:1.5;margin:0 0 16px;">
      Cliquez sur le bouton ci-dessous pour le consulter :
    </p>
    ${button('Consulter le document', opts.shareUrl)}
    <p style="line-height:1.5;margin:0 0 0;font-size:13px;color:#6b7280;">
      Ce lien expire le ${escapeHtml(opts.expiresAtLabel)}.
    </p>
  `);

  const text = [
    'Document partagé',
    '',
    `Un document a été partagé avec vous : ${opts.documentLabel}.`,
    '',
    `Consulter le document : ${opts.shareUrl}`,
    '',
    `Ce lien expire le ${opts.expiresAtLabel}.`,
  ].join('\n');

  return { subject, html, text };
}

export function renderCancellationEmail(opts: {
  recipientName: string;
  landlordName: string;
  propertyAddress: string;
  periodLabel: string;
  reason?: string;
}): { subject: string; html: string; text: string } {
  const subject = `Avis d'échéance annulé — ${opts.periodLabel}`;

  const reasonBlock = opts.reason
    ? `<p style="line-height:1.5;margin:0 0 16px;"><strong>Motif :</strong> ${escapeHtml(opts.reason)}</p>`
    : '';

  const html = shell(`
    <h1 style="font-size:20px;margin:0 0 16px;">Bonjour ${escapeHtml(opts.recipientName)},</h1>
    <p style="line-height:1.5;margin:0 0 16px;">
      Nous vous informons que l'avis d'échéance suivant a été annulé :
    </p>
    <p style="line-height:1.6;margin:0 0 16px;padding:12px 16px;background-color:#f9fafb;border-radius:6px;">
      <strong>Logement :</strong> ${escapeHtml(opts.propertyAddress)}<br/>
      <strong>Période :</strong> ${escapeHtml(opts.periodLabel)}
    </p>
    ${reasonBlock}
    <p style="line-height:1.5;margin:24px 0 0;font-size:13px;color:#6b7280;">
      Bailleur : ${escapeHtml(opts.landlordName)}
    </p>
  `);

  const text = [
    `Bonjour ${opts.recipientName},`,
    '',
    "Nous vous informons que l'avis d'échéance suivant a été annulé :",
    `Logement : ${opts.propertyAddress}`,
    `Période : ${opts.periodLabel}`,
    ...(opts.reason ? ['', `Motif : ${opts.reason}`] : []),
    '',
    `Bailleur : ${opts.landlordName}`,
  ].join('\n');

  return { subject, html, text };
}
