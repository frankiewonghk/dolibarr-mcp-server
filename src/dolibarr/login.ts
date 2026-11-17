import { parseReply } from "./client.js";
import { cleanMessage } from "./shape.js";
import { fetchTransport, nodeTransport } from "./transport.js";

export type LoginResult =
  | { ok: true; apiKey: string }
  | { ok: false; reason: "bad_credentials" | "no_api_key" | "disabled" | "unreachable"; message: string };

/**
 * Check a Dolibarr login and password and get that user's API key, using
 * Dolibarr's own login endpoint. The password is used for this one call and
 * never stored.
 */
export async function dolibarrLogin(
  baseUrl: string,
  login: string,
  password: string,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<LoginResult> {
  const transport = options.fetchImpl ? fetchTransport(options.fetchImpl) : nodeTransport;
  let status: number;
  let payload: unknown;
  try {
    const reply = await transport(new URL(`${baseUrl.replace(/\/+$/, "")}/api/index.php/login`), {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ login, password }),
      timeoutMs: options.timeoutMs ?? 30_000,
    });
    payload = parseReply(reply.text) ?? null;
    const embedded = Number((payload as { error?: { code?: unknown } } | null)?.error?.code);
    status = reply.status < 300 && Number.isInteger(embedded) && embedded >= 300 ? embedded : reply.status;
  } catch {
    return {
      ok: false,
      reason: "unreachable",
      message: "Dolibarr could not be reached. Please try again in a moment.",
    };
  }
  const ok = status >= 200 && status < 300;

  if (ok) {
    const token = (payload as { success?: { token?: unknown } } | null)?.success?.token;
    if (typeof token === "string" && /^[\x21-\x7e]{8,}$/.test(token)) {
      return { ok: true, apiKey: token };
    }
    return {
      ok: false,
      reason: "unreachable",
      message: "Dolibarr gave an unexpected reply. Please tell the administrator.",
    };
  }

  const raw = (payload as { error?: { message?: unknown } } | null)?.error?.message;
  const text = typeof raw === "string" ? cleanMessage(raw) : "";
  if (/No API token set/i.test(text)) {
    return {
      ok: false,
      reason: "no_api_key",
      message:
        "Your Dolibarr user has no API key yet. Ask the administrator to generate one on your user card, then sign in again.",
    };
  }
  if (/login API/i.test(text) && /disabled/i.test(text)) {
    return {
      ok: false,
      reason: "disabled",
      message: "Sign-in through the API is switched off in Dolibarr. Please tell the administrator.",
    };
  }
  if (status >= 500) {
    return {
      ok: false,
      reason: "unreachable",
      message: "Dolibarr reported an error. Please try again in a moment.",
    };
  }
  return { ok: false, reason: "bad_credentials", message: "The login or password is not correct." };
}
