import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { DolibarrApiError } from "../dolibarr/client.js";
import { shape, toInt } from "../dolibarr/shape.js";
import { fail, run, type ToolContext } from "./context.js";

export type Json = Record<string, unknown>;

// --- Inputs shared by the search tools ---------------------------------------

export const paging = {
  limit: z.number().int().min(1).max(50).default(20).describe("Rows per page (max 50)."),
  page: z.number().int().min(0).default(0).describe("Page number, starting at 0."),
};

export const idOrRef = z
  .union([z.number().int().positive(), z.string().min(1).max(100)])
  .describe("The record's numeric id, or its ref exactly as shown in Dolibarr.");

// --- Dolibarr "sqlfilters" -----------------------------------------------------

/** Text typed by a user, made safe to put inside a filter value. */
const safe = (text: string): string => text.replace(/['"()\\%_:]/g, " ").replace(/\s+/g, " ").trim();

/** (col like '%text%') or (col2 like '%text%') */
export function textFilter(query: string | undefined, columns: string[]): string | undefined {
  const text = query ? safe(query) : "";
  if (text === "") return undefined;
  return `(${columns.map((column) => `(${column}:like:'%${text}%')`).join(" or ")})`;
}

export function equals(column: string, value: string | number | undefined | null): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return typeof value === "number" ? `(${column}:=:${value})` : `(${column}:=:'${safe(value)}')`;
}

export function allOf(...filters: Array<string | undefined>): string | undefined {
  const kept = filters.filter((filter): filter is string => Boolean(filter));
  return kept.length > 0 ? kept.join(" and ") : undefined;
}

// --- Fetching ------------------------------------------------------------------

export interface Page {
  rows: Json[];
  /** Total matching rows, when the endpoint reports it. */
  total?: number;
}

/** GET a list endpoint. Copes with both reply shapes and with "nothing found". */
export async function list(
  ctx: ToolContext,
  path: string,
  query: Record<string, string | number | boolean | undefined | null>,
  options: { pagination?: boolean } = {},
): Promise<Page> {
  let reply: unknown;
  try {
    reply = await ctx.api.get(path, {
      ...query,
      ...(options.pagination === false ? {} : { pagination_data: 1 }),
    });
  } catch (error) {
    // Older endpoints answer 404 when a search has no result.
    if (error instanceof DolibarrApiError && error.status === 404) return { rows: [], total: 0 };
    throw error;
  }
  if (Array.isArray(reply)) return { rows: reply as Json[] };
  const wrapped = reply as { data?: unknown; pagination?: { total?: unknown } } | null;
  if (wrapped && Array.isArray(wrapped.data)) {
    return { rows: wrapped.data as Json[], total: toInt(wrapped.pagination?.total) ?? undefined };
  }
  return { rows: [] };
}

/** The standard search reply: rows plus enough to ask for the next page. */
export function pageResult(page: Page, rows: unknown[], limit: number, pageNo: number): Json {
  return {
    count: rows.length,
    ...(page.total !== undefined ? { total: page.total } : {}),
    page: pageNo,
    more:
      page.total !== undefined ? (pageNo + 1) * limit < page.total : rows.length >= limit,
    rows,
  };
}

/**
 * Load one record by id or by ref. Uses the endpoint's own ref route when it
 * has one, otherwise an exact-match search.
 */
export async function fetchOne(
  ctx: ToolContext,
  target: { path: string; refPath?: string; refColumn?: string; query?: Record<string, string | number> },
  key: number | string,
): Promise<Json> {
  // A draft's ref is "(PROV<id>)": the number is the record id.
  const prov = typeof key === "string" ? /^\(PROV(\d+)\)$/i.exec(key.trim()) : null;
  const id =
    typeof key === "number" ? key : prov ? Number(prov[1]) : /^\d+$/.test(key.trim()) ? Number(key) : null;
  if (id !== null) return ctx.api.get<Json>(`${target.path}/${id}`, target.query);
  const ref = String(key).trim();
  if (target.refPath) {
    return ctx.api.get<Json>(`${target.refPath}/${encodeURIComponent(ref)}`, target.query);
  }
  const { rows } = await list(
    ctx,
    target.path,
    { sqlfilters: equals(target.refColumn ?? "t.ref", ref), limit: 2 },
    { pagination: false },
  );
  const hit = rows.find((row) => String(row.ref ?? "").toLowerCase() === ref.toLowerCase());
  if (!hit) {
    throw new DolibarrApiError(404, `Nothing found with ref "${ref}"`, "GET", target.path);
  }
  // The list row can be lighter than the record: reload by id.
  const hitId = toInt(hit.id);
  return hitId !== null ? ctx.api.get<Json>(`${target.path}/${hitId}`, target.query) : hit;
}

/** A side lookup that must not fail the whole tool (e.g. a tab the user may not see). */
export async function optional<T>(call: () => Promise<T>): Promise<T | undefined> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof DolibarrApiError) return undefined;
    throw error;
  }
}

