import { DatabaseSync } from "node:sqlite";
import { decrypt, encrypt, hashToken } from "./crypto.js";

export type TokenKind = "access" | "refresh" | "static";

export interface TokenRecord {
  hash: string;
  kind: TokenKind;
  /** OAuth client id, or "cli" for automation tokens. */
  clientId: string;
  /** Links an access token and its refresh token; revoking one grant revokes both. */
  grantId: string;
  login: string;
  scopes: string[];
  resource: string | null;
  label: string | null;
  createdAt: number;
  /** Unix seconds. */
  expiresAt: number;
  revokedAt: number | null;
}

export interface NewToken {
  token: string;
  kind: TokenKind;
  clientId: string;
  grantId: string;
  login: string;
  apiKey: string;
  scopes: string[];
  resource?: string | null;
  label?: string | null;
  expiresAt: number;
}

export interface AuthCode {
  clientId: string;
  login: string;
  apiKey: string;
  scopes: string[];
  codeChallenge: string;
  redirectUri: string;
  resource: string | null;
  expiresAt: number;
}

export interface AuditEntry {
  login: string;
  clientId: string;
  tool: string;
  args: string;
  outcome: "ok" | "error";
  detail?: string;
  durationMs: number;
}

interface TokenRow {
  hash: string;
  kind: TokenKind;
  client_id: string;
  grant_id: string;
  login: string;
  enc_key: string;
  scopes: string;
  resource: string | null;
  label: string | null;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
}

