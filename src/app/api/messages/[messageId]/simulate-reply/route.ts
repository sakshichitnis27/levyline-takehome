import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { body, handle, HttpError } from "@/lib/api";
import { replyAddress, type MessageRow } from "@/lib/messaging";
import { one } from "@/lib/sql";

// Development only: runs scripts/simulate-reply.mjs as if the owner replied
// to this message, so the reply flow can be tried from the owner page.
export const POST = handle(async (request: Request, { params }: { params: Promise<{ messageId: string }> }) => {
  if (process.env.RESEND_API_KEY) throw new HttpError(403, "Only in local email mode; reply from your inbox instead");
  const { messageId } = await params;
  const { text, deliveries } = await body<{ text: string; deliveries?: number }>(request);
  const message = await one<MessageRow>("select * from messages where id = $1 and direction = 'out'", [messageId]);
  if (!message?.reply_token) throw new HttpError(404, "Message not found");
  const origin = new URL(request.url).origin;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      "scripts/simulate-reply.mjs",
      "--to", replyAddress(message.reply_token),
      "--subject", `Re: ${message.subject}`,
      "--text", text || "Thanks, I'll pay by the end of the month.",
      "--deliveries", String(Math.min(3, Math.max(1, deliveries ?? 1))),
      "--url", `${origin}/api/webhooks/resend`,
    ],
    { cwd: process.cwd() },
  );
  const failed = [...stdout.matchAll(/delivery \d+\/\d+: (\d+) (.*)/g)].find((m) => !m[1].startsWith("2"));
  if (failed) throw new HttpError(502, `The webhook answered ${failed[1]}: ${failed[2]}`);
  return Response.json({ ok: true, output: stdout });
});
