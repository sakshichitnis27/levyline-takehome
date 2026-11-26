import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { Webhook } from "svix";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { POST } from "@/app/api/webhooks/resend/route";
import { pool } from "@/lib/db";
import { queueMessage } from "@/lib/messaging";

import { resetDb } from "./helpers";

const SECRET = "whsec_bG9jYWwtc2ltdWxhdG9yLXNlY3JldC0xMjM0NTY=";

function signed(payload: string, id = "msg_1", secret = SECRET) {
  const now = new Date();
  return new Request("http://test/api/webhooks/resend", {
    method: "POST",
    headers: {
      "svix-id": id,
      "svix-timestamp": String(Math.floor(now.getTime() / 1000)),
      "svix-signature": new Webhook(secret).sign(id, now, payload),
    },
    body: payload,
  });
}

async function inbox(emailId: string, to: string) {
  await mkdir(path.join(".mailbox", "inbox"), { recursive: true });
  await writeFile(
    path.join(".mailbox", "inbox", `${emailId}.json`),
    JSON.stringify({ id: emailId, from: "me@example.com", to: [to], subject: "Re: hi", text: "Paying Friday", html: null, messageId: null, headers: {}, receivedAt: new Date().toISOString() }),
  );
  return JSON.stringify({ type: "email.received", data: { email_id: emailId, to: [to] } });
}

describe("POST /api/webhooks/resend", () => {
  let ownerId: string;
  let token: string;
  beforeAll(async () => {
    process.env.RESEND_WEBHOOK_SECRET = SECRET;
    await resetDb();
    const { rows } = await pool.query("insert into owners (full_name, email) values ('Test Owner', 'test@example.com') returning id");
    ownerId = rows[0].id;
    token = (await queueMessage(pool, { ownerId, subject: "Hi", body: "Hello", source: "staff" })).reply_token!;
  });
  afterAll(() => pool.end());

  it("rejects a bad signature", async () => {
    const payload = await inbox(`bad-${Date.now()}`, `reply+${token}@x.test`);
    const res = await POST(signed(payload, "msg_bad", "whsec_" + Buffer.from("another-secret-value-123").toString("base64")));
    expect(res.status).toBe(401);
  });

  it("files a reply under its owner once, however many times it's delivered", async () => {
    const payload = await inbox(`ok-${Date.now()}`, `reply+${token}@x.test`);
    const first = await (await POST(signed(payload, "msg_2"))).json();
    const second = await (await POST(signed(payload, "msg_2"))).json();
    expect(first).toMatchObject({ status: "matched", ownerId });
    expect(second).toMatchObject({ status: "duplicate" });
    const { rows } = await pool.query("select count(*)::int as n from messages where direction = 'in' and owner_id = $1", [ownerId]);
    expect(rows[0].n).toBe(1);
  });

  it("keeps a reply it can't match, for staff to attach", async () => {
    const payload = await inbox(`lost-${Date.now()}`, "someone@x.test");
    expect(await (await POST(signed(payload, "msg_3"))).json()).toMatchObject({ status: "unmatched" });
    const { rows } = await pool.query("select count(*)::int as n from messages where direction = 'in' and owner_id is null");
    expect(rows[0].n).toBe(1);
  });
});
