import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DolibarrApiError } from "../dolibarr/client.js";
import { compact, extraFields, shape, STATUS, statusCode, statusLabel, toInt } from "../dolibarr/shape.js";
import { createdId, messagesOf } from "./actions.js";
import type { ToolContext } from "./context.js";
import {
  allOf,
  dateInput,
  defined,
  equals,
  fetchOne,
  idOrRef,
  list,
  need,
  optional,
  pageResult,
  paging,
  readTool,
  textFilter,
  toUnix,
  writeTool,
  type Json,
} from "./helpers.js";

const MO_FIELDS = ["id", "ref", "label", "qty", "fk_product", "fk_warehouse", "fk_bom", "date_start_planned", "date_end_planned", "date_valid", "date_creation"] as const;
const BOM_FIELDS = ["id", "ref", "label", "fk_product", "qty", "duration", "date_valid", "date_creation"] as const;
const MO_OPEN = [1, 2]; // validated, in progress

/** Product id to {product_ref, product_label}, looked up once each. */
async function productRefs(ctx: ToolContext, ids: unknown[]): Promise<Map<number, Json>> {
  const unique = [...new Set(ids.map(toInt).filter((id): id is number => id !== null && id > 0))];
  const out = new Map<number, Json>();
  await Promise.all(
    unique.map(async (id) => {
      const product = await optional(() => ctx.api.get<Json>(`/products/${id}`));
      if (product) out.set(id, { product_ref: product.ref, product_label: product.label });
    }),
  );
  return out;
}

async function withProducts(ctx: ToolContext, rows: Json[]): Promise<Json[]> {
  const refs = await productRefs(ctx, rows.map((row) => row.fk_product));
  return rows.map((row) => ({ ...row, ...(refs.get(toInt(row.fk_product) ?? -1) ?? {}) }));
}

