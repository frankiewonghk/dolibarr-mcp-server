import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Config, Toolset } from "./config.js";
import type { DolibarrClient } from "./dolibarr/client.js";
import { buildInstructions } from "./instructions.js";
import { registerPrompts } from "./prompts.js";
import { registerAgendaTools } from "./tools/agenda.js";
import type { ToolContext } from "./tools/context.js";
import { registerCoreTools } from "./tools/core.js";
import { registerInvoiceTools } from "./tools/invoices.js";
import { registerProductTools } from "./tools/products.js";
import { registerProductionTools } from "./tools/production.js";
import { registerProjectTools } from "./tools/projects.js";
import { registerPurchasingTools } from "./tools/purchasing.js";
import { registerSalesTools } from "./tools/sales.js";
import { registerStockTools } from "./tools/stock.js";
import { registerThirdpartyTools } from "./tools/thirdparties.js";
import { registerTicketTools } from "./tools/tickets.js";
import { VERSION } from "./version.js";

export { VERSION as SERVER_VERSION };

/** Who is calling, and what this connection may do. */
export interface Session {
  login: string;
  clientId: string;
  /** False for look-up-only tokens and when the instance is read-only. */
  canWrite: boolean;
  /** Called once per tool call, after it finishes. */
  onToolCall?: (call: ToolCallRecord) => void;
}

export interface ToolCallRecord {
  tool: string;
  args: string;
  outcome: "ok" | "error";
  detail?: string;
  durationMs: number;
}

/** One entry per toolset; a toolset is registered only if the instance enables it. */
const REGISTRARS: Record<Toolset, (server: McpServer, ctx: ToolContext) => void> = {
  core: registerCoreTools,
  thirdparties: registerThirdpartyTools,
  products: registerProductTools,
  sales: registerSalesTools,
  invoices: registerInvoiceTools,
  purchasing: registerPurchasingTools,
  stock: registerStockTools,
  production: registerProductionTools,
  projects: registerProjectTools,
  tickets: registerTicketTools,
  agenda: registerAgendaTools,
};

const SECRET_KEY = /pass|secret|token|api_?key/i;

/** Arguments for the audit log: secrets masked, length capped. */
export function summariseArgs(args: unknown, max = 500): string {
  const text =
    JSON.stringify(args ?? {}, (key, value: unknown) =>
      SECRET_KEY.test(key) ? "***" : value,
    ) ?? "{}";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Make every tool registered on this server report its calls to the session. */
function auditTools(server: McpServer, session: Session): void {
  const report = session.onToolCall;
  if (!report) return;
  type Register = (name: string, config: unknown, cb: (...a: unknown[]) => unknown) => unknown;
  const original = server.registerTool.bind(server) as unknown as Register;
  (server as unknown as { registerTool: Register }).registerTool = (name, config, cb) =>
    original(name, config, async (...callArgs: unknown[]) => {
      const started = performance.now();
      const hasInput = callArgs.length > 1;
      const args = summariseArgs(hasInput ? callArgs[0] : {});
      try {
        const result = (await cb(...callArgs)) as CallToolResult;
        const first = result.content?.[0];
        report({
          tool: name,
          args,
          outcome: result.isError ? "error" : "ok",
          detail:
            result.isError && first?.type === "text"
              ? first.text.slice(0, 300)
              : undefined,
          durationMs: performance.now() - started,
        });
        return result;
      } catch (error) {
        report({
          tool: name,
          args,
          outcome: "error",
          detail: (error instanceof Error ? error.message : String(error)).slice(0, 300),
          durationMs: performance.now() - started,
        });
        throw error;
      }
    });
}

/** Build an MCP server bound to one user's Dolibarr client. */
export function buildServer(
  config: Config,
  api: DolibarrClient,
  session: Session,
): McpServer {
  const canWrite = session.canWrite && config.writeMode !== "off";
  const server = new McpServer(
    { name: "dolibarr-mcp-server", title: config.siteName, version: VERSION },
    { instructions: buildInstructions(config, canWrite) },
  );
  auditTools(server, session);
  const ctx: ToolContext = { config, api, canWrite, login: session.login };
  for (const toolset of config.toolsets) {
    REGISTRARS[toolset](server, ctx);
  }
  registerPrompts(server, config, canWrite);
  return server;
}
