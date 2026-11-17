import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DolibarrApiError } from "../dolibarr/client.js";
import { toInt } from "../dolibarr/shape.js";
import type { ToolContext } from "./context.js";
import { defined, need, writeTool, type Json } from "./helpers.js";

/**
 * Lines of customer documents (proposals, orders, invoices) and supplier
 * invoices. They share one input shape; the field names Dolibarr expects
 * differ a little per document type.
 */
export const lineInput = {
  product_id: z.number().int().positive().optional().describe("Product or service id. Leave out for a free-text line."),
  qty: z.number().positive().describe("Quantity."),
  unit_price: z
    .number()
    .optional()
    .describe("Unit price before tax. Leave out on a product line to use the product's price."),
  discount_percent: z.number().min(0).max(100).optional(),
  vat_rate: z
    .number()
    .min(0)
    .max(100)
    .optional()
    .describe("VAT rate in percent. Leave out for the product's default rate (0 on a free-text line)."),
  description: z.string().max(10_000).optional().describe("Line text. Required for a free-text line."),
  free_line_kind: z
    .enum(["service", "product"])
    .default("service")
    .describe("Only for a free-text line (no product_id): whether it is a service or goods."),
};

export const lineSchema = z.object(lineInput);
export type LineArgs = z.infer<typeof lineSchema>;

/** customer: subprice/desc (proposals, orders, invoices); supplier: pu_ht/description (supplier invoices). */
export type LineDialect = "customer" | "supplier";

/**
 * Fill in what Dolibarr's line routes do not look up themselves: the unit
 * price and VAT rate of the product, when the caller left them out.
 */
export async function withDefaults(ctx: ToolContext, line: Partial<LineArgs>, dialect: LineDialect, thirdpartyId?: number): Promise<Partial<LineArgs>> {
  if (!line.product_id || (line.unit_price !== undefined && line.vat_rate !== undefined)) return line;
  const product = await ctx.api.get<Json>(`/products/${line.product_id}`);
  let price: number | undefined;
  if (dialect === "supplier") {
    const prices = await ctx.api
      .get<Json[]>(`/products/${line.product_id}/purchase_prices`)
      .catch(() => [] as Json[]);
    const own = (Array.isArray(prices) ? prices : []).filter(
      (p) => thirdpartyId === undefined || toInt(p.fourn_id) === thirdpartyId,
    );
    const best = own.sort((a, b) => Number(a.fourn_qty ?? 0) - Number(b.fourn_qty ?? 0))[0];
    price = best ? Number(best.fourn_unitprice ?? best.fourn_price) : undefined;
  } else {
    price = product.price === undefined || product.price === null ? undefined : Number(product.price);
  }
  if (line.unit_price === undefined && price === undefined) {
    throw new DolibarrApiError(400, `No price found for product ${String(product.ref)}: give unit_price`, "POST", "");
  }
  return {
    ...line,
    unit_price: line.unit_price ?? price,
    vat_rate: line.vat_rate ?? (product.tva_tx === undefined ? undefined : Number(product.tva_tx)),
  };
}

/** The JSON body for a new line. */
export async function lineBody(
  ctx: ToolContext,
  line: Partial<LineArgs>,
  dialect: LineDialect,
  thirdpartyId?: number,
): Promise<Json> {
  const full = await withDefaults(ctx, line, dialect, thirdpartyId);
  const productType = full.product_id ? undefined : full.free_line_kind === "product" ? 0 : 1;
  if (dialect === "supplier") {
    return defined({
      fk_product: full.product_id,
      qty: full.qty,
      pu_ht: full.unit_price,
      remise_percent: full.discount_percent,
      tva_tx: full.vat_rate ?? 0,
      description: full.description ?? "",
      product_type: productType ?? 0,
      price_base_type: "HT",
    });
  }
  return defined({
    fk_product: full.product_id,
    qty: full.qty,
    subprice: full.unit_price,
    remise_percent: full.discount_percent,
    tva_tx: full.vat_rate ?? 0,
    desc: full.description ?? "",
    product_type: productType,
    price_base_type: "HT",
  });
}

/**
 * The body for a line update: the line as it is now, with the changes on
 * top. Dolibarr resets fields that are left out of an update, so everything
 * is sent back.
 */
