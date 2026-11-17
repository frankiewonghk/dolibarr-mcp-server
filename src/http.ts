import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import {
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthRouter,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type Express, type Request, type Response } from "express";
import { parseSecretKey } from "./auth/crypto.js";
import { Lockout } from "./auth/lockout.js";
import { DolibarrOAuthProvider, SCOPE_WRITE, SCOPES } from "./auth/provider.js";
import { renderMessagePage, renderSignInPage } from "./auth/signInPage.js";
import { Store } from "./auth/store.js";
import type { Config } from "./config.js";
import { DolibarrClient } from "./dolibarr/client.js";
import { dolibarrLogin } from "./dolibarr/login.js";
import { buildServer, SERVER_VERSION } from "./server.js";

export function openStore(config: Config): Store {
  if (!config.secretKey) throw new Error("MCP_SECRET_KEY is required");
  if (config.dbPath !== ":memory:") {
    mkdirSync(dirname(config.dbPath), { recursive: true, mode: 0o700 });
  }
  return new Store(config.dbPath, parseSecretKey(config.secretKey));
}

export interface HttpDeps {
  store: Store;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

/** The Express app: OAuth endpoints, the sign-in form and the MCP endpoint. */
export function createApp(config: Config, deps: HttpDeps): Express {
  if (!config.publicUrl) throw new Error("MCP_PUBLIC_URL is required in http mode");
  const publicUrl = new URL(config.publicUrl);
  const mcpUrl = new URL(`${config.publicUrl}/mcp`);
  const { store } = deps;

  const provider = new DolibarrOAuthProvider(store, {
    resourceUrl: mcpUrl.href,
    siteName: config.siteName,
    accessTtlSeconds: config.accessTtlSeconds,
    refreshTtlSeconds: config.refreshTtlSeconds,
  });
  const lockout = new Lockout();

  const app = createMcpExpressApp({
    host: config.host,
    allowedHosts: [...new Set([...config.allowedHosts, publicUrl.hostname])],
  });
  // The reverse proxy in front sets X-Forwarded-For; needed for the caller's address.
  app.set("trust proxy", config.trustProxy);
  app.disable("x-powered-by");

  app.get("/healthz", (_req: Request, res: Response) => {
    res.json({ ok: true, version: SERVER_VERSION });
  });

  // --- Sign-in form ---------------------------------------------------------
  app.post(
    "/signin",
    express.urlencoded({ extended: false, limit: "8kb" }),
    async (req: Request, res: Response) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const text = (value: unknown): string => (typeof value === "string" ? value : "");
      const requestId = text(body.request);
      const login = text(body.login).trim();
      const password = text(body.password);
      const address = req.ip ?? "unknown";

      const pending = provider.getPending(requestId);
      if (!pending) {
        renderMessagePage(
          res,
          400,
          "Sign-in expired",
          "This sign-in page is no longer valid. Go back to your application and connect again.",
        );
        return;
      }

      if (text(body.action) === "cancel") {
        const target = provider.cancelSignIn(requestId);
        if (target) res.redirect(302, target);
        else renderMessagePage(res, 400, "Sign-in expired", "Please connect again.");
        return;
      }

      const again = (error: string, status: number): void =>
        renderSignInPage(
          res,
          {
            requestId,
            siteName: config.siteName,
            clientName: pending.client.client_name ?? "An application",
            redirectHost: new URL(pending.params.redirectUri).host,
            writeRequested: pending.scopes.includes(SCOPE_WRITE),
            error,
            login,
          },
          status,
        );

      if (login === "" || password === "") {
        again("Enter your Dolibarr login and password.", 400);
        return;
      }
      if (lockout.isLocked(login, address)) {
        again("Too many failed attempts. Wait 15 minutes and try again.", 429);
        return;
      }

      const result = await dolibarrLogin(config.dolibarrUrl, login, password, {
        timeoutMs: config.dolibarrTimeoutMs,
        fetchImpl: deps.fetchImpl,
      });
      if (!result.ok) {
        if (result.reason === "bad_credentials") lockout.recordFailure(login, address);
        console.error(`sign-in failed: login=${JSON.stringify(login)} reason=${result.reason} from=${address}`);
        again(result.message, result.reason === "bad_credentials" ? 401 : 502);
        return;
      }

      lockout.recordSuccess(login);
      const target = provider.completeSignIn(
        requestId,
        login.toLowerCase(),
        result.apiKey,
        text(body.allow_write) === "1",
      );
      console.error(`sign-in ok: login=${JSON.stringify(login)} client=${JSON.stringify(pending.client.client_name ?? pending.client.client_id)}`);
      res.redirect(302, target);
    },
  );

