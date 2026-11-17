#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CLI_HELP, runCli } from "./cli.js";
import { loadConfig, type Config } from "./config.js";
import { DolibarrClient } from "./dolibarr/client.js";
import { runHttp } from "./http.js";
import { buildServer } from "./server.js";

const USAGE = `Usage:
  dolibarr-mcp-server stdio    Run as a local server for one user (needs DOLIBARR_API_KEY)
  dolibarr-mcp-server http     Run the remote server (OAuth sign-in, behind a reverse proxy)

${CLI_HELP}`;

/** Local use: one process per client, the key comes from the environment. */
async function runStdio(config: Config): Promise<void> {
  if (!config.dolibarrApiKey) {
    throw new Error("stdio mode needs DOLIBARR_API_KEY");
  }
  const api = new DolibarrClient({
    baseUrl: config.dolibarrUrl,
    apiKey: config.dolibarrApiKey,
    timeoutMs: config.dolibarrTimeoutMs,
  });
  const server = buildServer(config, api, {
    login: "local",
    clientId: "stdio",
    canWrite: true,
  });
  await server.connect(new StdioServerTransport());
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const mode = args[0] ?? (process.env.MCP_MODE || "stdio");
  if (mode === "help" || mode === "--help" || mode === "-h") {
    console.log(USAGE);
    return;
  }
  const config = loadConfig();
  if (mode === "http") return runHttp(config);
  if (mode === "stdio") return runStdio(config);
  if (mode === "token" || mode === "audit") return runCli(config, args);
  throw new Error(`Unknown command "${mode}".\n\n${USAGE}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
