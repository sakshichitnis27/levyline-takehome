"use client";

// Small fetch wrapper for client components: JSON in, JSON out, and a thrown
// Error carrying the server's message (and validation errors, if any).
export class ApiError extends Error {
  constructor(
    message: string,
    readonly errors: string[] = [],
  ) {
    super(message);
  }
}

export async function api<T = unknown>(url: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(url, {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers: options.body === undefined ? undefined : { "content-type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(data.error ?? `Request failed (${response.status})`, data.errors ?? []);
  return data as T;
}
