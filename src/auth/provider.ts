import { randomUUID } from "node:crypto";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import {
  InvalidGrantError,
  InvalidTargetError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Response } from "express";
import { hashToken, randomToken } from "./crypto.js";
import { renderSignInPage } from "./signInPage.js";
import type { Store } from "./store.js";

export const SCOPE_READ = "dolibarr.read";
export const SCOPE_WRITE = "dolibarr.write";
export const SCOPES = [SCOPE_READ, SCOPE_WRITE];

const CODE_TTL_SECONDS = 120;
const PENDING_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING = 2000;

const now = (): number => Math.floor(Date.now() / 1000);

/** A sign-in that has shown its page and waits for the user's login. */
export interface PendingSignIn {
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
  scopes: string[];
  expiresAt: number;
}

export interface ProviderOptions {
  /** The MCP endpoint tokens are issued for, e.g. https://host/mcp */
  resourceUrl: string;
  siteName: string;
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
}

const sameResource = (a: string, b: string): boolean =>
  a.replace(/#.*$/, "").replace(/\/$/, "") === b.replace(/#.*$/, "").replace(/\/$/, "");

/** Scopes we will grant for a request: only ours, read always included. */
export function grantableScopes(requested: string[] | undefined): string[] {
  const wanted = (requested ?? []).filter((scope) => SCOPES.includes(scope));
  if (wanted.length === 0) return [...SCOPES];
  return wanted.includes(SCOPE_READ) ? wanted : [SCOPE_READ, ...wanted];
}

/**
 * OAuth 2.1 authorization server for this MCP endpoint. Users prove who they
 * are with their own Dolibarr login; the token we issue stands for their Dolibarr API
 * key, which stays on this server.
 */
export class DolibarrOAuthProvider implements OAuthServerProvider {
  private readonly pending = new Map<string, PendingSignIn>();

  constructor(
    private readonly store: Store,
    private readonly options: ProviderOptions,
  ) {}

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (clientId) =>
        this.store.getClient<OAuthClientInformationFull>(clientId),
      registerClient: (client) => {
        const full = client as OAuthClientInformationFull;
        this.store.saveClient(full.client_id, full);
        return full;
      },
    };
  }

  /** Step 1: the client sent the user here. Show the sign-in page. */
  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    if (params.resource && !sameResource(params.resource.href, this.options.resourceUrl)) {
      throw new InvalidTargetError("This server does not issue tokens for that resource");
    }
    this.dropExpiredPending();
    if (this.pending.size >= MAX_PENDING) {
      const oldest = this.pending.keys().next().value;
      if (oldest !== undefined) this.pending.delete(oldest);
    }
    const id = randomToken();
    const scopes = grantableScopes(params.scopes);
    this.pending.set(id, {
      client,
      params,
      scopes,
      expiresAt: Date.now() + PENDING_TTL_MS,
    });
    renderSignInPage(res, {
      requestId: id,
      siteName: this.options.siteName,
      clientName: client.client_name ?? "An application",
      redirectHost: new URL(params.redirectUri).host,
      writeRequested: scopes.includes(SCOPE_WRITE),
    });
  }

  getPending(id: string): PendingSignIn | undefined {
    const pending = this.pending.get(id);
    if (!pending) return undefined;
    if (pending.expiresAt < Date.now()) {
      this.pending.delete(id);
      return undefined;
    }
    return pending;
  }

  /**
   * Step 2: the user signed in. Issue a one-time code and return the address
   * to send the browser back to.
   */
  completeSignIn(
    id: string,
    login: string,
    apiKey: string,
    allowWrite: boolean,
  ): string {
    const pending = this.getPending(id);
    if (!pending) throw new Error("Sign-in request expired");
    this.pending.delete(id);

    const scopes = allowWrite
      ? pending.scopes
      : pending.scopes.filter((scope) => scope !== SCOPE_WRITE);
    const code = randomToken();
    this.store.saveCode(code, {
      clientId: pending.client.client_id,
      login,
      apiKey,
      scopes,
      codeChallenge: pending.params.codeChallenge,
      redirectUri: pending.params.redirectUri,
      resource: pending.params.resource?.href ?? null,
      expiresAt: now() + CODE_TTL_SECONDS,
    });

    const target = new URL(pending.params.redirectUri);
    target.searchParams.set("code", code);
    if (pending.params.state !== undefined) {
      target.searchParams.set("state", pending.params.state);
    }
    return target.href;
  }

  /** The user pressed Cancel: tell the client, per the OAuth spec. */
  cancelSignIn(id: string): string | undefined {
    const pending = this.getPending(id);
    if (!pending) return undefined;
    this.pending.delete(id);
    const target = new URL(pending.params.redirectUri);
    target.searchParams.set("error", "access_denied");
    target.searchParams.set("error_description", "The user cancelled the sign-in");
    if (pending.params.state !== undefined) {
      target.searchParams.set("state", pending.params.state);
    }
    return target.href;
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const code = this.store.peekCode(authorizationCode);
    if (!code || code.clientId !== client.client_id) {
      throw new InvalidGrantError("Invalid authorization code");
    }
    return code.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const code = this.store.takeCode(authorizationCode);
    if (!code || code.clientId !== client.client_id) {
      throw new InvalidGrantError("Invalid authorization code");
    }
    if (redirectUri !== undefined && redirectUri !== code.redirectUri) {
      throw new InvalidGrantError("redirect_uri does not match the authorization request");
    }
    if (resource && code.resource && !sameResource(resource.href, code.resource)) {
      throw new InvalidTargetError("resource does not match the authorization request");
    }
    return this.issue({
      clientId: client.client_id,
      grantId: randomUUID(),
      login: code.login,
      apiKey: code.apiKey,
      scopes: code.scopes,
    });
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
  ): Promise<OAuthTokens> {
    const record = this.store.findToken(refreshToken);
    if (!record || record.kind !== "refresh" || record.clientId !== client.client_id) {
      throw new InvalidGrantError("Invalid refresh token");
    }
    if (record.revokedAt !== null) {
      // A refresh token used twice means it leaked: end the whole sign-in.
      this.store.revokeGrant(record.grantId);
      throw new InvalidGrantError("Refresh token was already used");
    }
    if (record.expiresAt < now()) {
      throw new InvalidGrantError("Refresh token has expired");
    }
    const apiKey = this.store.apiKeyFor(record.hash);
    if (apiKey === undefined) throw new InvalidGrantError("Invalid refresh token");

    const narrowed =
      scopes && scopes.length > 0
        ? record.scopes.filter((scope) => scopes.includes(scope))
        : record.scopes;
    // Rotate: the old pair stops working, a new pair continues the same grant.
    this.store.revokeGrant(record.grantId);
    return this.issue({
      clientId: client.client_id,
      grantId: record.grantId,
      login: record.login,
      apiKey,
      scopes: narrowed.length > 0 ? narrowed : [SCOPE_READ],
    });
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const record = this.store.findToken(token);
    if (
      !record ||
      record.kind === "refresh" ||
      record.revokedAt !== null ||
      record.expiresAt < now()
    ) {
      throw new InvalidTokenError("Invalid or expired token");
    }
    return {
      token,
      clientId: record.clientId,
      scopes: record.scopes,
      expiresAt: record.expiresAt,
      resource: new URL(this.options.resourceUrl),
      extra: { login: record.login, tokenHash: record.hash, label: record.label },
    };
  }

  async revokeToken(
    client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    const record = this.store.findToken(request.token);
    if (record && record.clientId === client.client_id) {
      this.store.revokeGrant(record.grantId);
    }
  }

  private issue(grant: {
    clientId: string;
    grantId: string;
    login: string;
    apiKey: string;
    scopes: string[];
  }): OAuthTokens {
    const accessToken = randomToken("dmcp_at_");
    const refreshToken = randomToken("dmcp_rt_");
    const base = { ...grant, resource: this.options.resourceUrl };
    this.store.saveToken({
      ...base,
      token: accessToken,
      kind: "access",
      expiresAt: now() + this.options.accessTtlSeconds,
    });
    this.store.saveToken({
      ...base,
      token: refreshToken,
      kind: "refresh",
      expiresAt: now() + this.options.refreshTtlSeconds,
    });
    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: this.options.accessTtlSeconds,
      refresh_token: refreshToken,
      scope: grant.scopes.join(" "),
    };
  }

  private dropExpiredPending(): void {
    const t = Date.now();
    for (const [id, pending] of this.pending) {
      if (pending.expiresAt < t) this.pending.delete(id);
    }
  }
}

export { hashToken };
