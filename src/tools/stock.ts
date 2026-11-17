import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DolibarrApiError } from "../dolibarr/client.js";
import { isoDate, shape, toInt } from "../dolibarr/shape.js";
import type { ToolContext } from "./context.js";
import {
  allOf,
  dateInput,
  defined,
  equals,
  fetchOne,
  idOrRef,
  list,
  optional,
  pageResult,
  paging,
  readTool,
  textFilter,
  writeTool,
  type Json,
} from "./helpers.js";

const MOVEMENT_TYPE: Record<string, string> = {
  0: "manual in",
  1: "manual out",
  2: "out (shipment or consumption)",
  3: "in (reception or production)",
};

/** Warehouse id to name, for replies that only carry ids. */
export async function warehouseNames(ctx: ToolContext): Promise<Map<number, string>> {
  const { rows } = await list(ctx, "/warehouses", { limit: 500 }, { pagination: false });
  const names = new Map<number, string>();
  for (const row of rows) {
    const id = toInt(row.id);
    if (id !== null) names.set(id, String(row.label ?? row.ref ?? id));
  }
  return names;
}

/** Product, warehouse names and current stock, for previews. */
async function describeMove(ctx: ToolContext, productId: number, warehouseIds: number[]): Promise<Json> {
  const [product, names, stock] = await Promise.all([
    ctx.api.get<Json>(`/products/${productId}`),
    warehouseNames(ctx),
    optional(() => ctx.api.get<Json>(`/products/${productId}/stock`)),
  ]);
  const perWarehouse = (stock?.stock_warehouses ?? {}) as Record<string, Json>;
  return {
    product: {
      id: productId,
      ref: product.ref,
      label: product.label,
      lot_tracked: (toInt(product.status_batch) ?? 0) > 0,
    },
    stock_now: warehouseIds.map((id) => ({
      warehouse_id: id,
      warehouse: names.get(id),
      qty: Number(perWarehouse[String(id)]?.real ?? 0),
    })),
  };
}

const movementInput = (sign: "any" | "positive") => ({
  product_id: z.number().int().positive(),
  qty:
    sign === "positive"
      ? z.number().positive().describe("Quantity in the product's base unit.")
      : z
          .number()
          .refine((value) => value !== 0, "qty cannot be 0")
          .describe("Positive to add stock, negative to remove it (base unit)."),
  lot: z.string().max(128).optional().describe("Lot or serial number; required for lot-tracked products."),
  label: z.string().min(3).max(255).describe("Why: shown in the stock movement journal."),
});

