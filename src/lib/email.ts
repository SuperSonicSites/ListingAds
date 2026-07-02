import type { EmailKind, EmailLogEntry } from "./types";
import { readRequest, writeRequest } from "./storage";

// Resend transactional email via raw fetch (no SDK). Every outbound email sets
// reply_to to the team inbox so clients can "just hit reply". Failures never
// block a workflow transition — they are logged on the request and retried
// from the email log UI.

const RESEND_API = "https://api.resend.com/emails";

function env(name: string): string | undefined {
  const meta = import.meta.env as Record<string, string | undefined>;
  const value = (process.env[name] ?? meta[name])?.trim();
  return value || undefined;
}

export function resendKey(): string | undefined {
  return env("RESEND_API_KEY");
}

export function emailFrom(): string {
  return env("EMAIL_FROM") ?? "Supersonic Sites <hello@supersonicsites.com>";
}

export function emailReplyTo(): string | undefined {
  return env("EMAIL_REPLY_TO");
}

export function teamEmail(): string | undefined {
  return env("TEAM_EMAIL");
}

export function teamName(): string {
  return env("TEAM_NAME") ?? "team";
}

export function reviewEmail(): string {
  return env("REVIEW_EMAIL") ?? "brent@supersonicsites.com";
}

export function appBaseUrl(): string {
  const configured = env("APP_BASE_URL");
  if (configured) return configured.replace(/\/+$/, "");
  return `http://127.0.0.1:${process.env.PORT ?? "4322"}`;
}

function demoMode(): boolean {
  return env("DEMO_MODE") === "1";
}

export type EmailAttachment = {
  filename: string;
  content: string; // base64
};

export type EmailPayload = {
  to: string;
  subject: string;
  html: string;
  attachments?: EmailAttachment[];
};

export type EmailSendResult = { ok: boolean; id?: string; error?: string };

async function postToResend(
  payload: EmailPayload,
  idempotencyKey: string
): Promise<EmailSendResult> {
  const key = resendKey();
  if (!key) {
    return { ok: false, error: "RESEND_API_KEY is not configured." };
  }

  const body: Record<string, unknown> = {
    from: emailFrom(),
    to: payload.to,
    subject: payload.subject,
    html: payload.html
  };
  const replyTo = emailReplyTo();
  if (replyTo) body.reply_to = replyTo; // raw API uses snake_case
  if (payload.attachments?.length) body.attachments = payload.attachments;

  const timeoutMs = payload.attachments?.length ? 30_000 : 8000;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(RESEND_API, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
      });
      const result: any = await response.json().catch(() => ({}));
      if (response.status === 429 && attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }
      if (!response.ok) {
        const message =
          typeof result?.message === "string" ? result.message : `Resend error ${response.status}`;
        return { ok: false, error: message };
      }
      return { ok: true, id: typeof result?.id === "string" ? result.id : undefined };
    } catch (error) {
      if (attempt === 0) continue; // one retry on network failure too
      return { ok: false, error: error instanceof Error ? error.message : "Resend request failed." };
    }
  }
  return { ok: false, error: "Resend request failed." };
}

/**
 * Send an email and append the outcome to the request's email log. Never
 * throws. The request is re-read immediately before writing so a concurrent
 * edit elsewhere isn't clobbered. In DEMO_MODE without a Resend key the email
 * is logged as sent with id "demo-mode" and nothing leaves the machine.
 */
export async function sendAndLog(requestId: string, kind: EmailKind, payload: EmailPayload): Promise<EmailLogEntry> {
  let result: EmailSendResult;
  let demoStub = false;

  if (!resendKey() && demoMode()) {
    demoStub = true;
    result = { ok: true, id: "demo-mode" };
    console.log(`[email] DEMO_MODE — would send "${payload.subject}" to ${payload.to}`);
  } else {
    // Prior attempts of the same kind get a retry suffix so Resend's 24h
    // idempotency window doesn't swallow a deliberate resend.
    const priorAttempts = (await readRequest(requestId)).emails.filter((entry) => entry.kind === kind).length;
    const idempotencyKey = `${requestId}-${kind}${priorAttempts ? `-r${priorAttempts}` : ""}`;
    result = await postToResend(payload, idempotencyKey);
  }

  const entry: EmailLogEntry = {
    kind,
    to: payload.to,
    subject: payload.subject,
    sent_at: new Date().toISOString(),
    ok: result.ok,
    ...(result.id ? { resend_id: result.id } : {}),
    ...(result.error ? { error: result.error } : {})
  };

  try {
    const request = await readRequest(requestId);
    request.emails = [...request.emails, entry];
    await writeRequest(request);
  } catch (error) {
    console.error(`[email] Could not log email on ${requestId}:`, error);
  }

  if (!result.ok && !demoStub) {
    console.warn(`[email] Send failed (${kind} -> ${payload.to}): ${result.error}`);
  }

  return entry;
}