/** Third-party names for a set of rows, looked up once each. */
export async function thirdPartyNames(
  ctx: ToolContext,
  ids: Array<unknown>,
): Promise<Map<number, string>> {
  const unique = [...new Set(ids.map(toInt).filter((id): id is number => id !== null && id > 0))];
  const names = new Map<number, string>();
  await Promise.all(
    unique.map(async (id) => {
      const party = await optional(() => ctx.api.get<Json>(`/thirdparties/${id}`));
      if (party && typeof party.name === "string") names.set(id, party.name);
    }),
  );
  return names;
}

// --- Registering -----------------------------------------------------------------

type Shape = Record<string, z.ZodType>;

/** Register a look-up tool: read-only, Dolibarr errors turned into readable text. */
export function readTool<S extends Shape>(
  server: McpServer,
  name: string,
  config: { title: string; description: string; input: S },
  handler: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>,
): void {
  server.registerTool(
    name,
    {
      title: config.title,
      description: config.description,
      inputSchema: config.input,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ((args: z.infer<z.ZodObject<S>>): Promise<CallToolResult> =>
      run(() => handler(args))) as never,
  );
}

export { fail };

// --- Document lines ----------------------------------------------------------------

const LINE_FIELDS = [
  "id",
  "fk_product",
  "product_ref",
  "product_label",
  "label",
  "desc",
  "qty",
  "qty_asked",
  "qty_shipped",
  "subprice",
  "remise_percent",
  "tva_tx",
  "total_ht",
  "ref_supplier",
  "fk_entrepot",
  "batch",
  "eatby",
  "sellby",
  "role",
  "unit_short_label",
  "fk_unit",
  "origin_line_id",
  "date_start",
  "date_end",
] as const;

/** Lines of an order, invoice, shipment, reception or MO, trimmed to what matters. */
export function shapeLines(lines: unknown): Json[] {
  if (!Array.isArray(lines)) return [];
  return (lines as Json[]).map((line) => {
    const out = shape(line, LINE_FIELDS);
    // Reception lines carry the product as a nested object.
    const product = line.product as Json | undefined;
    if (product && !out.product_ref) {
      if (product.ref) out.product_ref = product.ref;
      if (product.label && !out.label) out.product_label = product.label;
    }
    if (typeof out.desc === "string") {
      if (out.desc === out.product_label) delete out.desc;
      else if (out.desc.length > 300) out.desc = `${out.desc.slice(0, 300)}…`;
    }
    const batches = line.detail_batch;
    if (Array.isArray(batches) && batches.length > 0) {
      out.lots = (batches as Json[]).map((b) => shape(b, ["batch", "qty", "eatby", "sellby"]));
    }
    return out;
  });
}

// --- Write tools -----------------------------------------------------------------

/** Extra inputs of every tool whose effect cannot simply be undone. */
export const confirmInput = {
  confirm: z
    .boolean()
    .default(false)
    .describe(
      "false (default) = change nothing, only show what would happen. " +
        "true = do it. Set true only after the user has explicitly agreed to this exact step.",
    ),
  reason: z
    .string()
    .max(300)
    .optional()
    .describe("One line on why, kept in the audit log. Required when confirm is true."),
};

export interface WriteConfig<S extends Shape> {
  title: string;
  description: string;
  input: S;
  /**
   * True for steps that cannot simply be undone (validate, close, delete,
   * stock movements, payments). They need confirm=true and a reason, and
   * answer with a preview otherwise.
   */
  guarded?: boolean;
}

/**
 * Register a tool that changes data. It is left out entirely for look-up-only
 * connections, so a read token never even sees it.
 */
export function writeTool<S extends Shape>(
  server: McpServer,
  ctx: ToolContext,
  name: string,
  config: WriteConfig<S>,
  handler: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>,
  /** What to show before confirmation; defaults to the arguments as given. */
  preview?: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>,
): void {
  if (!ctx.canWrite) return;
  const guarded = config.guarded === true;
  if (guarded && ("confirm" in config.input || "reason" in config.input)) {
    // The guard takes these two out of the arguments; a tool field of the same name would be lost.
    throw new Error(`${name}: a guarded tool cannot have its own "confirm" or "reason" input`);
  }
  server.registerTool(
    name,
    {
      title: config.title,
      description: guarded
        ? `${config.description} This step cannot simply be undone: without confirm=true it only returns a preview.`
        : config.description,
      inputSchema: guarded ? { ...config.input, ...confirmInput } : config.input,
      annotations: {
        readOnlyHint: false,
        destructiveHint: guarded,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    (async (raw: Record<string, unknown>): Promise<CallToolResult> => {
      const { confirm, reason, ...rest } = raw as { confirm?: boolean; reason?: string };
      const args = rest as z.infer<z.ZodObject<S>>;
      if (guarded && confirm !== true) {
        return run(async () => ({
          preview: true,
          nothing_changed: true,
          tool: name,
          would_do: preview ? await preview(args) : args,
          next: "Show this to the user. Once they agree, call the tool again with the same arguments, confirm=true and a reason.",
        }));
      }
      if (guarded && (reason ?? "").trim() === "") {
        return fail("confirm=true needs a reason: one line on why the user wants this step.");
      }
      return run(() => handler(args));
    }) as never,
  );
}

/** YYYY-MM-DD to the unix seconds Dolibarr expects (midnight UTC). */
export function toUnix(date: string | undefined): number | undefined {
  if (!date) return undefined;
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(ms)) throw new DolibarrApiError(400, `"${date}" is not a date (use YYYY-MM-DD)`, "POST", "");
  return ms / 1000;
}

export const dateInput = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe("Date as YYYY-MM-DD.");

/** Custom fields as the API wants them: {x: v} becomes array_options {options_x: v}. */
export function toArrayOptions(fields: Record<string, unknown> | undefined): Json | undefined {
  if (!fields || Object.keys(fields).length === 0) return undefined;
  const out: Json = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key.startsWith("options_") ? key : `options_${key}`] = value;
  }
  return out;
}

