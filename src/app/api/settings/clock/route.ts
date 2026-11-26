import { body, handle } from "@/lib/api";
import { getClockSettings, now, setClock } from "@/lib/clock";

export const GET = handle(async () => Response.json({ now: await now(), settings: await getClockSettings() }));

export const POST = handle(async (request: Request) => {
  const change = await body<Parameters<typeof setClock>[0]>(request);
  await setClock(change);
  return Response.json({ now: await now(), settings: await getClockSettings() });
});
