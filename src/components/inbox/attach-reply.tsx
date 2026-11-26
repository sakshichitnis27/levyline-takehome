"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { api } from "@/lib/client";

export function AttachReply({ messageId, owners }: { messageId: string; owners: { id: string; name: string; email: string | null }[] }) {
  const router = useRouter();
  const [ownerId, setOwnerId] = useState("");
  return (
    <div className="flex gap-2">
      <NativeSelect size="sm" value={ownerId} onChange={(e) => setOwnerId(e.target.value)} aria-label="Owner">
        <NativeSelectOption value="">Choose the owner…</NativeSelectOption>
        {owners.map((o) => (
          <NativeSelectOption key={o.id} value={o.id}>
            {o.name}
            {o.email ? ` (${o.email})` : ""}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <Button
        size="sm"
        disabled={!ownerId}
        onClick={async () => {
          try {
            await api(`/api/messages/${messageId}/attach`, { body: { ownerId } });
            toast.success("Attached to the owner's conversation");
            router.refresh();
          } catch (error) {
            toast.error((error as Error).message);
          }
        }}
      >
        Attach
      </Button>
    </div>
  );
}
