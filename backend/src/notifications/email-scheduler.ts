import nodemailer from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport/index.js';
import { activateEmailAlertDelivery, EMAIL_RECIPIENTS, processOrderEmailDeliveries, type EmailSender } from './email-delivery.js';

const INTERVAL_MS = 15_000;
const EMAIL_PATTERN = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
/** Sender explicitly selected by the Mita Japan owner; recipients remain independent. */
export const MITA_GMAIL_SENDER = 'nothink1315@gmail.com';

/** Production-only explicit opt-in. Missing sender identity/password never sends. */
export function gmailSmtpConfig(environment: NodeJS.ProcessEnv = process.env, platform = process.platform) {
  if (environment.MITA_EMAIL_ALERTS_ENABLED !== '1' || environment.MITA_EMAIL_ALERTS_VPS !== '1' ||
      environment.NODE_ENV !== 'production' || platform !== 'linux') return null;
  const user = environment.MITA_GMAIL_SMTP_USER?.trim() ?? MITA_GMAIL_SENDER;
  const from = environment.MITA_GMAIL_SMTP_FROM?.trim() ?? MITA_GMAIL_SENDER;
  const password = environment.MITA_GMAIL_SMTP_APP_PASSWORD;
  if (!user || !from || !EMAIL_PATTERN.test(user) || !EMAIL_PATTERN.test(from) ||
      user.toLowerCase() !== MITA_GMAIL_SENDER || from.toLowerCase() !== MITA_GMAIL_SENDER ||
      !password || !/^[A-Za-z0-9]{16,128}$/.test(password)) return null;
  return { user, from, password };
}

export function createGmailSmtpSender(settings: NonNullable<ReturnType<typeof gmailSmtpConfig>>): EmailSender {
  const smtpOptions: SMTPTransport.Options = {
    host: 'smtp.gmail.com', port: 465, secure: true,
    auth: { user: settings.user, pass: settings.password },
    tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
    connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 15_000
  };
  const transport = nodemailer.createTransport(smtpOptions);
  return async mail => {
    if (!(EMAIL_RECIPIENTS as readonly string[]).includes(mail.to)) {
      throw new Error('Email recipient is not allowlisted');
    }
    await transport.sendMail({
      from: settings.from, to: mail.to, subject: mail.subject,
      text: mail.text, messageId: mail.messageId, envelope: { from: settings.from, to: [mail.to] },
      disableFileAccess: true, disableUrlAccess: true
    });
  };
}

/** Called only from the real server entrypoint after Fastify starts listening. */
export function startEmailAlertScheduler(): () => Promise<void> {
  const settings = gmailSmtpConfig();
  if (!settings) return async () => {};
  const send = createGmailSmtpSender(settings);
  let active: Promise<void> | null = null;
  const poll = () => {
    if (active) return;
    active = activateEmailAlertDelivery()
      .then(() => processOrderEmailDeliveries(send, settings.from))
      .then(summary => {
        if (summary.failed) console.warn('order_email_delivery_exhausted');
      })
      .catch(() => { console.warn('order_email_delivery_unavailable'); })
      .finally(() => { active = null; });
  };
  const timer = setInterval(poll, INTERVAL_MS);
  timer.unref();
  poll();
  return async () => { clearInterval(timer); if (active) await active; };
}
