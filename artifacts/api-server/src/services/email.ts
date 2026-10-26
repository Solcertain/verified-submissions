import { logger } from "../lib/logger.js";

// Transactional email through Resend's REST API (no SDK). With RESEND_API_KEY
// unset nothing is sent and the call reports that, so local runs and tests
// never email anyone.

const RESEND_API = "https://api.resend.com/emails";

export interface EmailMessage {
  to: string | string[];
  subject: string;
  html: string;
  text: string;
}

export interface SendResult {
  sent: boolean;
  id: string | null;
  error: string | null;
}

export async function send_email(message: EmailMessage): Promise<SendResult> {
  const key = process.env["RESEND_API_KEY"];
  const from = process.env["MAIL_FROM"] ?? "Verified Submissions <hello@verifiedsubmission.com>";
  if (!key) {
    logger.warn({ subject: message.subject }, "RESEND_API_KEY is not set — email not sent");
    return { sent: false, id: null, error: "not_configured" };
  }
  try {
    const res = await fetch(RESEND_API, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to: Array.isArray(message.to) ? message.to : [message.to],
        subject: message.subject,
        html: message.html,
        text: message.text,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const error = typeof json["message"] === "string" ? json["message"] : `Resend HTTP ${res.status}`;
      logger.error({ status: res.status, subject: message.subject }, "Email send failed");
      return { sent: false, id: null, error };
    }
    return { sent: true, id: typeof json["id"] === "string" ? json["id"] : null, error: null };
  } catch (err) {
    logger.error({ err, subject: message.subject }, "Email send failed");
    return { sent: false, id: null, error: err instanceof Error ? err.message : "send failed" };
  }
}

// ── Templates ───────────────────────────────────────────────────────────────

function escape_html(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function portal_url(path = ""): string {
  return `${(process.env["PORTAL_URL"] ?? "https://portal.verifiedsubmission.com").replace(/\/$/, "")}${path}`;
}

// One plain layout for every message: a heading, a few short paragraphs and at
// most one button. Text and HTML carry the same words.
function layout(o: { heading: string; paragraphs: string[]; button?: { label: string; url: string }; footer?: string }): {
  html: string;
  text: string;
} {
  const paras = o.paragraphs.map((p) => `<p style="margin:0 0 16px;line-height:1.5">${escape_html(p)}</p>`).join("");
  const button = o.button
    ? `<p style="margin:24px 0"><a href="${escape_html(o.button.url)}" style="background:#0f766e;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:600">${escape_html(o.button.label)}</a></p>`
    : "";
  const footer = o.footer ?? "Verified Submissions · lead verification you can show a buyer";
  const html = `<!doctype html><html><body style="margin:0;background:#f5f5f4;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1c1917">
<div style="max-width:560px;margin:0 auto;padding:32px 24px;background:#fff">
<h1 style="font-size:20px;margin:0 0 20px">${escape_html(o.heading)}</h1>${paras}${button}
<p style="margin:32px 0 0;font-size:12px;color:#78716c">${escape_html(footer)}</p>
</div></body></html>`;
  const text = [o.heading, "", ...o.paragraphs.flatMap((p) => [p, ""]), ...(o.button ? [`${o.button.label}: ${o.button.url}`, ""] : []), footer].join("\n");
  return { html, text };
}

export function invite_email(o: { name?: string; join_url: string; founder: boolean }): Omit<EmailMessage, "to"> {
  return {
    subject: "Your Verified Submissions access is ready",
    ...layout({
      heading: o.name ? `You're in, ${o.name}` : "You're in",
      paragraphs: [
        "Your spot on the Verified Submissions waitlist has come up.",
        o.founder
          ? "As a founding customer you're locked in at $0.08 per verified lead with no monthly minimum."
          : "Pick the plan that fits your volume. You pay per verified lead, and each plan has a monthly minimum.",
        "The link below is yours alone and expires in 14 days.",
      ],
      button: { label: "Choose your plan", url: o.join_url },
    }),
  };
}

export function set_password_email(o: { token: string }): Omit<EmailMessage, "to"> {
  return {
    subject: "Set your Verified Submissions password",
    ...layout({
      heading: "Your account is active",
      paragraphs: [
        "Thanks for subscribing. Set a password to sign in to your portal, where you'll add your ActiveProspect key and create an API key.",
        "This link expires in 7 days.",
      ],
      button: { label: "Set your password", url: portal_url(`/set-password?t=${encodeURIComponent(o.token)}`) },
    }),
  };
}

export function password_reset_email(o: { token: string }): Omit<EmailMessage, "to"> {
  return {
    subject: "Reset your Verified Submissions password",
    ...layout({
      heading: "Reset your password",
      paragraphs: [
        "Someone asked to reset the password on this account. If it was you, use the link below. It expires in one hour.",
        "If it wasn't you, ignore this email. Your password has not changed.",
      ],
      button: { label: "Reset password", url: portal_url(`/reset-password?t=${encodeURIComponent(o.token)}`) },
    }),
  };
}

export function payment_failed_email(o: { name: string; grace_days: number }): Omit<EmailMessage, "to"> {
  return {
    subject: "Payment failed for your Verified Submissions account",
    ...layout({
      heading: "We couldn't take your payment",
      paragraphs: [
        `The latest invoice for ${o.name} didn't go through.`,
        `Verification keeps running for ${o.grace_days} days while we retry the card. After that, API calls are refused until the invoice is paid.`,
      ],
      button: { label: "Update your card", url: portal_url("/billing") },
    }),
  };
}

export function welcome_email(o: { name: string }): Omit<EmailMessage, "to"> {
  return {
    subject: "Welcome to Verified Submissions",
    ...layout({
      heading: `Welcome, ${o.name}`,
      paragraphs: [
        "Three steps to your first verified lead:",
        "1. Add your ActiveProspect API key in the portal.",
        "2. Create an API key.",
        "3. Point your lead platform at POST https://verify.verifiedsubmission.com/api/v1/verify, or follow the guide for your platform.",
      ],
      button: { label: "Open the portal", url: portal_url("/") },
    }),
  };
}
