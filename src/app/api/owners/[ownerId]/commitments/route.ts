import { body, handle } from "@/lib/api";
import { createCommitment } from "@/lib/commitments";
import type { CommitmentDraft } from "@/lib/rules";

export const POST = handle(async (request: Request, { params }: { params: Promise<{ ownerId: string }> }) => {
  const { ownerId } = await params;
  const draft = await body<CommitmentDraft & { note?: string }>(request);
  const result = await createCommitment(ownerId, draft);
  return Response.json(result);
});