  // --- OAuth: metadata, /authorize, /token, /register, /revoke ---------------
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: publicUrl,
      resourceServerUrl: mcpUrl,
      scopesSupported: SCOPES,
      resourceName: config.siteName,
    }),
  );

  // Refused MCP requests leave no trace otherwise: log what the client sent.
  app.use("/mcp", (req: Request, res: Response, next) => {
    res.on("finish", () => {
      if (res.statusCode >= 400 && res.statusCode !== 401) {
        const header = (name: string): string => String(req.headers[name] ?? "-").slice(0, 80);
        console.error(
          `mcp request refused: status=${res.statusCode} method=${req.method} ` +
            `protocol=${JSON.stringify(header("mcp-protocol-version"))} accept=${JSON.stringify(header("accept"))} ` +
            `agent=${JSON.stringify(header("user-agent"))} rpc=${JSON.stringify(String((req.body as { method?: unknown } | undefined)?.method ?? "-").slice(0, 60))}`,
        );
      }
    });
    next();
  });

  // --- MCP endpoint -----------------------------------------------------------
  const bearer = requireBearerAuth({
    verifier: provider,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl),
  });

  app.post("/mcp", bearer, express.json({ limit: "1mb" }), async (req: Request, res: Response) => {
    const auth = req.auth!;
    const login = String(auth.extra?.login ?? "");
    const apiKey = store.apiKeyFor(String(auth.extra?.tokenHash ?? ""));
    if (apiKey === undefined) {
      res.status(401).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Unauthorized" },
        id: null,
      });
      return;
    }

    // Stateless: a fresh server and transport per request, nothing kept between calls.
    const api = new DolibarrClient({
      baseUrl: config.dolibarrUrl,
      apiKey,
      timeoutMs: config.dolibarrTimeoutMs,
      fetchImpl: deps.fetchImpl,
    });
    const server = buildServer(config, api, {
      login,
      clientId: auth.clientId,
      canWrite: auth.scopes.includes(SCOPE_WRITE),
      onToolCall: (call) => {
        try {
          store.audit({ login, clientId: auth.clientId, ...call });
        } catch (error) {
          console.error("audit write failed:", error);
        }
      },
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("MCP request failed:", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  const methodNotAllowed = (_req: Request, res: Response): void => {
    res
      .status(405)
      .set("Allow", "POST")
      .json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed" },
        id: null,
      });
  };
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  return app;
}

export async function runHttp(config: Config): Promise<void> {
  const store = openStore(config);
  store.cleanup(config.auditKeepDays);
  setInterval(() => store.cleanup(config.auditKeepDays), 3_600_000).unref();

  const app = createApp(config, { store });
  await new Promise<void>((resolve, reject) => {
    const listener = app.listen(config.port, config.host, () => {
      console.error(
        `dolibarr-mcp-server ${SERVER_VERSION} for "${config.siteName}" on http://${config.host}:${config.port} ` +
          `(public: ${config.publicUrl}/mcp; toolsets: ${config.toolsets.join(", ")}; writes: ${config.writeMode})`,
      );
      resolve();
    });
    listener.on("error", reject);
    const stop = (): void => {
      listener.close(() => {
        store.close();
        process.exit(0);
      });
      setTimeout(() => process.exit(0), 5000).unref();
    };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  });
}
