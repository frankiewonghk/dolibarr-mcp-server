import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

/** Opaque random token, 256 bits, URL-safe. */
export function randomToken(prefix = ""): string {
  return prefix + randomBytes(32).toString("base64url");
}

/** Tokens are stored only as this hash; the token itself is never kept. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Parse MCP_SECRET_KEY: 64 hex characters = 32 bytes. */
export function parseSecretKey(hex: string): Buffer {
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    throw new Error(
      "MCP_SECRET_KEY must be 64 hex characters (make one with: openssl rand -hex 32)",
    );
  }
  return Buffer.from(hex, "hex");
}

/** AES-256-GCM. Output: base64url(iv | tag | ciphertext). */
export function encrypt(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64url");
}

export function decrypt(sealed: string, key: Buffer): string {
  const raw = Buffer.from(sealed, "base64url");
  if (raw.length < 28) throw new Error("Stored secret is damaged");
  const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([
    decipher.update(raw.subarray(28)),
    decipher.final(),
  ]).toString("utf8");
}
