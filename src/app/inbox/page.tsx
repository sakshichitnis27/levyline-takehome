import { connection } from "next/server";
import { InboxIcon } from "lucide-react";

import { AutoRefresh } from "@/components/auto-refresh";
import { AttachReply } from "@/components/inbox/attach-reply";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { unmatchedReplies } from "@/lib/messaging";
import { rows } from "@/lib/sql";
import { formatDateTime } from "@/lib/time";

export default async function Page() {
  await connection();
  const [replies, owners] = await Promise.all([
    unmatchedReplies(),
    rows<{ id: string; name: string; email: string | null }>("select id, full_name as name, email from owners order by full_name"),
  ]);
  return (
    <>
      <PageHeader title="Unmatched replies" description="Replies we couldn't tie to an owner" />
      <AutoRefresh seconds={15} />
      <main className="mx-auto w-full max-w-4xl space-y-4 p-6 md:p-10">
        <p className="text-sm text-muted-foreground">
          A reply is matched by the address it was sent to (each email we send has its own reply address). If someone writes to us fresh,
          or from a forwarded email, it lands here instead of being lost. Attach it to the right owner and it joins their conversation.
        </p>
        {replies.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <InboxIcon />
              </EmptyMedia>
              <EmptyTitle>Nothing to sort</EmptyTitle>
              <EmptyDescription>Every reply so far has been matched to an owner.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          replies.map((r) => (
            <Card key={r.id}>
              <CardHeader>
                <CardTitle className="text-sm">{r.subject}</CardTitle>
                <CardDescription>
                  From {r.from_address} to {r.to_address} · {formatDateTime(r.created_at)}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-sm whitespace-pre-wrap">{r.body}</p>
                <AttachReply messageId={r.id} owners={owners} />
              </CardContent>
            </Card>
          ))
        )}
      </main>
    </>
  );
}