export function registerStockTools(server: McpServer, ctx: ToolContext): void {
  readTool(
    server,
    "dolibarr_warehouse_list",
    {
      title: "List warehouses",
      description: "All warehouses with their id, location and whether they are open.",
      input: {
        query: z.string().max(100).optional().describe("Part of the warehouse ref, label or location."),
      },
    },
    async ({ query }) => {
      const { rows } = await list(
        ctx,
        "/warehouses",
        { sqlfilters: textFilter(query, ["t.ref", "t.description", "t.lieu"]), limit: 500 },
        { pagination: false },
      );
      return rows.map((w) => ({
        ...shape(w, ["id", "ref", "label", "description", "lieu", "address", "town", "country_code", "fk_parent"]),
        open: toInt(w.statut ?? w.status) === 1,
      }));
    },
  );

  readTool(
    server,
    "dolibarr_product_stock",
    {
      title: "Stock of a product",
      description:
        "Physical stock of one product per warehouse and, for lot-tracked products, per lot with best-before and sell-by dates. " +
        "Also gives the virtual stock (physical plus open orders).",
      input: { product: idOrRef },
    },
    async ({ product }) => {
      const record = await fetchOne(
        ctx,
        { path: "/products", refPath: "/products/ref", query: { includestockdata: 1 } },
        product,
      );
      const id = toInt(record.id);
      const [stock, names] = await Promise.all([
        ctx.api.get<Json>(`/products/${id}/stock`).catch((error: unknown) => {
          // Dolibarr answers 404 when the product has no stock anywhere.
          if (error instanceof DolibarrApiError && error.status === 404) return {} as Json;
          throw error;
        }),
        warehouseNames(ctx),
      ]);
      const perWarehouse = (stock.stock_warehouses ?? {}) as Record<string, Json>;
      return {
        product_id: id,
        ref: record.ref,
        label: record.label,
        physical_total: Number(record.stock_reel ?? stock.stock_reel ?? 0),
        virtual_total: record.stock_theorique === undefined ? undefined : Number(record.stock_theorique),
        warehouses: Object.entries(perWarehouse).map(([warehouseId, data]) => ({
          warehouse_id: Number(warehouseId),
          warehouse: names.get(Number(warehouseId)),
          qty: Number(data.real),
          lots: Object.values((data.detail_batch ?? {}) as Record<string, Json>).map((lot) =>
            shape(lot, ["batch", "qty", "eatby", "sellby"]),
          ),
        })),
      };
    },
  );

  readTool(
    server,
    "dolibarr_stock_movement_search",
    {
      title: "Search stock movements",
      description: "The stock movement journal, newest first. Filter by product, warehouse, lot or words in the movement label.",
      input: {
        product_id: z.number().int().positive().optional(),
        warehouse_id: z.number().int().positive().optional(),
        lot: z.string().max(128).optional().describe("Exact lot number."),
        query: z.string().max(100).optional().describe("Words in the movement label or inventory code."),
        ...paging,
      },
    },
    async ({ product_id, warehouse_id, lot, query, limit, page }) => {
      const [result, names] = await Promise.all([
        list(
          ctx,
          "/stockmovements",
          {
            sqlfilters: allOf(
              equals("t.fk_product", product_id),
              equals("t.fk_entrepot", warehouse_id),
              equals("t.batch", lot),
              textFilter(query, ["t.label", "t.inventorycode"]),
            ),
            limit,
            page,
            sortfield: "t.rowid",
            sortorder: "DESC",
          },
          { pagination: false },
        ),
        warehouseNames(ctx),
      ]);
      const rows = result.rows.map((m) => ({
        ...shape(m, ["id", "product_id", "warehouse_id", "qty", "price", "label", "inventorycode", "batch", "eatby", "sellby"]),
        warehouse: names.get(toInt(m.warehouse_id) ?? -1),
        date: isoDate(m.datem) ?? undefined,
        type: MOVEMENT_TYPE[String(m.type)] ?? m.type,
      }));
      return pageResult(result, rows, limit, page);
    },
  );

  writeTool(
    server,
    ctx,
    "dolibarr_stock_correct",
    {
      title: "Correct stock",
      description:
        "Books a manual stock correction in one warehouse: a positive qty adds stock, a negative qty removes it. For inventory corrections only; " +
        "goods received, shipped, produced or consumed should go through receptions, shipments and manufacturing orders.",
      guarded: true,
      input: {
        ...movementInput("any"),
        warehouse_id: z.number().int().positive(),
        eatby: dateInput.optional().describe("Best-before date, only when this creates a new lot."),
        sellby: dateInput.optional().describe("Sell-by date, only when this creates a new lot."),
        unit_cost: z.number().min(0).optional().describe("Unit cost of added stock, to update the weighted average cost."),
      },
    },
    async (a) => {
      const id = await ctx.api.post<unknown>(
        "/stockmovements",
        defined({
          product_id: a.product_id,
          warehouse_id: a.warehouse_id,
          qty: a.qty,
          type: a.qty > 0 ? 0 : 1,
          lot: a.lot,
          movementlabel: a.label,
          price: a.unit_cost?.toString(),
          // The API's parameter names are swapped: dluo is read as best-before, dlc as sell-by.
          dluo: a.eatby,
          dlc: a.sellby,
        }),
      );
      return { done: "stock corrected", movement_id: toInt(id), ...(await describeMove(ctx, a.product_id, [a.warehouse_id])) };
    },
    async (a) => ({
      effect: `${a.qty > 0 ? "adds" : "removes"} ${Math.abs(a.qty)} in warehouse ${a.warehouse_id}`,
      ...(await describeMove(ctx, a.product_id, [a.warehouse_id])),
      correction: a,
    }),
  );

  writeTool(
    server,
    ctx,
    "dolibarr_stock_transfer",
    {
      title: "Transfer stock between warehouses",
      description:
        "Moves a quantity of a product from one warehouse to another, as two linked stock movements (out of the source, into the destination) sharing one inventory code. " +
        "Lot-tracked products need the lot.",
      guarded: true,
      input: {
        ...movementInput("positive"),
        from_warehouse_id: z.number().int().positive(),
        to_warehouse_id: z.number().int().positive(),
      },
    },
    async (a) => {
      if (a.from_warehouse_id === a.to_warehouse_id) {
        throw new DolibarrApiError(400, "Source and destination warehouse are the same", "POST", "/stockmovements");
      }
      const code = `TRANSFER-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}`;
      const out = await ctx.api.post<unknown>(
        "/stockmovements",
        defined({
          product_id: a.product_id,
          warehouse_id: a.from_warehouse_id,
          qty: -a.qty,
          type: 1,
          lot: a.lot,
          movementlabel: a.label,
          movementcode: code,
        }),
      );
      let into: unknown;
      try {
        into = await ctx.api.post<unknown>(
          "/stockmovements",
          defined({
            product_id: a.product_id,
            warehouse_id: a.to_warehouse_id,
            qty: a.qty,
            type: 0,
            lot: a.lot,
            movementlabel: a.label,
            movementcode: code,
          }),
        );
      } catch (error) {
        if (!(error instanceof DolibarrApiError)) throw error;
        // Put the goods back so stock is not lost halfway.
        await ctx.api.post("/stockmovements", defined({
          product_id: a.product_id,
          warehouse_id: a.from_warehouse_id,
          qty: a.qty,
          type: 0,
          lot: a.lot,
          movementlabel: `${a.label} (transfer undone)`,
          movementcode: code,
        }));
        throw new DolibarrApiError(error.status, `The transfer was refused at the destination and undone: ${error.message}`, "POST", "/stockmovements");
      }
      return {
        done: "transferred",
        inventory_code: code,
        movement_ids: [toInt(out), toInt(into)],
        ...(await describeMove(ctx, a.product_id, [a.from_warehouse_id, a.to_warehouse_id])),
      };
    },
    async (a) => ({
      effect: `moves ${a.qty} from warehouse ${a.from_warehouse_id} to warehouse ${a.to_warehouse_id}`,
      ...(await describeMove(ctx, a.product_id, [a.from_warehouse_id, a.to_warehouse_id])),
      transfer: a,
    }),
  );
}
