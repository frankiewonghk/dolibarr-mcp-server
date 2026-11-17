import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { compact, extraFields, shape, toInt } from "../dolibarr/shape.js";
import { createdId } from "./actions.js";
import type { ToolContext } from "./context.js";
import {
  customFieldsInput,
  defined,
  fetchOne,
  idOrRef,
  list,
  noteInputs,
  optional,
  pageResult,
  paging,
  readTool,
  textFilter,
  toArrayOptions,
  writeTool,
  type Json,
} from "./helpers.js";

const PRODUCT_ROW = ["id", "ref", "label", "price", "price_ttc", "tva_tx", "pmp", "stock_reel", "barcode"] as const;

const PRODUCT_FULL = [
  ...PRODUCT_ROW,
  "description",
  "price_min",
  "price_base_type",
  "weight",
  "weight_units",
  "fk_unit",
  "fk_default_warehouse",
  "seuil_stock_alerte",
  "desiredstock",
  "customcode",
  "country_code",
  "accountancy_code_sell",
  "accountancy_code_buy",
  "note_public",
  "note_private",
  "date_creation",
  "date_modification",
] as const;

export function productFlags(product: Json): Json {
  return {
    kind: toInt(product.type) === 1 ? "service" : "product",
    for_sale: toInt(product.status) === 1,
    for_purchase: toInt(product.status_buy) === 1,
    lot_tracked: (toInt(product.status_batch) ?? 0) > 0,
  };
}

const productFields = {
  ref: z.string().min(1).max(128).describe("Product reference (code). Must be unique."),
  label: z.string().min(1).max(255),
  kind: z.enum(["product", "service"]).default("product"),
  description: z.string().max(10_000).optional(),
  price: z.number().min(0).optional().describe("Selling price before tax."),
  vat_rate: z.number().min(0).max(100).optional().describe("Default VAT rate in percent."),
  for_sale: z.boolean().default(true),
  for_purchase: z.boolean().default(true),
  lot_tracked: z.boolean().optional().describe("Track lots / serial numbers (needs the Lots module)."),
  barcode: z.string().max(180).optional(),
  weight: z.number().min(0).optional(),
  ...noteInputs,
  custom_fields: customFieldsInput,
};

type ProductArgs = Partial<z.infer<z.ZodObject<typeof productFields>>>;

const productBody = (a: ProductArgs): Json =>
  defined({
    ref: a.ref,
    label: a.label,
    type: a.kind === undefined ? undefined : a.kind === "service" ? 1 : 0,
    description: a.description,
    price: a.price,
    price_base_type: a.price === undefined ? undefined : "HT",
    tva_tx: a.vat_rate,
    status: a.for_sale === undefined ? undefined : a.for_sale ? 1 : 0,
    status_buy: a.for_purchase === undefined ? undefined : a.for_purchase ? 1 : 0,
    status_batch: a.lot_tracked === undefined ? undefined : a.lot_tracked ? 1 : 0,
    barcode: a.barcode,
    weight: a.weight,
    note_public: a.note_public,
    note_private: a.note_private,
    array_options: toArrayOptions(a.custom_fields),
  });

export function registerProductTools(server: McpServer, ctx: ToolContext): void {
  readTool(
    server,
    "dolibarr_product_search",
    {
      title: "Search products and services",
      description:
        "Finds products and services by ref, label or barcode. Rows include the selling price, weighted average cost (pmp) and physical stock, when the user may see them.",
      input: {
        query: z.string().max(100).optional().describe("Part of the ref, label or barcode."),
        kind: z.enum(["product", "service"]).optional(),
        ...paging,
      },
    },
    async ({ query, kind, limit, page }) => {
      const result = await list(ctx, "/products", {
        sqlfilters: textFilter(query, ["t.ref", "t.label", "t.barcode"]),
        mode: kind === "product" ? 1 : kind === "service" ? 2 : undefined,
        includestockdata: 1,
        limit,
        page,
        sortfield: "t.ref",
        sortorder: "ASC",
      });
      const rows = result.rows.map((product) => ({ ...shape(product, PRODUCT_ROW), ...productFlags(product) }));
      return pageResult(result, rows, limit, page);
    },
  );

  readTool(
    server,
    "dolibarr_product_get",
    {
      title: "Get a product or service",
      description:
        "Full record of one product by id or ref: description, prices, units, custom fields, its kit components (if it is a kit) and its supplier prices.",
      input: { product: idOrRef },
    },
    async ({ product }) => {
      const record = await fetchOne(ctx, { path: "/products", refPath: "/products/ref" }, product);
      const id = toInt(record.id);
      const [parts, supplierPrices] = await Promise.all([
        optional(() => ctx.api.get<Json[]>(`/products/${id}/subproducts`)),
        optional(() => ctx.api.get<Json[]>(`/products/${id}/purchase_prices`)),
      ]);
      return {
        ...shape(record, PRODUCT_FULL),
        ...productFlags(record),
        custom_fields: extraFields(record),
        kit_components: Array.isArray(parts)
          ? parts.map((p) => ({
              id: toInt(p.rowid),
              ...(compact({ ref: p.ref, label: p.label, qty: p.qty }) as Json),
            }))
          : undefined,
        supplier_prices: Array.isArray(supplierPrices)
          ? supplierPrices.map((p) =>
              shape(p, [
                "product_fourn_price_id",
                "fourn_id",
                "fourn_name",
                "ref_supplier",
                "fourn_qty",
                "fourn_unitprice",
                "fourn_price",
                "fourn_remise_percent",
                "fourn_multicurrency_code",
                "fourn_multicurrency_unitprice",
                "delivery_time_days",
              ]),
            )
          : undefined,
      };
    },
  );

  writeTool(
    server,
    ctx,
    "dolibarr_product_create",
    {
      title: "Create a product or service",
      description:
        "Creates a product or service. Search first with dolibarr_product_search: the ref must be unique.",
      input: productFields,
    },
    async (a) => {
      const id = createdId(await ctx.api.post<unknown>("/products", productBody(a)), "/products");
      const record = await ctx.api.get<Json>(`/products/${id}`);
      return { created: true, ...shape(record, PRODUCT_ROW), ...productFlags(record) };
    },
  );

  writeTool(
    server,
    ctx,
    "dolibarr_product_update",
    {
      title: "Update a product or service",
      description: "Changes fields of a product. Only the fields given are changed; a new price becomes the default selling price.",
      input: {
        product_id: z.number().int().positive(),
        ...productFields,
        ref: productFields.ref.optional(),
        label: productFields.label.optional(),
        kind: z.enum(["product", "service"]).optional(),
        for_sale: z.boolean().optional(),
        for_purchase: z.boolean().optional(),
      },
    },
    async ({ product_id, ...a }) => {
      await ctx.api.put(`/products/${product_id}`, productBody(a));
      const record = await ctx.api.get<Json>(`/products/${product_id}`);
      return { updated: true, ...shape(record, PRODUCT_FULL), ...productFlags(record), custom_fields: extraFields(record) };
    },
  );
}