export function mergedLineBody(current: Json, changes: Partial<LineArgs>, dialect: LineDialect): Json {
  const base = {
    fk_product: toInt(current.fk_product) || undefined,
    qty: current.qty,
    remise_percent: current.remise_percent,
    tva_tx: current.tva_tx,
    product_type: toInt(current.product_type) ?? undefined,
    fk_unit: toInt(current.fk_unit) || undefined,
    date_start: current.date_start || undefined,
    date_end: current.date_end || undefined,
    price_base_type: "HT",
  };
  const given = {
    qty: changes.qty,
    remise_percent: changes.discount_percent,
    tva_tx: changes.vat_rate,
  };
  if (dialect === "supplier") {
    return defined({
      ...base,
      pu_ht: changes.unit_price ?? current.pu_ht ?? current.subprice,
      description: changes.description ?? current.description ?? current.desc ?? "",
      ...defined(given),
    });
  }
  return defined({
    ...base,
    subprice: changes.unit_price ?? current.subprice,
    desc: changes.description ?? current.desc ?? current.description ?? "",
    label: current.label || undefined,
    ...defined(given),
  });
}

/** Add lines one by one; return the problems instead of failing the whole document. */
export async function addLines(
  ctx: ToolContext,
  path: string,
  lines: Partial<LineArgs>[],
  dialect: LineDialect,
  thirdpartyId?: number,
  addRoute = "lines",
): Promise<string[]> {
  const problems: string[] = [];
  for (const [index, line] of lines.entries()) {
    try {
      await ctx.api.post(`${path}/${addRoute}`, await lineBody(ctx, line, dialect, thirdpartyId));
    } catch (error) {
      if (!(error instanceof DolibarrApiError)) throw error;
      problems.push(`Line ${index + 1}: ${error.message}`);
    }
  }
  return problems;
}

export interface LineToolSpec {
  name: string;
  /** "proposal", "order", … */
  noun: string;
  /** Collection path, e.g. "/proposals". */
  path: string;
  dialect: LineDialect;
  /** Route that adds one line; proposals use "line" ("lines" there takes an array). */
  addRoute?: string;
  /** The document after the change, as the tool should return it. */
  detail: (id: number) => Promise<Json>;
}

/** One tool per document type to add, change or remove lines of a draft. */
export function lineTool(server: McpServer, ctx: ToolContext, spec: LineToolSpec): void {
  const idKey = `${spec.noun.replace(/ /g, "_")}_id`;
  writeTool(
    server,
    ctx,
    spec.name,
    {
      title: `Add, change or remove a ${spec.noun} line`,
      description:
        `Edits the lines of a draft ${spec.noun}. add: qty and product_id (or a description and unit_price for a free-text line). ` +
        "update: line_id and the fields to change. delete: line_id.",
      input: {
        [idKey]: z.number().int().positive(),
        action: z.enum(["add", "update", "delete"]),
        line_id: z.number().int().positive().optional().describe("Needed for update and delete."),
        ...lineInput,
        qty: lineInput.qty.optional(),
      },
    },
    async (raw) => {
      const args = raw as Json & Partial<LineArgs> & { action: string; line_id?: number };
      const id = args[idKey] as number;
      const base = `${spec.path}/${id}`;
      const record = await ctx.api.get<Json>(base);
      const thirdpartyId = toInt(record.socid ?? record.fk_soc) ?? undefined;
      if (args.action === "add") {
        need(args.qty, "qty is needed to add a line");
        if (!args.product_id && !args.description) {
          throw new DolibarrApiError(400, "Give product_id, or a description for a free-text line", "POST", base);
        }
        await ctx.api.post(`${base}/${spec.addRoute ?? "lines"}`, await lineBody(ctx, args, spec.dialect, thirdpartyId));
      } else {
        const lineId = need(args.line_id, `line_id is needed to ${args.action} a line`);
        const lines = (Array.isArray(record.lines) ? record.lines : []) as Json[];
        const current = lines.find((line) => toInt(line.id ?? line.rowid) === lineId);
        if (!current) {
          throw new DolibarrApiError(404, `Line ${lineId} is not on ${spec.noun} ${String(record.ref)}`, "PUT", base);
        }
        if (args.action === "delete") {
          await ctx.api.delete(`${base}/lines/${lineId}`);
        } else {
          const reply = await ctx.api.put<unknown>(`${base}/lines/${lineId}`, mergedLineBody(current, args, spec.dialect));
          if (reply === false) {
            throw new DolibarrApiError(400, "Dolibarr refused the change to this line", "PUT", `${base}/lines/${lineId}`);
          }
        }
      }
      return { done: args.action, ...(await spec.detail(id)) };
    },
  );
}
