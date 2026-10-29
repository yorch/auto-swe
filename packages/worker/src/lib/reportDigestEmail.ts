import { resolveAuthEmailConfig } from '@auto-swe/shared/lib/systemConfig';
import nodemailer, { type Transporter } from 'nodemailer';

let cached: { key: string; transporter: Transporter } | null = null;

function transporterFor(config: ReturnType<typeof resolveAuthEmailConfig>): Transporter | null {
  if (!(config.smtpHost && config.smtpPort && config.authFromEmail)) {
    return null;
  }
  const key = JSON.stringify([config.smtpHost, config.smtpPort, config.smtpUser, config.smtpPass]);
  if (cached?.key !== key) {
    cached = {
      key,
      transporter: nodemailer.createTransport({
        auth:
          config.smtpUser && config.smtpPass
            ? { pass: config.smtpPass, user: config.smtpUser }
            : undefined,
        host: config.smtpHost,
        port: config.smtpPort,
        secure: config.smtpPort === 465,
      }),
    };
  }
  return cached.transporter;
}

export async function sendReportDigestEmail(input: {
  listUnsubscribeUrl: string;
  html: string;
  subject: string;
  text: string;
  to: string;
}): Promise<void> {
  const config = resolveAuthEmailConfig();
  const transport = transporterFor(config);
  if (transport) {
    await transport.sendMail({
      from: config.authFromEmail ?? undefined,
      headers: { 'List-Unsubscribe': `<${input.listUnsubscribeUrl}>` },
      html: input.html,
      subject: input.subject,
      text: input.text,
      to: input.to,
    });
    return;
  }
  if (!config.resendApiKey || !config.authFromEmail) {
    throw new Error(
      'Email transport is not configured (SMTP_* or RESEND_API_KEY and AUTH_FROM_EMAIL)'
    );
  }
  const response = await fetch('https://api.resend.com/emails', {
    body: JSON.stringify({
      from: config.authFromEmail,
      headers: { 'List-Unsubscribe': `<${input.listUnsubscribeUrl}>` },
      html: input.html,
      subject: input.subject,
      text: input.text,
      to: input.to,
    }),
    headers: {
      Authorization: `Bearer ${config.resendApiKey}`,
      'Content-Type': 'application/json',
    },
    method: 'POST',
  });
  if (!response.ok) {
    throw new Error(`Resend returned ${response.status}`);
  }
}
