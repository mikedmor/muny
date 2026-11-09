import { type ApiErrorBody, CHANGE_HEADER, CHANGE_TITLE_HEADER } from "@muny/shared";
import { announceChange } from "./changes.js";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: ApiErrorBody,
  ) {
    super(body.error);
  }

  /** Field-level messages keyed by path, for forms. */
  fieldErrors(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const i of this.body.issues ?? []) out[i.path] ??= i.message;
    return out;
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (method !== "GET") headers["x-muny-csrf"] = "1";
  let payload: BodyInit | undefined;
  if (body instanceof FormData) {
    payload = body;
  } else if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(url, { method, headers, body: payload, credentials: "same-origin" });
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    throw new ApiError(res.status, (data as ApiErrorBody) ?? { error: res.statusText });
  }
  // The server names a change worth offering to undo.
  const change = res.headers.get(CHANGE_HEADER);
  if (change) {
    let title = "Saved";
    try {
      title = decodeURIComponent(res.headers.get(CHANGE_TITLE_HEADER) ?? "") || title;
    } catch {
      // Keep "Saved".
    }
    announceChange({ id: change, title });
  }
  return data as T;
}

export const api = {
  get: <T>(url: string) => request<T>("GET", url),
  post: <T>(url: string, body?: unknown) => request<T>("POST", url, body),
  patch: <T>(url: string, body?: unknown) => request<T>("PATCH", url, body),
  put: <T>(url: string, body?: unknown) => request<T>("PUT", url, body),
  delete: <T>(url: string) => request<T>("DELETE", url),
};