/** Drop undefined entries so they are not sent as null. */
export function defined<T extends Json>(body: T): Json {
  return Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined));
}

// --- Inputs shared by the write tools ------------------------------------------------

export const customFieldsInput = z
  .record(z.string(), z.unknown())
  .optional()
  .describe('Custom fields by code, e.g. {"region": "north"}. Get codes and allowed values from dolibarr_custom_field_list.');

export const noteInputs = {
  note_public: z.string().max(10_000).optional().describe("Note visible to the third party (printed on documents)."),
  note_private: z.string().max(10_000).optional().describe("Internal note."),
};

/** Today at midnight UTC, as unix seconds. */
export const today = (): number => Math.floor(Date.now() / 86_400_000) * 86_400;

/** Country id for an ISO code, through the countries dictionary. */
export async function countryId(ctx: ToolContext, code: string | undefined): Promise<number | undefined> {
  if (!code) return undefined;
  const country = await ctx.api.get<Json>(`/setup/dictionary/countries/byCode/${encodeURIComponent(code.toUpperCase())}`);
  const id = toInt(country.id);
  if (id === null) throw new DolibarrApiError(404, `Unknown country code "${code}"`, "GET", "/setup/dictionary/countries");
  return id;
}

/** Throw a readable error when a required argument for this action is missing. */
export function need<T>(value: T | undefined | null, message: string): T {
  if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) {
    throw new DolibarrApiError(400, message, "POST", "");
  }
  return value;
}
