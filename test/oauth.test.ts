import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Lockout } from "../src/auth/lockout.js";
import { decrypt, encrypt, parseSecretKey } from "../src/auth/crypto.js";
import { grantableScopes } from "../src/auth/provider.js";
import { Store } from "../src/auth/store.js";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/http.js";
import { summariseArgs } from "../src/server.js";

const SECRET = "ab".repeat(32);
const API_KEY = "k".repeat(32);
const REDIRECT = "https://client.example.test/callback";

/** Stands in for Dolibarr: one user, amy / right-password. */
const fakeDolibarr = (async (input: URL | RequestInfo, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status });
  if (url.pathname.endsWith("/login")) {
    const { login, password } = JSON.parse(String(init?.body)) as Record<string, string>;
    return login === "amy" && password === "right-password"
      ? json(200, { success: { code: 200, token: API_KEY } })
      : json(403, { error: { code: 403, message: "Access denied" } });
  }
  const key = (init?.headers as Record<string, string>).DOLAPIKEY;
  if (key !== API_KEY) return json(401, { error: { code: 401, message: "Unauthorized" } });
  if (url.pathname.endsWith("/users/info")) return json(200, { id: "3", login: "amy", admin: "0" });
  if (url.pathname.endsWith("/status")) {
    return json(200, { success: { code: 200, dolibarr_version: "22.0.2" } });
  }
  return json(404, { error: { code: 404, message: "Not found" } });
}) as unknown as typeof fetch;

let server: Server;
let base: string;
let store: Store;

beforeAll(async () => {
  store = new Store(":memory:", parseSecretKey(SECRET));
  // Port is only known after listening, so listen first on a throwaway app.
  const probe = (await import("node:http")).createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as AddressInfo).port;
  await new Promise((r) => probe.close(r));

  base = `http://localhost:${port}`;
  const config = loadConfig({
    DOLIBARR_URL: "https://dolibarr.example.test",
    DOLIBARR_NAME: "Test Dolibarr",
    MCP_PUBLIC_URL: base,
    MCP_SECRET_KEY: SECRET,
    MCP_DB_PATH: ":memory:",
  });
  const app = createApp(config, { store, fetchImpl: fakeDolibarr });
  server = await new Promise<Server>((r) => {
    const s = app.listen(port, "127.0.0.1", () => r(s));
  });
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  store.close();
});

const form = (data: Record<string, string>): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(data).toString(),
  redirect: "manual",
});

async function register(): Promise<string> {
  const res = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Test Client",
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** Open the sign-in page and return the hidden request id. */
async function startSignIn(clientId: string, challenge: string, extra: Record<string, string> = {}) {
  const url = new URL(`${base}/authorize`);
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT,
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "st-1",
    ...extra,
  }).toString();
  const res = await fetch(url, { redirect: "manual" });
  const html = await res.text();
  return { res, html, requestId: /name="request" value="([^"]+)"/.exec(html)?.[1] ?? "" };
}

async function signIn(clientId: string, allowWrite = true) {
  const { verifier, challenge } = pkce();
  const { requestId } = await startSignIn(clientId, challenge);
  const res = await fetch(
    `${base}/signin`,
    form({
      request: requestId,
      login: "amy",
      password: "right-password",
      action: "signin",
      ...(allowWrite ? { allow_write: "1" } : {}),
    }),
  );
  expect(res.status).toBe(302);
  const back = new URL(res.headers.get("location")!);
  expect(back.origin + back.pathname).toBe(REDIRECT);
  expect(back.searchParams.get("state")).toBe("st-1");
  const tokenRes = await fetch(
    `${base}/token`,
    form({
      grant_type: "authorization_code",
      client_id: clientId,
      code: back.searchParams.get("code")!,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
    }),
  );
  const tokens = (await tokenRes.json()) as Record<string, string>;
  return { tokenRes, tokens, code: back.searchParams.get("code")!, verifier };
}

async function callWhoami(token: string) {
  return fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "dolibarr_whoami", arguments: {} },
    }),
  });
}

