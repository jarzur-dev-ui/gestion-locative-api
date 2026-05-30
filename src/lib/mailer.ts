import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../config/env.js';
import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Attachment = {
  filename: string;
  content: Buffer | string; // buffer for PDFs, string for text
  contentType?: string;
};

export type MailMessage = {
  to: string | string[];
  subject: string;
  html: string;
  text?: string; // plain text fallback
  attachments?: Attachment[];
  cc?: string | string[];
};

export type SendResult = { delivered: boolean; messageId?: string };

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/**
 * Default `from` address used when env.SMTP_FROM is not set. Kept here (not in
 * env.ts) because it is a hard-coded product default rather than configuration.
 */
const DEFAULT_FROM = 'no-reply@zeleph.fr';

/**
 * Lazy singleton — created on the first sendEmail() call. We intentionally do
 * NOT eagerly construct it at module import time : that would force every code
 * path (tests, CLI scripts) to also configure SMTP just to import this module.
 */
let cachedTransporter: Transporter | null = null;

// ---------------------------------------------------------------------------
// Transporter factory
// ---------------------------------------------------------------------------

function buildTransporter(): Transporter {
  // Production safety guard (R6 / M2.5) : in production an unset SMTP_HOST is
  // almost certainly a mis-deploy — better fail loudly than silently swallow
  // every outgoing email into a dev jsonTransport.
  if (env.NODE_ENV === 'production' && !env.SMTP_HOST) {
    throw new Error(
      'SMTP_HOST is not set in production — refusing to send emails via dev jsonTransport',
    );
  }

  if (!env.SMTP_HOST) {
    logger.warn(
      'mailer: SMTP_HOST not set — using dev jsonTransport (emails will NOT be delivered)',
    );
    return nodemailer.createTransport({ jsonTransport: true });
  }

  // SMTP_PORT defaults to 587 (STARTTLS) which is the most common modern
  // submission port. `secure: true` only on the legacy implicit-TLS port 465.
  const port = env.SMTP_PORT ?? 587;
  const transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port,
    secure: port === 465,
    auth:
      env.SMTP_USER && env.SMTP_PASSWORD
        ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD }
        : undefined,
  });

  logger.info(
    { host: env.SMTP_HOST, port, hasAuth: Boolean(env.SMTP_USER) },
    'mailer: SMTP transporter ready',
  );
  return transporter;
}

function getTransporter(): Transporter {
  if (!cachedTransporter) {
    cachedTransporter = buildTransporter();
  }
  return cachedTransporter;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Send a transactional email. Resolves with `{ delivered: true, messageId }`
 * on success ; resolves with `{ delivered: false }` (and logs) on failure —
 * the caller decides whether to surface the error. We never let a transient
 * SMTP failure crash a business transaction (invitation, rent notice…) :
 * those flows always log + degrade gracefully.
 */
export async function sendEmail(message: MailMessage): Promise<SendResult> {
  const transporter = getTransporter();
  const from = env.SMTP_FROM ?? DEFAULT_FROM;

  try {
    const info = await transporter.sendMail({
      from,
      to: message.to,
      cc: message.cc,
      subject: message.subject,
      html: message.html,
      text: message.text,
      attachments: message.attachments,
    });

    logger.info(
      { to: message.to, subject: message.subject, messageId: info.messageId },
      'mailer: email sent',
    );
    return { delivered: true, messageId: info.messageId };
  } catch (err) {
    logger.error(
      { err, to: message.to, subject: message.subject },
      'mailer: email send failed',
    );
    return { delivered: false };
  }
}

/**
 * Close the underlying transporter (releases pooled SMTP connections). Mainly
 * useful for graceful shutdown / test teardown. Idempotent.
 */
export async function closeMailer(): Promise<void> {
  if (cachedTransporter) {
    cachedTransporter.close();
    cachedTransporter = null;
  }
}
