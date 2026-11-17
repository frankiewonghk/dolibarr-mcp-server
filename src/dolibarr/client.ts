import { cleanMessage } from "./shape.js";
import { fetchTransport, nodeTransport, type Transport } from "./transport.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

export interface RequestOptions {
  /** Query-string values; undefined and null entries are left out. */
  query?: Record<string, string | number | boolean | undefined | null>;
  /** JSON body for POST / PUT. */
  body?: unknown;
}

/** An error reply from Dolibarr, with a hint the agent can act on. */
export class DolibarrApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly method: HttpMethod,
    readonly path: string,
  ) {
    super(message);
    this.name = "DolibarrApiError";
  }

  /** Text for the agent: what went wrong and what to do about it. */
  toAgentText(): string {
    return `${this.message} (HTTP ${this.status} on ${this.method} ${this.path})${hintFor(this.status)}`;
  }
}

function hintFor(status: number): string {
  switch (status) {
    case 304:
      return " Nothing was changed: the record is already in that state, or the step does not apply to its current status.";
    case 401:
      return " Dolibarr sign-in is no longer valid: the user has to reconnect.";
    case 403:
      return " The signed-in Dolibarr user is not allowed to do this. Do not retry; tell the user which right is missing.";
    case 404:
      return " Nothing found. Check the id or ref with a search tool first.";
    case 409:
      return " The record is in a state that does not allow this step. Read the record and check its status.";
    default:
      return "";
  }
}

export interface DolibarrClientOptions {
  /** Site URL without the /api/index.php part. */
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  /** Injectable for tests; the default transport uses node:http(s). */
  fetchImpl?: typeof fetch;
}

/**
 * Thin client for the Dolibarr REST API. One instance per signed-in user:
 * every call carries that user's own API key, so Dolibarr applies their
 * permissions and visibility rules.
 */
export class DolibarrClient {
  private readonly apiRoot: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly transport: Transport;

  constructor(options: DolibarrClientOptions) {
    this.apiRoot = `${options.baseUrl.replace(/\/+$/, "")}/api/index.php`;
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.transport = options.fetchImpl ? fetchTransport(options.fetchImpl) : nodeTransport;
  }

  get<T = unknown>(path: string, query?: RequestOptions["query"]): Promise<T> {
    return this.request<T>("GET", path, { query });
  }

  post<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", path, { body });
  }

  put<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("PUT", path, { body });
  }

  delete<T = unknown>(path: string): Promise<T> {
    return this.request<T>("DELETE", path);
  }

  async request<T = unknown>(
    method: HttpMethod,
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const cleanPath = `/${path.replace(/^\/+/, "")}`;
    const url = new URL(this.apiRoot + cleanPath);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = {
      DOLAPIKEY: this.apiKey,
      Accept: "application/json",
    };
    let body: string | undefined;
    if (method === "POST" || method === "PUT") {
      headers["Content-Type"] = "application/json";
      // Restler rejects action POSTs that have no body at all.
      body = JSON.stringify(options.body ?? { notrigger: 0 });
    }

    let status: number;
    let text: string;
    try {
      ({ status, text } = await this.transport(url, { method, headers, body, timeoutMs: this.timeoutMs }));
    } catch (cause) {
      const reason =
        cause instanceof Error && cause.name === "TimeoutError"
          ? `no reply within ${this.timeoutMs} ms`
          : cause instanceof Error
            ? cause.message
            : String(cause);
      throw new DolibarrApiError(0, `Could not reach Dolibarr: ${reason}`, method, cleanPath);
    }

    const payload = parseReply(text);
    // A PHP notice printed before the headers forces status 200, so an error can arrive as "200".
    const embedded = errorCode(payload);
    const effective = status >= 200 && status < 300 && embedded !== null ? embedded : status;

    if (effective < 200 || effective >= 300) {
      throw new DolibarrApiError(effective, errorMessage(payload, text, effective), method, cleanPath);
    }
    if (payload === undefined) {
      throw new DolibarrApiError(status, "Dolibarr sent a reply that is not JSON", method, cleanPath);
    }
    return payload as T;
  }
}

/**
 * Parse a reply. Instances that display PHP errors put notices such as
 * "<br /><b>Warning</b>: ..." in front of the JSON; those are dropped.
 */
export function parseReply(text: string): unknown {
  const attempt = (body: string): unknown => {
    try {
      return body === "" ? null : JSON.parse(body);
    } catch {
      return undefined;
    }
  };
  const direct = attempt(text.trim());
  if (direct !== undefined) return direct;
  const cleaned = text
    .replace(/<br \/>\s*<b>(?:Warning|Notice|Deprecated|Strict Standards)<\/b>:[\s\S]*?<br \/>/g, "")
    .trim();
  return cleaned === text.trim() ? undefined : attempt(cleaned);
}

/** The code of a Dolibarr error reply ({"error":{"code":404,...}}), or null. */
function errorCode(payload: unknown): number | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || !("error" in payload)) return null;
  const code = Number((payload as { error?: { code?: unknown } }).error?.code);
  return Number.isInteger(code) && code >= 300 && code < 600 ? code : null;
}

/** Dolibarr errors look like {"error":{"code":403,"message":"Forbidden: ..."}}. */
function errorMessage(payload: unknown, raw: string, status: number): string {
  if (payload && typeof payload === "object" && "error" in payload) {
    const error = (payload as { error?: { message?: unknown } }).error;
    if (error && typeof error.message === "string" && error.message !== "") {
      return cleanMessage(error.message);
    }
  }
  if (status === 304) return "Nothing to do";
  const snippet = cleanMessage(raw).slice(0, 300);
  return snippet !== "" ? snippet : `Dolibarr error ${status}`;
}
