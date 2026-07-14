import nodemailer from 'nodemailer';
import { env } from '../env.js';
import { HttpError } from './http.js';

function mailTransport() {
  if (!env.GMAIL_SMTP_USER || !env.GMAIL_SMTP_APP_PASSWORD) {
    throw new HttpError(503, 'Password recovery email is not configured', 'EMAIL_NOT_CONFIGURED');
  }
  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: env.GMAIL_SMTP_USER,
      pass: env.GMAIL_SMTP_APP_PASSWORD.replace(/\s+/g, ''),
    },
  });
}

export async function sendPasswordResetEmail(email: string, token: string): Promise<void> {
  const resetUrl = `${env.APP_URL.replace(/\/$/, '')}/reset-password?token=${encodeURIComponent(token)}`;
  try {
    await mailTransport().sendMail({
      from: env.EMAIL_FROM ?? env.GMAIL_SMTP_USER,
      to: email,
      subject: 'Reset your Kontaner password',
      text: `Reset your Kontaner password: ${resetUrl}\n\nThis link expires in one hour. If you did not request it, ignore this email.`,
      html: `<p>You requested a Kontaner password reset.</p><p><a href="${resetUrl}">Reset your password</a></p><p>This link expires in one hour. If you did not request it, you can ignore this email.</p>`,
    });
  } catch (err) {
    if (err instanceof HttpError) throw err;
    console.error('[email] Gmail SMTP delivery failed:', err);
    throw new HttpError(502, 'Password recovery email could not be sent', 'EMAIL_DELIVERY_FAILED');
  }
}
