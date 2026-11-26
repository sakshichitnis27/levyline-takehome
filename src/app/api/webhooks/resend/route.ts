// Resend posts here when someone replies to one of our emails (email.received).
// Locally, `npm run email:simulate-reply` posts the same, signed, request.
//
// - The signature is checked against the raw body (svix headers).
// - The same webhook can arrive more than once; recordInbound() stores each
//   received email once, keyed on its email id.
// - If fetching the email fails in a way worth retrying, we answer 503 so
//   Resend tries again, and nothing is lost.

import { Webhook } from "svix";

import { EmailProviderError } from "@/lib/email";
import { recordInbound } from "@/lib/messaging";
import { pool } from "@/lib/db";

export async function POST(request: Request) {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) return Response.json({ error: "RESEND_WEBHOOK_SECRET is not set" }, { status: 500 });

  const body = await request.text();
  let event: { type?: string; data?: { email_id?: string } };
  try {
    // verify() throws on a bad signature; parse the body ourselves afterwards.
    new Webhook(secret).verify(body, {
      "svix-id": request.headers.get("svix-id") ?? "",
      "svix-timestamp": request.headers.get("svix-timestamp") ?? "",
      "svix-signature": request.headers.get("svix-signature") ?? "",
    });
    event = JSON.parse(body);
  } catch {
    return Response.json({ error: "Invalid signature" }, { status: 401 });
  }

  if (event.type !== "email.received" || !event.data?.email_id) {
    return Response.json({ ok: true, ignored: event.type ?? "unknown" });
  }

  try {
    const result = await recordInbound(event.data.email_id);
    await pool.query("insert into webhook_events (id) values ($1) on conflict do nothing", [
      request.headers.get("svix-id"),
    ]);
    return Response.json({ ok: true, ...result });
  } catch (error) {
    const retryable = !(error instanceof EmailProviderError) || error.retryable;
    console.error("[webhook] could not record reply", error);
    return Response.json({ error: (error as Error).message }, { status: retryable ? 503 : 422 });
  }
}
