// Runs once when the Next.js server starts: starts the automation worker.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.LEVYLINE_WORKER === "off") return;
  const { startWorker } = await import("@/lib/automation/worker");
  startWorker();
}
