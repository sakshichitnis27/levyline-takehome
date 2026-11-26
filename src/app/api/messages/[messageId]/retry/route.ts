import { handle, HttpError } from "@/lib/api";
import { deliverNow, type MessageRow } from "@/lib/messaging";
import { one } from "@/lib/sql";

// Retry a failed staff email. Same message, same idempotency key, so a send
// that actually got through the first time isn't delivered twice by Resend.
export const POST = handle(async (_: Request, { params }: { params: Promise<{ messageId: string }> }) => {
  const { messageId } = await params;
  const message = await one<MessageRow>("select * from messages where id = $1 and direction = 'out'", [messageId]);
  if (!message) throw new HttpError(404, "Message not found");
  if (message.status !== "failed") throw new HttpError(409, `This message is ${message.status}`);
  if (message.source === "automation") throw new HttpError(409, "Retry automation emails from the automation panel");
  if (!message.retryable) {
    // Permanent failures (e.g. a bad address since corrected) get a fresh try.
    await one("update messages set retryable = true where id = $1", [messageId]);
  }
  const result = await deliverNow(messageId);
  return Response.json({ status: result.status, error: result.last_error });
});