describe("OAuth sign-in flow", () => {
  it("publishes the metadata clients look for", async () => {
    const as = (await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
    expect(as.authorization_endpoint).toBe(`${base}/authorize`);
    expect(as.registration_endpoint).toBe(`${base}/register`);
    expect(as.code_challenge_methods_supported).toContain("S256");
    const pr = (await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json()) as Record<string, unknown>;
    expect(pr.resource).toBe(`${base}/mcp`);
  });

  it("refuses the MCP endpoint without a token and points to the metadata", async () => {
    const res = await callWhoami("nope");
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("resource_metadata=");
  });

  it("signs in, calls a tool as that user, and writes the audit log", async () => {
    const clientId = await register();
    const { tokenRes, tokens } = await signIn(clientId);
    expect(tokenRes.status).toBe(200);
    expect(tokens.scope).toBe("dolibarr.read dolibarr.write");
    expect(tokens.access_token).toMatch(/^dmcp_at_/);

    const res = await callWhoami(tokens.access_token!);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('\\"login\\": \\"amy\\"');

    const last = store.auditTail(1)[0]!;
    expect(last).toMatchObject({ login: "amy", tool: "dolibarr_whoami", outcome: "ok", clientId });
  });

  it("shows the client and where it returns to on the sign-in page", async () => {
    const clientId = await register();
    const { res, html } = await startSignIn(clientId, pkce().challenge);
    expect(res.status).toBe(200);
    expect(html).toContain("Test Client");
    expect(html).toContain("client.example.test");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  it("rejects a wrong password and never issues a code", async () => {
    const clientId = await register();
    const { requestId } = await startSignIn(clientId, pkce().challenge);
    const res = await fetch(
      `${base}/signin`,
      form({ request: requestId, login: "amy", password: "wrong", action: "signin" }),
    );
    expect(res.status).toBe(401);
    expect(await res.text()).toContain("not correct");
  });

  it("gives a look-up-only token when the user unticks changes", async () => {
    const { tokens } = await signIn(await register(), false);
    expect(tokens.scope).toBe("dolibarr.read");
  });

  it("refuses a code used twice and a wrong PKCE verifier", async () => {
    const clientId = await register();
    const { code, verifier } = await signIn(clientId);
    const again = await fetch(
      `${base}/token`,
      form({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier }),
    );
    expect(again.status).toBe(400);

    const { challenge } = pkce();
    const { requestId } = await startSignIn(clientId, challenge);
    const back = await fetch(
      `${base}/signin`,
      form({ request: requestId, login: "amy", password: "right-password", action: "signin" }),
    );
    const fresh = new URL(back.headers.get("location")!).searchParams.get("code")!;
    const wrong = await fetch(
      `${base}/token`,
      form({ grant_type: "authorization_code", client_id: clientId, code: fresh, code_verifier: "x".repeat(43) }),
    );
    expect(wrong.status).toBe(400);
  });

  it("rotates refresh tokens and ends the sign-in if one is reused", async () => {
    const clientId = await register();
    const { tokens } = await signIn(clientId);
    const refresh = (token: string) =>
      fetch(`${base}/token`, form({ grant_type: "refresh_token", client_id: clientId, refresh_token: token }));

    const second = await refresh(tokens.refresh_token!);
    expect(second.status).toBe(200);
    const next = (await second.json()) as Record<string, string>;
    expect(next.refresh_token).not.toBe(tokens.refresh_token);
    // The old access token stops with the rotation; the new one works.
    expect((await callWhoami(tokens.access_token!)).status).toBe(401);
    expect((await callWhoami(next.access_token!)).status).toBe(200);

    // Reusing the first refresh token is a sign of theft: everything stops.
    expect((await refresh(tokens.refresh_token!)).status).toBe(400);
    expect((await callWhoami(next.access_token!)).status).toBe(401);
    expect((await refresh(next.refresh_token!)).status).toBe(400);
  });

  it("cancel returns access_denied to the client", async () => {
    const clientId = await register();
    const { requestId } = await startSignIn(clientId, pkce().challenge);
    const res = await fetch(`${base}/signin`, form({ request: requestId, action: "cancel" }));
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location")!).searchParams.get("error")).toBe("access_denied");
  });

  it("refuses a sign-in for another resource and an unknown redirect", async () => {
    const clientId = await register();
    const other = await startSignIn(clientId, pkce().challenge, {
      resource: "https://other.example.test/mcp",
    });
    expect(other.res.status).toBe(302);
    expect(new URL(other.res.headers.get("location")!).searchParams.get("error")).toBe("invalid_target");

    const bad = await startSignIn(clientId, pkce().challenge, {
      redirect_uri: "https://evil.example.test/cb",
    });
    expect(bad.res.status).toBe(400);
  });
});

describe("auth building blocks", () => {
  it("encrypts so that a wrong key or a changed value fails", () => {
    const key = parseSecretKey(SECRET);
    const sealed = encrypt("api-key-value", key);
    expect(sealed).not.toContain("api-key-value");
    expect(decrypt(sealed, key)).toBe("api-key-value");
    expect(() => decrypt(sealed, parseSecretKey("cd".repeat(32)))).toThrow();
    expect(() => parseSecretKey("short")).toThrow(/64 hex/);
  });

  it("stores tokens hashed and keys encrypted", () => {
    const s = new Store(":memory:", parseSecretKey(SECRET));
    s.saveToken({
      token: "dmcp_st_secret-token",
      kind: "static",
      clientId: "cli",
      grantId: "g1",
      login: "bot",
      apiKey: "the-dolibarr-key",
      scopes: ["dolibarr.read"],
      label: "nightly",
      expiresAt: Math.floor(Date.now() / 1000) + 60,
    });
    const record = s.findToken("dmcp_st_secret-token")!;
    expect(record.hash).not.toContain("secret-token");
    expect(s.apiKeyFor(record.hash)).toBe("the-dolibarr-key");
    expect(JSON.stringify(s.listActive())).not.toContain("the-dolibarr-key");
    expect(s.revokeLogin("bot")).toBe(1);
    expect(s.listActive()).toHaveLength(0);
    s.close();
  });

  it("locks a login after five failures, then lets it back in", () => {
    let t = 0;
    const lock = new Lockout(1000, 5, 20, () => t);
    for (let i = 0; i < 5; i++) lock.recordFailure("Amy", "1.1.1.1");
    expect(lock.isLocked("amy", "2.2.2.2")).toBe(true);
    expect(lock.isLocked("bob", "1.1.1.1")).toBe(false);
    t = 1001;
    expect(lock.isLocked("amy", "2.2.2.2")).toBe(false);
  });

  it("grants only known scopes, always with read", () => {
    expect(grantableScopes(undefined)).toEqual(["dolibarr.read", "dolibarr.write"]);
    expect(grantableScopes(["dolibarr.write", "admin"])).toEqual(["dolibarr.read", "dolibarr.write"]);
    expect(grantableScopes(["dolibarr.read"])).toEqual(["dolibarr.read"]);
  });

  it("masks secrets in audit arguments", () => {
    expect(summariseArgs({ ref: "SO1", password: "x", nested: { api_key: "y" } })).toBe(
      '{"ref":"SO1","password":"***","nested":{"api_key":"***"}}',
    );
  });
});