export function registerProductionTools(server: McpServer, ctx: ToolContext): void {
  // =========================================================================
  // Bills of materials
  // =========================================================================

  const bomDetail = async (record: Json): Promise<Json> => {
    const lines = Array.isArray(record.lines) ? (record.lines as Json[]) : [];
    const [head] = await withProducts(ctx, [
      {
        ...shape(record, [...BOM_FIELDS, "description", "note_public", "note_private"]),
        type: toInt(record.bomtype) === 1 ? "disassemble" : "manufacture",
        status: statusLabel(STATUS.bom, record.status),
      },
    ]);
    return {
      ...head,
      custom_fields: extraFields(record),
      lines: await withProducts(
        ctx,
        lines.map((line) =>
          shape(line, ["id", "fk_product", "qty", "qty_frozen", "disable_stock_change", "efficiency", "position", "description"]),
        ),
      ),
    };
  };

  readTool(
    server,
    "dolibarr_bom_search",
    {
      title: "Search bills of materials",
      description: "Finds bills of materials (BOMs) by ref or label, optionally for one product.",
      input: {
        query: z.string().max(100).optional(),
        product_id: z.number().int().positive().optional().describe("Only BOMs that make this product."),
        status: z.enum(["draft", "validated", "disabled"]).optional(),
        ...paging,
      },
    },
    async ({ query, product_id, status, limit, page }) => {
      const result = await list(
        ctx,
        "/boms",
        {
          sqlfilters: allOf(
            textFilter(query, ["t.ref", "t.label"]),
            equals("t.fk_product", product_id),
            status ? equals("t.status", statusCode(STATUS.bom, status)) : undefined,
          ),
          limit,
          page,
          sortfield: "t.rowid",
          sortorder: "DESC",
        },
        { pagination: false },
      );
      const rows = result.rows.map((bom) => ({ ...shape(bom, BOM_FIELDS), status: statusLabel(STATUS.bom, bom.status) }));
      return pageResult(result, await withProducts(ctx, rows), limit, page);
    },
  );

  readTool(
    server,
    "dolibarr_bom_get",
    {
      title: "Get a bill of materials",
      description: "One BOM by id or ref, with its component lines.",
      input: { bom: idOrRef },
    },
    async ({ bom }) => bomDetail(await fetchOne(ctx, { path: "/boms" }, bom)),
  );

  writeTool(
    server,
    ctx,
    "dolibarr_bom_create",
    {
      title: "Create a bill of materials",
      description:
        "Creates a draft BOM for a product, with its component lines. The standard API has no route to validate a BOM: " +
        "the user validates it in the Dolibarr web interface before it can be used on a manufacturing order.",
      input: {
        product_id: z.number().int().positive().describe("The product the BOM makes."),
        label: z.string().min(1).max(255),
        qty: z.number().positive().default(1).describe("Quantity of the product one run of this BOM makes."),
        type: z.enum(["manufacture", "disassemble"]).default("manufacture"),
        note_private: z.string().max(10_000).optional(),
        lines: z
          .array(
            z.object({
              product_id: z.number().int().positive(),
              qty: z.number().positive(),
              qty_frozen: z.boolean().default(false).describe("The quantity does not scale with the quantity produced."),
              efficiency: z.number().positive().max(1).default(1),
            }),
          )
          .max(200)
          .default([]),
      },
    },
    async (a) => {
      const reply = await ctx.api.post<unknown>(
        "/boms",
        defined({
          ref: "auto",
          label: a.label,
          bomtype: a.type === "disassemble" ? 1 : 0,
          fk_product: a.product_id,
          qty: a.qty,
          status: 0,
          note_private: a.note_private,
        }),
      );
      const id = createdId(reply, "/boms");
      const problems: string[] = [];
      for (const [index, line] of a.lines.entries()) {
        try {
          await ctx.api.post(`/boms/${id}/lines`, {
            fk_product: line.product_id,
            qty: line.qty,
            qty_frozen: line.qty_frozen ? 1 : 0,
            efficiency: line.efficiency,
          });
        } catch (error) {
          if (!(error instanceof DolibarrApiError)) throw error;
          problems.push(`Line ${index + 1}: ${error.message}`);
        }
      }
      return {
        created: true,
        ...(await bomDetail(await ctx.api.get<Json>(`/boms/${id}`))),
        ...(problems.length > 0 ? { lines_not_added: problems } : {}),
      };
    },
  );

  writeTool(
    server,
    ctx,
    "dolibarr_bom_line",
    {
      title: "Add, change or remove a BOM line",
      description: "Edits the component lines of a draft BOM. add: product_id and qty. update: line_id and the fields to change. delete: line_id.",
      input: {
        bom_id: z.number().int().positive(),
        action: z.enum(["add", "update", "delete"]),
        line_id: z.number().int().positive().optional(),
        product_id: z.number().int().positive().optional(),
        qty: z.number().positive().optional(),
        qty_frozen: z.boolean().optional(),
        efficiency: z.number().positive().max(1).optional(),
      },
    },
    async (a) => {
      const base = `/boms/${a.bom_id}`;
      const bom = await ctx.api.get<Json>(base);
      if (toInt(bom.status) !== 0) {
        throw new DolibarrApiError(409, `BOM ${String(bom.ref)} is not a draft`, "POST", base);
      }
      const lines = (Array.isArray(bom.lines) ? bom.lines : []) as Json[];
      if (a.action === "add") {
        await ctx.api.post(
          `${base}/lines`,
          defined({
            fk_product: need(a.product_id, "add needs product_id"),
            qty: need(a.qty, "add needs qty"),
            qty_frozen: a.qty_frozen ? 1 : 0,
            efficiency: a.efficiency ?? 1,
          }),
        );
      } else {
        const line = lines.find((l) => toInt(l.id) === a.line_id);
        if (!line) throw new DolibarrApiError(404, `Line ${String(a.line_id)} is not on BOM ${String(bom.ref)}`, "PUT", base);
        if (a.action === "delete") {
          await ctx.api.delete(`${base}/lines/${a.line_id}`);
        } else {
          // Dolibarr replaces the whole line: send it back complete, with the changes on top.
          const reply = await ctx.api.put<unknown>(`${base}/lines/${a.line_id}`, {
            qty: a.qty ?? line.qty,
            qty_frozen: a.qty_frozen === undefined ? (toInt(line.qty_frozen) ?? 0) : a.qty_frozen ? 1 : 0,
            disable_stock_change: toInt(line.disable_stock_change) ?? 0,
            efficiency: a.efficiency ?? line.efficiency ?? 1,
            position: toInt(line.position) ?? -1,
          });
          if (reply === false) throw new DolibarrApiError(400, "Dolibarr refused the change to this line", "PUT", base);
        }
      }
      return { done: a.action, ...(await bomDetail(await ctx.api.get<Json>(base))) };
    },
  );

  writeTool(
    server,
    ctx,
    "dolibarr_bom_delete",
    {
      title: "Delete a bill of materials",
      description: "Deletes a BOM permanently.",
      guarded: true,
      input: { bom_id: z.number().int().positive() },
    },
    async ({ bom_id }) => {
      const before = await ctx.api.get<Json>(`/boms/${bom_id}`);
      const reply = await ctx.api.delete<unknown>(`/boms/${bom_id}`);
      return { done: "deleted", id: bom_id, ref: before.ref, messages: messagesOf(reply) };
    },
    async ({ bom_id }) => ({ effect: "deletes this BOM permanently", bom: await bomDetail(await ctx.api.get<Json>(`/boms/${bom_id}`)) }),
  );

  // =========================================================================
  // Manufacturing orders
  // =========================================================================

  const moDetail = async (record: Json): Promise<Json> => {
    const lines = Array.isArray(record.lines) ? (record.lines as Json[]) : [];
    const [head] = await withProducts(ctx, [
      { ...shape(record, [...MO_FIELDS, "note_public", "note_private"]), status: statusLabel(STATUS.mo, record.status) },
    ]);
    return {
      ...head,
      thirdparty_id: toInt(record.fk_soc ?? record.socid) || undefined,
      project_id: toInt(record.fk_project) || undefined,
      custom_fields: extraFields(record),
      lines: await withProducts(
        ctx,
        lines.map((line) => shape(line, ["id", "role", "fk_product", "qty", "batch", "fk_warehouse", "fk_mrp_production"])),
      ),
    };
  };

  readTool(
    server,
    "dolibarr_mo_search",
    {
      title: "Search manufacturing orders",
      description: "Finds manufacturing orders (MOs) by ref or label. Newest first.",
      input: {
        query: z.string().max(100).optional().describe("Part of the MO ref or label."),
        status: z.enum(["draft", "validated", "in progress", "produced", "cancelled"]).optional(),
        product_id: z.number().int().positive().optional().describe("Only MOs making this product."),
        ...paging,
      },
    },
    async ({ query, status, product_id, limit, page }) => {
      const result = await list(
        ctx,
        "/mos",
        {
          sqlfilters: allOf(
            textFilter(query, ["t.ref", "t.label"]),
            status ? equals("t.status", statusCode(STATUS.mo, status)) : undefined,
            equals("t.fk_product", product_id),
          ),
          limit,
          page,
          sortfield: "t.rowid",
          sortorder: "DESC",
        },
        { pagination: false },
      );
      const rows = result.rows.slice(0, limit).map((mo) => ({ ...shape(mo, MO_FIELDS), status: statusLabel(STATUS.mo, mo.status) }));
      return pageResult({ rows: result.rows.slice(0, limit) }, await withProducts(ctx, rows), limit, page);
    },
  );

  readTool(
    server,
    "dolibarr_mo_get",
    {
      title: "Get a manufacturing order",
      description:
        "One MO by id or ref: what it makes, and its lines (role toconsume / toproduce for what is planned, consumed / produced for what was posted).",
      input: { mo: idOrRef },
    },
    async ({ mo }) => moDetail(await fetchOne(ctx, { path: "/mos" }, mo)),
  );

  writeTool(
    server,
    ctx,
    "dolibarr_mo_create",
    {
      title: "Create a manufacturing order",
      description:
        "Creates a draft MO for a product. With a BOM, the lines to consume and produce are taken from it. " +
        "The standard API has no route to validate an MO: the user validates it in the Dolibarr web interface before production can be posted with dolibarr_mo_produce.",
      input: {
        product_id: z.number().int().positive(),
        qty: z.number().positive(),
        bom_id: z.number().int().positive().optional().describe("A validated BOM for this product."),
        warehouse_id: z.number().int().positive().optional().describe("Warehouse the finished product goes to."),
        label: z.string().max(255).optional(),
        thirdparty_id: z.number().int().positive().optional().describe("Customer the MO is made for."),
        project_id: z.number().int().positive().optional(),
        date_start_planned: dateInput.optional(),
        date_end_planned: dateInput.optional(),
        note_private: z.string().max(10_000).optional(),
      },
    },
    async (a) => {
      const reply = await ctx.api.post<unknown>(
        "/mos",
        defined({
          ref: "auto",
          mrptype: 0,
          status: 0,
          fk_product: a.product_id,
          qty: a.qty,
          fk_bom: a.bom_id,
          fk_warehouse: a.warehouse_id,
          label: a.label,
          fk_soc: a.thirdparty_id,
          fk_project: a.project_id,
          date_start_planned: toUnix(a.date_start_planned),
          date_end_planned: toUnix(a.date_end_planned),
          note_private: a.note_private,
        }),
      );
      const id = createdId(reply, "/mos");
      return { created: true, ...(await moDetail(await ctx.api.get<Json>(`/mos/${id}`))) };
    },
  );

  writeTool(
    server,
    ctx,
    "dolibarr_mo_delete",
    {
      title: "Delete a manufacturing order",
      description: "Deletes an MO permanently. Stock movements already posted on it are not reversed.",
      guarded: true,
      input: { mo_id: z.number().int().positive() },
    },
    async ({ mo_id }) => {
      const before = await ctx.api.get<Json>(`/mos/${mo_id}`);
      const reply = await ctx.api.delete<unknown>(`/mos/${mo_id}`);
      return { done: "deleted", id: mo_id, ref: before.ref, messages: messagesOf(reply) };
    },
    async ({ mo_id }) => ({ effect: "deletes this MO permanently", mo: await moDetail(await ctx.api.get<Json>(`/mos/${mo_id}`)) }),
  );

  writeTool(
    server,
    ctx,
    "dolibarr_mo_produce",
    {
      title: "Post consumption and production on a manufacturing order",
      description:
        "Records what was used and made on a validated or in-progress MO: each row names a toconsume or toproduce line of the MO, the quantity and the warehouse. " +
        "Material leaves stock and finished product enters stock. Lot-tracked products cannot be posted through the standard API. " +
        "With close_when_done the MO becomes Produced.",
      guarded: true,
      input: {
        mo_id: z.number().int().positive(),
        consume: z
          .array(
            z.object({
              line_id: z.number().int().positive().describe("Id of a toconsume line."),
              qty: z.number().positive(),
              warehouse_id: z.number().int().positive(),
            }),
          )
          .max(200)
          .default([]),
        produce: z
          .array(
            z.object({
              line_id: z.number().int().positive().describe("Id of a toproduce line."),
              qty: z.number().positive(),
              warehouse_id: z.number().int().positive(),
              unit_cost: z.number().min(0).optional(),
            }),
          )
          .max(200)
          .default([]),
        close_when_done: z.boolean().default(false),
        movement_label: z.string().max(255).optional(),
      },
    },
    async (a) => {
      if (a.consume.length === 0 && a.produce.length === 0) {
        throw new DolibarrApiError(400, "Give at least one consume or produce row", "POST", `/mos/${a.mo_id}/produceandconsume`);
      }
      const mo = await ctx.api.get<Json>(`/mos/${a.mo_id}`);
      const reply = await ctx.api.post<unknown>(`/mos/${a.mo_id}/produceandconsume`, {
        inventorylabel: a.movement_label ?? `Production ${String(mo.ref)}`,
        inventorycode: `MO${a.mo_id}-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}`,
        autoclose: a.close_when_done ? 1 : 0,
        arraytoconsume: a.consume.map((row) => ({ objectid: row.line_id, qty: row.qty, fk_warehouse: row.warehouse_id })),
        arraytoproduce: a.produce.map((row) =>
          defined({ objectid: row.line_id, qty: row.qty, fk_warehouse: row.warehouse_id, pricetoproduce: row.unit_cost }),
        ),
      });
      return { done: "posted", ...(await moDetail(await ctx.api.get<Json>(`/mos/${a.mo_id}`))), messages: messagesOf(reply) };
    },
    async (a) => {
      const mo = await ctx.api.get<Json>(`/mos/${a.mo_id}`);
      const status = toInt(mo.status) ?? -1;
      return compact({
        effect: "posts stock movements: material leaves stock, finished product enters stock",
        warning: MO_OPEN.includes(status)
          ? undefined
          : `MO ${String(mo.ref)} is ${statusLabel(STATUS.mo, mo.status)}: only validated or in-progress MOs accept production`,
        mo: await moDetail(mo),
        consume: a.consume,
        produce: a.produce,
        close_when_done: a.close_when_done,
      }) as Json;
    },
  );
}
