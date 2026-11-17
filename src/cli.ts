import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { randomToken } from "./auth/crypto.js";
import { SCOPE_READ, SCOPE_WRITE } from "./auth/provider.js";
import type { Config } from "./config.js";
import { DolibarrApiError, DolibarrClient } from "./dolibarr/client.js";
import { openStore } from "./http.js";

export const CLI_HELP = `Admin commands (run on the server, as the service user):

  dolibarr-mcp-server token create --label <text> [--scope read|write] [--days <n>]
      Make a long-lived token for an automated agent. Asks for Dolibarr API key
      of the user the agent should act as (or pipe it on stdin).
  dolibarr-mcp-server token list
      Show tokens and sign-ins that still work.
  dolibarr-mcp-server token revoke <id>
      Stop one token or sign-in (id from "token list").
  dolibarr-mcp-server token revoke-user <login>
      Stop everything issued for one Dolibarr login.
  dolibarr-mcp-server audit [n]
      Show the last n tool calls (default 50).`;

function flag(args: string[], name: string): string | undefined {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
}

/** Read a secret: piped stdin, or a prompt that does not echo. */
async function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    let data = "";
    for await (const chunk of process.stdin) data += String(chunk);
    return data.trim();
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  const muted = rl as unknown as { _writeToOutput: (text: string) => void };
  let showing = true;
  muted._writeToOutput = (text) => {
    if (showing) process.stderr.write(text);
  };
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      process.stderr.write("\n");
      resolve(answer.trim());
    });
    showing = false;
  });
}

const day = (unix: number): string => new Date(unix * 1000).toISOString().slice(0, 10);
const stamp = (unix: number): string =>
  new Date(unix * 1000).toISOString().slice(0, 19).replace("T", " ");

export async function runCli(config: Config, args: string[]): Promise<void> {
  const [group, command, ...rest] = args;
  const store = openStore(config);
  try {
    if (group === "audit") {
      const limit = Number.parseInt(command ?? "50", 10) || 50;
      for (const row of store.auditTail(limit)) {
        console.log(
          `${stamp(row.ts)}  ${row.login.padEnd(16)} ${row.outcome.padEnd(5)} ${row.tool} ${row.args}` +
            (row.detail ? `  -> ${row.detail}` : ""),
        );
      }
      return;
    }
    if (group !== "token") throw new Error(CLI_HELP);

    switch (command) {
      case "create": {
        const label = flag(rest, "label");
        const scope = flag(rest, "scope") ?? "read";
        const days = Number.parseInt(flag(rest, "days") ?? "90", 10);
        if (!label) throw new Error("--label is required (say what the token is for)");
        if (scope !== "read" && scope !== "write") throw new Error("--scope must be read or write");
        if (!Number.isInteger(days) || days < 1 || days > 366) {
          throw new Error("--days must be between 1 and 366");
        }
        const apiKey = await readSecret("Dolibarr API key of the user to act as: ");
        if (apiKey === "") throw new Error("No API key given");

        // Prove the key works and learn whose it is.
        const api = new DolibarrClient({
          baseUrl: config.dolibarrUrl,
          apiKey,
          timeoutMs: config.dolibarrTimeoutMs,
        });
        let login: string;
        try {
          const user = await api.get<{ login?: string }>("/users/info");
          login = String(user.login ?? "").toLowerCase();
        } catch (error) {
          if (error instanceof DolibarrApiError && error.status === 401) {
            throw new Error("Dolibarr does not accept this API key");
          }
          const fallback = flag(rest, "login");
          if (!(error instanceof DolibarrApiError && error.status === 403 && fallback)) {
            throw new Error(
              `Could not read the key's user (${error instanceof Error ? error.message : error}). ` +
                "If this user may not read their own user record, add --login <login>.",
            );
          }
          login = fallback.toLowerCase();
        }
        if (login === "") throw new Error("Dolibarr did not say whose key this is");

        const token = randomToken("dmcp_st_");
        store.saveToken({
          token,
          kind: "static",
          clientId: "cli",
          grantId: randomUUID(),
          login,
          apiKey,
          scopes: scope === "write" ? [SCOPE_READ, SCOPE_WRITE] : [SCOPE_READ],
          resource: config.publicUrl ? `${config.publicUrl}/mcp` : null,
          label,
          expiresAt: Math.floor(Date.now() / 1000) + days * 86_400,
        });
        console.error(
          `Token for Dolibarr user "${login}" (${scope}), valid ${days} days. It is shown only once:`,
        );
        console.log(token);
        return;
      }
      case "list": {
        const rows = store.listActive();
        if (rows.length === 0) {
          console.log("No active tokens.");
          return;
        }
        console.log("ID        KIND     LOGIN            SCOPE  EXPIRES     CLIENT / LABEL");
        for (const row of rows) {
          const client =
            row.kind === "static"
              ? (row.label ?? "")
              : (store.getClient<{ client_name?: string }>(row.clientId)?.client_name ?? row.clientId);
          console.log(
            `${row.hash.slice(0, 8)}  ${(row.kind === "static" ? "token" : "sign-in").padEnd(8)} ` +
              `${row.login.padEnd(16)} ${(row.scopes.includes(SCOPE_WRITE) ? "write" : "read").padEnd(6)} ` +
              `${day(row.expiresAt)}  ${client}`,
          );
        }
        return;
      }
      case "revoke": {
        const id = rest[0];
        if (!id || !/^[0-9a-f]{6,64}$/.test(id)) throw new Error("Give the id from: token list");
        const matches = store.findByHashPrefix(id);
        if (matches.length !== 1) {
          throw new Error(matches.length === 0 ? "No token with that id" : "That id matches more than one token");
        }
        const changed = store.revokeGrant(matches[0]!.grantId);
        console.log(changed > 0 ? `Revoked (${matches[0]!.login}).` : "It was already revoked.");
        return;
      }
      case "revoke-user": {
        const login = rest[0]?.toLowerCase();
        if (!login) throw new Error("Give the Dolibarr login");
        console.log(`Revoked ${store.revokeLogin(login)} token(s) of ${login}.`);
        return;
      }
      default:
        throw new Error(CLI_HELP);
    }
  } finally {
    store.close();
  }
}
