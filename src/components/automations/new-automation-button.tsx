"use client";

import { useRouter } from "next/navigation";
import { PlusIcon } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { api } from "@/lib/client";

export function NewAutomationButton({ clientId }: { clientId?: string }) {
  const router = useRouter();
  return (
    <Button
      size="sm"
      onClick={async () => {
        try {
          const { id } = await api<{ id: string }>("/api/automations", { body: { name: "New automation", clientId } });
          router.push(`/automations/${id}`);
        } catch (error) {
          toast.error((error as Error).message);
        }
      }}
    >
      <PlusIcon /> New automation
    </Button>
  );
}
