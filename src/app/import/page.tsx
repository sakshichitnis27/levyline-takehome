import { ImportWizard } from "@/components/import/import-wizard";
import { PageHeader } from "@/components/page-header";

export default function Page() {
  return (
    <>
      <PageHeader title="Import" description="Owners and receivables from a CSV" />
      <main className="mx-auto w-full max-w-6xl p-6 md:p-10">
        <ImportWizard />
      </main>
    </>
  );
}
