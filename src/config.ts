import { z } from "zod";

/** Groups of tools; each maps to one or more standard Dolibarr modules. */
export const TOOLSETS = [
  "core",
  "thirdparties",
  "products",
  "sales",
  "invoices",
  "purchasing",
  "stock",
  "production",
  "projects",
  "tickets",
  "agenda",
] as const;
export type Toolset = (typeof TOOLSETS)[number];

const list = (value: string): string[] =>
  value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

/** "all", or a comma-separated list; "core" is always included. */
const toolsetList = z
  .string()
  .default("all")
  .transform((value) => (value.trim().toLowerCase() === "all" ? [...TOOLSETS] : list(value)))
  .pipe(z.array(z.enum(TOOLSETS)))
  .transform((sets) => [...new Set<Toolset>(["core", ...sets])]);

const EnvSchema = z.object({
  DOLIBARR_URL: z.url().transform((url) => url.replace(/\/+$/, "")),
  DOLIBARR_API_KEY: z.string().optional(),
  DOLIBARR_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  DOLIBARR_NAME: z.string().min(1).default("Dolibarr"),
  DOLIBARR_TOOLSETS: toolsetList,
  DOLIBARR_WRITE_MODE: z.enum(["off", "guarded"]).default("guarded"),
  MCP_HOST: z.string().default("127.0.0.1"),
  MCP_PORT: z.coerce.number().int().min(1).max(65535).default(3900),
  MCP_ALLOWED_HOSTS: z.string().default("localhost,127.0.0.1").transform(list),
  MCP_TRUST_PROXY: z.string().default("loopback"),
  MCP_PUBLIC_URL: z
    .url()
    .transform((url) => url.replace(/\/+$/, ""))
    .optional(),
  MCP_SECRET_KEY: z.string().optional(),
  MCP_DB_PATH: z.string().default("./data/dolibarr-mcp.sqlite"),
  MCP_ACCESS_TTL_MIN: z.coerce.number().int().min(5).max(1440).default(60),
  MCP_REFRESH_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  MCP_AUDIT_KEEP_DAYS: z.coerce.number().int().min(1).default(365),
});

export interface Config {
  dolibarrUrl: string;
  /** Only for stdio mode: the one user this local process acts as. */
  dolibarrApiKey: string | undefined;
  dolibarrTimeoutMs: number;
  /** Display name of the Dolibarr instance, shown to the agent and on the sign-in page. */
  siteName: string;
  toolsets: Toolset[];
  writeMode: "off" | "guarded";
  host: string;
  port: number;
  allowedHosts: string[];
  /** Express "trust proxy" setting: which reverse proxies may set X-Forwarded-For. */
  trustProxy: string;
  /** Public https address of this server, e.g. https://mcp.example.com */
  publicUrl: string | undefined;
  /** 64 hex characters; encrypts the stored Dolibarr API keys. */
  secretKey: string | undefined;
  dbPath: string;
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
  auditKeepDays: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid configuration:\n${problems}`);
  }
  const e = parsed.data;
  return {
    dolibarrUrl: e.DOLIBARR_URL,
    dolibarrApiKey: e.DOLIBARR_API_KEY || undefined,
    dolibarrTimeoutMs: e.DOLIBARR_TIMEOUT_MS,
    siteName: e.DOLIBARR_NAME,
    toolsets: e.DOLIBARR_TOOLSETS,
    writeMode: e.DOLIBARR_WRITE_MODE,
    host: e.MCP_HOST,
    port: e.MCP_PORT,
    allowedHosts: e.MCP_ALLOWED_HOSTS,
    trustProxy: e.MCP_TRUST_PROXY,
    publicUrl: e.MCP_PUBLIC_URL,
    secretKey: e.MCP_SECRET_KEY || undefined,
    dbPath: e.MCP_DB_PATH,
    accessTtlSeconds: e.MCP_ACCESS_TTL_MIN * 60,
    refreshTtlSeconds: e.MCP_REFRESH_TTL_DAYS * 86_400,
    auditKeepDays: e.MCP_AUDIT_KEEP_DAYS,
  };
}
