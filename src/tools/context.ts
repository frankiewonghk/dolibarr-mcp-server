import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "../config.js";
import { DolibarrApiError, type DolibarrClient } from "../dolibarr/client.js";

/** What every tool gets: the instance config and the signed-in user's client. */
export interface ToolContext {
  config: Config;
  api: DolibarrClient;
  /** False for look-up-only connections; write tools must refuse. */
  canWrite: boolean;
  /** Dolibarr login this connection signed in with, when known. */
  login?: string;
}

/** Replies larger than this are cut, so one call cannot flood the conversation. */
const MAX_REPLY_CHARS = 60_000;

export function ok(data: unknown): CallToolResult {
  let text = JSON.stringify(data, null, 1);
  if (text.length > MAX_REPLY_CHARS) {
    text =
      `${text.slice(0, MAX_REPLY_CHARS)}\n… [cut: the reply was ${text.length} characters. ` +
      "Ask for less: a smaller limit, a narrower search, or one record at a time.]";
  }
  return { content: [{ type: "text", text }] };
}

export function fail(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/** Run a tool body; Dolibarr errors become tool errors the agent can read. */
export async function run(
  body: () => Promise<unknown>,
): Promise<CallToolResult> {
  try {
    return ok(await body());
  } catch (error) {
    if (error instanceof DolibarrApiError) return fail(error.toAgentText());
    throw error;
  }
}
