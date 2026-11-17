import http from "node:http";
import https from "node:https";

export interface RawRequest {
  method: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
}

export interface RawResponse {
  status: number;
  text: string;
}

/** Sends one HTTP request and returns the status and the whole body as text. */
export type Transport = (url: URL, request: RawRequest) => Promise<RawResponse>;

export class TransportTimeout extends Error {
  constructor(readonly timeoutMs: number) {
    super(`no reply within ${timeoutMs} ms`);
    this.name = "TimeoutError";
  }
}

/**
 * The default transport, on node:http / node:https. Used instead of fetch()
 * because fetch can wait forever for the end of a reply that a PHP server
 * starts with warnings and closes without a length; node:http reads such a
 * reply to the end of the connection as HTTP/1.1 intends.
 */
export const nodeTransport: Transport = (url, request) =>
  new Promise<RawResponse>((resolve, reject) => {
    const lib = url.protocol === "https:" ? https : http;
    const headers: Record<string, string | number> = { ...request.headers };
    if (request.body !== undefined) headers["Content-Length"] = Buffer.byteLength(request.body);
    const chunks: Buffer[] = [];
    let status: number | undefined;
    let settled = false;
    const finish = (outcome: { reply?: RawResponse; error?: unknown }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (outcome.reply) resolve(outcome.reply);
      else reject(outcome.error);
    };
    const req = lib.request(url, { method: request.method, headers }, (res) => {
      status = res.statusCode ?? 0;
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => finish({ reply: { status: status ?? 0, text: Buffer.concat(chunks).toString("utf8") } }));
      res.on("error", (error) => finish({ error }));
    });
    const timer = setTimeout(() => req.destroy(new TransportTimeout(request.timeoutMs)), request.timeoutMs);
    req.on("error", (error: NodeJS.ErrnoException) => {
      // Dolibarr sends "304 Not Modified" with a JSON body, which HTTP does not
      // allow; Node reports it after the headers. The status is what matters.
      if (status !== undefined && error.code === "HPE_CLOSED_CONNECTION") {
        finish({ reply: { status, text: Buffer.concat(chunks).toString("utf8") } });
        return;
      }
      finish({ error });
    });
    req.end(request.body);
  });

/** A transport built on a fetch() implementation (used by tests). */
export function fetchTransport(fetchImpl: typeof fetch): Transport {
  return async (url, request) => {
    try {
      const response = await fetchImpl(url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal: AbortSignal.timeout(request.timeoutMs),
      });
      return { status: response.status, text: await response.text() };
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") throw new TransportTimeout(request.timeoutMs);
      throw error;
    }
  };
}
