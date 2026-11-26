import { tick } from "./engine";

const INTERVAL_MS = Number(process.env.LEVYLINE_WORKER_INTERVAL_MS || 3000);
const g = globalThis as unknown as { levylineWorker?: NodeJS.Timeout };

/** Polls for owners whose next step is due. State lives in Postgres, so a restart just carries on. */
export function startWorker() {
  if (g.levylineWorker) return;
  let running = false;
  g.levylineWorker = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await tick();
    } catch (error) {
      console.error("[automation] tick failed", error);
    } finally {
      running = false;
    }
  }, INTERVAL_MS);
  console.log(`[automation] worker started (every ${INTERVAL_MS} ms)`);
}