const now = (): number => Math.floor(Date.now() / 1000);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id  TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_codes (
  hash           TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL,
  login          TEXT NOT NULL,
  enc_key        TEXT NOT NULL,
  scopes         TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  redirect_uri   TEXT NOT NULL,
  resource       TEXT,
  expires_at     INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tokens (
  hash       TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  client_id  TEXT NOT NULL,
  grant_id   TEXT NOT NULL,
  login      TEXT NOT NULL,
  enc_key    TEXT NOT NULL,
  scopes     TEXT NOT NULL,
  resource   TEXT,
  label      TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS tokens_grant ON tokens (grant_id);
CREATE INDEX IF NOT EXISTS tokens_login ON tokens (login);
CREATE TABLE IF NOT EXISTS audit (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  login       TEXT NOT NULL,
  client_id   TEXT NOT NULL,
  tool        TEXT NOT NULL,
  args        TEXT NOT NULL,
  outcome     TEXT NOT NULL,
  detail      TEXT,
  duration_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_ts ON audit (ts);
`;

/**
 * Everything the server keeps: OAuth clients, one-time codes, tokens and the
 * audit log. No business data. Tokens are stored as hashes and Dolibarr API
 * keys encrypted, so a copy of the file alone gives no access.
 */
export class Store {
  private readonly db: DatabaseSync;

  constructor(
    path: string,
    private readonly secretKey: Buffer,
  ) {
    // Node's built-in SQLite: no native module to compile on the server.
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // --- OAuth clients -------------------------------------------------------

  getClient<T>(clientId: string): T | undefined {
    const row = this.db
      .prepare("SELECT data FROM oauth_clients WHERE client_id = ?")
      .get(clientId) as unknown as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as T) : undefined;
  }

  saveClient(clientId: string, data: unknown): void {
    this.db
      .prepare(
        "INSERT INTO oauth_clients (client_id, data, created_at) VALUES (?, ?, ?)",
      )
      .run(clientId, JSON.stringify(data), now());
  }

  // --- Authorization codes -------------------------------------------------

  saveCode(code: string, data: AuthCode): void {
    this.db
      .prepare(
        `INSERT INTO auth_codes
           (hash, client_id, login, enc_key, scopes, code_challenge, redirect_uri, resource, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        hashToken(code),
        data.clientId,
        data.login,
        encrypt(data.apiKey, this.secretKey),
        data.scopes.join(" "),
        data.codeChallenge,
        data.redirectUri,
        data.resource,
        data.expiresAt,
      );
  }

  /** Look at a code without using it up (for the PKCE challenge lookup). */
  peekCode(code: string): Omit<AuthCode, "apiKey"> | undefined {
    return this.readCode(code, false);
  }

  /** Use a code: it is deleted, so it can never be exchanged twice. */
  takeCode(code: string): AuthCode | undefined {
    return this.readCode(code, true) as AuthCode | undefined;
  }

  private readCode(code: string, take: boolean): AuthCode | undefined {
    const hash = hashToken(code);
    type CodeRow = {
      client_id: string;
      login: string;
      enc_key: string;
      scopes: string;
      code_challenge: string;
      redirect_uri: string;
      resource: string | null;
      expires_at: number;
    };
    // DELETE ... RETURNING reads and removes in one step, so a code cannot be used twice.
    const row = this.db
      .prepare(
        take
          ? "DELETE FROM auth_codes WHERE hash = ? RETURNING *"
          : "SELECT * FROM auth_codes WHERE hash = ?",
      )
      .get(hash) as unknown as CodeRow | undefined;
    if (!row || row.expires_at < now()) return undefined;
    return {
      clientId: row.client_id,
      login: row.login,
      apiKey: take ? decrypt(row.enc_key, this.secretKey) : "",
      scopes: row.scopes.split(" ").filter(Boolean),
      codeChallenge: row.code_challenge,
      redirectUri: row.redirect_uri,
      resource: row.resource,
      expiresAt: row.expires_at,
    };
  }

  // --- Tokens --------------------------------------------------------------

  saveToken(input: NewToken): void {
    this.db
      .prepare(
        `INSERT INTO tokens
           (hash, kind, client_id, grant_id, login, enc_key, scopes, resource, label, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        hashToken(input.token),
        input.kind,
        input.clientId,
        input.grantId,
        input.login,
        encrypt(input.apiKey, this.secretKey),
        input.scopes.join(" "),
        input.resource ?? null,
        input.label ?? null,
        now(),
        input.expiresAt,
      );
  }

  /** The token's record, whether or not it is still valid. */
  findToken(token: string): TokenRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM tokens WHERE hash = ?")
      .get(hashToken(token)) as unknown as TokenRow | undefined;
    return row ? toRecord(row) : undefined;
  }

  /** Dolibarr API key behind a token. */
  apiKeyFor(tokenHash: string): string | undefined {
    const row = this.db
      .prepare("SELECT enc_key FROM tokens WHERE hash = ?")
      .get(tokenHash) as unknown as { enc_key: string } | undefined;
    return row ? decrypt(row.enc_key, this.secretKey) : undefined;
  }

  revokeGrant(grantId: string): number {
    return Number(
      this.db
        .prepare(
        "UPDATE tokens SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL",
        )
        .run(now(), grantId).changes,
    );
  }

  revokeToken(hash: string): number {
    return Number(
      this.db
        .prepare(
        "UPDATE tokens SET revoked_at = ? WHERE hash = ? AND revoked_at IS NULL",
        )
        .run(now(), hash).changes,
    );
  }

  revokeLogin(login: string): number {
    return Number(
      this.db
        .prepare(
        "UPDATE tokens SET revoked_at = ? WHERE login = ? AND revoked_at IS NULL",
        )
        .run(now(), login).changes,
    );
  }

  /** Tokens that still work, for the admin listing (refresh tokens left out). */
  listActive(): TokenRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM tokens
          WHERE revoked_at IS NULL AND expires_at >= ? AND kind != 'access'
          ORDER BY created_at DESC`,
      )
      .all(now()) as unknown as TokenRow[];
    return rows.map(toRecord);
  }

  findByHashPrefix(prefix: string): TokenRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM tokens WHERE hash LIKE ? ESCAPE '\\'")
      .all(`${prefix.replace(/[\\%_]/g, "\\$&")}%`) as unknown as TokenRow[];
    return rows.map(toRecord);
  }

  // --- Audit ---------------------------------------------------------------

  audit(entry: AuditEntry): void {
    this.db
      .prepare(
        `INSERT INTO audit (ts, login, client_id, tool, args, outcome, detail, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        now(),
        entry.login,
        entry.clientId,
        entry.tool,
        entry.args,
        entry.outcome,
        entry.detail ?? null,
        Math.round(entry.durationMs),
      );
  }

  auditTail(limit: number): Array<AuditEntry & { ts: number }> {
    const rows = this.db
      .prepare("SELECT * FROM audit ORDER BY id DESC LIMIT ?")
      .all(limit) as unknown as Array<{
      ts: number;
      login: string;
      client_id: string;
      tool: string;
      args: string;
      outcome: "ok" | "error";
      detail: string | null;
      duration_ms: number;
    }>;
    return rows.reverse().map((row) => ({
      ts: row.ts,
      login: row.login,
      clientId: row.client_id,
      tool: row.tool,
      args: row.args,
      outcome: row.outcome,
      detail: row.detail ?? undefined,
      durationMs: row.duration_ms,
    }));
  }

  // --- Housekeeping --------------------------------------------------------

  /** Drop expired codes and tokens long past their end; trim the audit log. */
  cleanup(auditKeepDays: number): void {
    const t = now();
    this.db.prepare("DELETE FROM auth_codes WHERE expires_at < ?").run(t);
    // Keep dead tokens a week: a reused refresh token must still be recognised.
    this.db
      .prepare("DELETE FROM tokens WHERE expires_at < ?")
      .run(t - 7 * 86_400);
    this.db
      .prepare("DELETE FROM audit WHERE ts < ?")
      .run(t - auditKeepDays * 86_400);
  }
}

function toRecord(row: TokenRow): TokenRecord {
  return {
    hash: row.hash,
    kind: row.kind,
    clientId: row.client_id,
    grantId: row.grant_id,
    login: row.login,
    scopes: row.scopes.split(" ").filter(Boolean),
    resource: row.resource,
    label: row.label,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}
