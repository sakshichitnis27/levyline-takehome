import { ValidationError } from "@/lib/commitments";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Wraps a route handler: known errors become JSON with the right status. */
export function handle<Args extends unknown[]>(fn: (...args: Args) => Promise<Response>) {
  return async (...args: Args) => {
    try {
      return await fn(...args);
    } catch (error) {
      if (error instanceof HttpError) return Response.json({ error: error.message }, { status: error.status });
      if (error instanceof ValidationError) return Response.json({ error: error.message, errors: error.errors }, { status: 422 });
      console.error(error);
      return Response.json({ error: (error as Error).message }, { status: 500 });
    }
  };
}

export async function body<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new HttpError(400, "Expected a JSON body");
  }
}
