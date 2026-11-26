import Link from "next/link";
import { connection } from "next/server";
import { UsersIcon } from "lucide-react";

import { OwnersTable } from "@/components/owners/owners-table";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { listOwners } from "@/lib/owners";

export default async function Page() {
  await connection();
  const owners = await listOwners();
  return (
    <>
      <PageHeader title="Owners" description="Everyone who owes a service charge" />
      <main className="mx-auto w-full max-w-7xl p-6 md:p-10">
        {owners.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <UsersIcon />
              </EmptyMedia>
              <EmptyTitle>No owners yet</EmptyTitle>
              <EmptyDescription>Import an export from the accounts system to get started.</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button asChild>
                <Link href="/import">Import a file</Link>
              </Button>
            </EmptyContent>
          </Empty>
        ) : (
          <OwnersTable owners={owners} />
        )}
      </main>
    </>
  );
}
