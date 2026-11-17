import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DolibarrApiError } from "../dolibarr/client.js";
import { compact, STATUS, toInt } from "../dolibarr/shape.js";
import { createdId, messagesOf, statusTool, summary } from "./actions.js";
import type { ToolContext } from "./context.js";
import { documentDetail, documentRow, withPartyNames } from "./documents.js";
import {
  allOf,
  customFieldsInput,
  dateInput,
  defined,
  equals,
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
  today,
  toUnix,
  writeTool,
  type Json,
} from "./helpers.js";
import { paymentInput } from "./invoices.js";
import { addLines, lineSchema, lineTool, withDefaults } from "./lines.js";

const supplierFilter = z
  .number()
  .int()
  .positive()
  .optional()
  .describe("Only records of this supplier (id from dolibarr_thirdparty_search).");

/** Our status words to the status words of the supplier order list route. */
const SUPPLIER_ORDER_STATUS_PARAM: Record<string, string> = {
  draft: "draft",
  validated: "validated",
  approved: "approved",
  ordered: "running",
  "partially received": "received_start",
  received: "received_end",
  cancelled: "cancelled",
  refused: "refused",
};

const PAID = ["totalpaid", "remaintopay", "paye"] as const;

export function registerPurchasingTools(server: McpServer, ctx: ToolContext): void {
  // =========================================================================
  // Supplier orders (purchase orders)
  // =========================================================================

  const supplierOrderDetail = async (record: Json): Promise<Json> => {
    const [detail] = await withPartyNames(ctx, [documentDetail(record, STATUS.supplierOrder)]);
    return detail!;
  };

  readTool(
    server,
    "dolibarr_supplier_order_search",
    {
      title: "Search supplier orders",
      description: "Finds purchase orders sent to suppliers by ref or the supplier's reference. Newest first.",
      input: {
        query: z.string().max(100).optional().describe("Part of the order ref or supplier reference."),
        thirdparty_id: supplierFilter,
        status: z.enum(Object.keys(SUPPLIER_ORDER_STATUS_PARAM) as [string, ...string[]]).optional(),
        ...paging,
      },
    },
    async ({ query, thirdparty_id, status, limit, page }) => {
      const result = await list(ctx, "/supplierorders", {
        sqlfilters: textFilter(query, ["t.ref", "t.ref_supplier"]),
        thirdparty_ids: thirdparty_id,
        status: status ? SUPPLIER_ORDER_STATUS_PARAM[status] : undefined,
        limit,
        page,
        sortfield: "t.rowid",
        sortorder: "DESC",
      });
      const rows = result.rows.map((o) => documentRow(o, STATUS.supplierOrder));
      return pageResult(result, await withPartyNames(ctx, rows), limit, page);
    },
  );

  readTool(
    server,
    "dolibarr_supplier_order_get",
    {
      title: "Get a supplier order",
      description: "One purchase order by id or ref: head, custom fields and lines.",
      input: { supplier_order: idOrRef },
    },
    async ({ supplier_order }) =>
      supplierOrderDetail(await fetchOne(ctx, { path: "/supplierorders" }, supplier_order)),
  );

  writeTool(
    server,
    ctx,
    "dolibarr_supplier_order_create",
    {
      title: "Create a supplier order",
      description:
        "Creates a draft purchase order with its lines. Product lines without unit_price use the supplier's price for that product. " +
        "The standard API cannot edit the lines of an existing supplier order: get the lines right here, or delete the draft and create it again. " +
        "Validate, approve and send it with dolibarr_supplier_order_action.",
      input: {
        thirdparty_id: z.number().int().positive().describe("Supplier id."),
        date: dateInput.optional().describe("Order date; default today."),
        delivery_date: dateInput.optional().describe("Expected delivery date."),
        ref_supplier: z.string().max(255).optional().describe("The supplier's reference for this order."),
        ...noteInputs,
        custom_fields: customFieldsInput,
        lines: z.array(lineSchema).min(1).max(200),
      },
    },
    async (a) => {
      const lines = await Promise.all(
        a.lines.map(async (line) => {
          const full = await withDefaults(ctx, line, "supplier", a.thirdparty_id);
          return defined({
            fk_product: full.product_id,
            qty: full.qty,
            subprice: full.unit_price,
            remise_percent: full.discount_percent ?? 0,
            tva_tx: full.vat_rate ?? 0,
            desc: full.description ?? "",
            product_type: full.product_id ? 0 : full.free_line_kind === "product" ? 0 : 1,
          });
        }),
      );
      const reply = await ctx.api.post<unknown>(
        "/supplierorders",
        defined({
          socid: a.thirdparty_id,
          date: toUnix(a.date) ?? today(),
          delivery_date: toUnix(a.delivery_date),
          ref_supplier: a.ref_supplier,
          note_public: a.note_public,
          note_private: a.note_private,
          array_options: toArrayOptions(a.custom_fields),
          lines,
        }),
      );
      const id = createdId(reply, "/supplierorders");
      return { created: true, ...(await supplierOrderDetail(await ctx.api.get<Json>(`/supplierorders/${id}`))) };
    },
  );

  writeTool(
    server,
    ctx,
    "dolibarr_supplier_order_update",
    {
      title: "Update a supplier order's head",
      description: "Changes head fields of a supplier order (not its lines). Only the fields given are changed.",
      input: {
        supplier_order_id: z.number().int().positive(),
        delivery_date: dateInput.optional(),
        ref_supplier: z.string().max(255).optional(),
        ...noteInputs,
        custom_fields: customFieldsInput,
      },
    },
    async (a) => {
      await ctx.api.put(
        `/supplierorders/${a.supplier_order_id}`,
        defined({
          delivery_date: toUnix(a.delivery_date),
          ref_supplier: a.ref_supplier,
          note_public: a.note_public,
          note_private: a.note_private,
          array_options: toArrayOptions(a.custom_fields),
        }),
      );
      return {
        updated: true,
        ...(await supplierOrderDetail(await ctx.api.get<Json>(`/supplierorders/${a.supplier_order_id}`))),
      };
    },
  );

  statusTool(server, ctx, {
    name: "dolibarr_supplier_order_action",
    title: "Validate, approve, send or delete a supplier order",
    noun: "supplier order",
    path: "/supplierorders",
    statusMap: STATUS.supplierOrder,
    extraInput: {
      order_date: dateInput.optional().describe("With mark_ordered: the date the order was sent; default today."),
      order_method_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("With mark_ordered: how it was sent, from dolibarr_dictionary ordering_methods."),
      comment: z.string().max(500).optional().describe("With mark_ordered: a comment for the event log."),
    },
    bodyFor: (action, args) =>
      action === "mark_ordered"
        ? defined({
            date: toUnix(args.order_date as string | undefined) ?? today(),
            method: (args.order_method_id as number | undefined) ?? 1,
            comment: args.comment as string | undefined,
          })
        : undefined,
    actions: {
      validate: { route: "validate", body: { idwarehouse: 0, notrigger: 0 }, effect: "the draft gets its final ref and waits for approval" },
      approve: { route: "approve", body: { idwarehouse: 0, secondlevel: 0 }, effect: "approves the validated order so it can be sent to the supplier" },
      mark_ordered: { route: "makeorder", effect: "records that the approved order was sent to the supplier" },
      delete: { method: "DELETE", effect: "deletes the supplier order permanently" },
    },
  });

  writeTool(
    server,
    ctx,
    "dolibarr_supplier_order_receive",
    {
      title: "Receive goods on a supplier order into stock",
      description:
        "Books goods received against an ordered supplier order straight into a warehouse (the 'dispatch' of the Suppliers module), without a reception document. " +
        "Each row names the order line, the quantity and the warehouse; lot-tracked products also need the lot. " +
        "If the Receptions module is enabled, prefer dolibarr_reception_create.",
      guarded: true,
      input: {
        supplier_order_id: z.number().int().positive(),
        rows: z
          .array(
            z.object({
              order_line_id: z.number().int().positive(),
              qty: z.number().positive(),
              warehouse_id: z.number().int().positive(),
              batch: z.string().max(128).optional().describe("Lot or serial number."),
              eatby: dateInput.optional().describe("Best-before date of the lot."),
              sellby: dateInput.optional().describe("Sell-by date of the lot."),
            }),
          )
          .min(1)
          .max(200),
        close_when_complete: z.boolean().default(true).describe("Mark the order received when everything has arrived."),
        comment: z.string().max(500).optional(),
      },
    },
    async (a) => {
      const order = await ctx.api.get<Json>(`/supplierorders/${a.supplier_order_id}`);
      const lines = (Array.isArray(order.lines) ? order.lines : []) as Json[];
      const reply = await ctx.api.post<unknown>(`/supplierorders/${a.supplier_order_id}/receive`, {
        closeopenorder: a.close_when_complete ? 1 : 0,
        comment: a.comment ?? "",
        lines: a.rows.map((row) => {
          const line = lines.find((l) => toInt(l.id ?? l.rowid) === row.order_line_id);
          if (!line) {
            throw new DolibarrApiError(404, `Line ${row.order_line_id} is not on supplier order ${String(order.ref)}`, "POST", "");
          }
          return defined({
            id: row.order_line_id,
            fk_product: toInt(line.fk_product),
            qty: row.qty,
            warehouse: row.warehouse_id,
            price: line.subprice ?? line.pu_ht,
            batch: row.batch,
            eatby: row.eatby,
            sellby: row.sellby,
            comment: a.comment ?? "",
            notrigger: 0,
          });
        }),
      });
      const after = await ctx.api.get<Json>(`/supplierorders/${a.supplier_order_id}`);
      return { done: "received", ...(await summary(ctx, after, STATUS.supplierOrder)), messages: messagesOf(reply) };
    },
    async (a) => {
      const order = await ctx.api.get<Json>(`/supplierorders/${a.supplier_order_id}`);
      return {
        effect: "posts stock movements into the given warehouses for the received quantities",
        supplier_order: await supplierOrderDetail(order),
        rows: a.rows,
      };
    },
  );

  // =========================================================================
  // Receptions
  // =========================================================================

  const receptionDetail = async (record: Json): Promise<Json> => {
    const [detail] = await withPartyNames(ctx, [documentDetail(record, STATUS.reception)]);
    return {
      ...detail,
      supplier_order_id: record.origin_type === "order_supplier" || record.origin === "order_supplier" ? toInt(record.origin_id) : undefined,
    };
  };

  readTool(
    server,
    "dolibarr_reception_search",
    {
      title: "Search receptions",
      description: "Finds receptions (goods received from suppliers) by ref or the supplier's reference. Newest first.",
      input: {
        query: z.string().max(100).optional(),
        thirdparty_id: supplierFilter,
        status: z.enum(["draft", "validated", "closed"]).optional(),
        ...paging,
      },
    },
    async ({ query, thirdparty_id, status, limit, page }) => {
      const result = await list(ctx, "/receptions", {
        sqlfilters: allOf(
          textFilter(query, ["t.ref", "t.ref_supplier"]),
          status ? equals("t.fk_statut", { draft: 0, validated: 1, closed: 2 }[status]) : undefined,
        ),
        thirdparty_ids: thirdparty_id,
        limit,
        page,
        sortfield: "t.rowid",
        sortorder: "DESC",
      });
      const rows = result.rows.map((r) => documentRow(r, STATUS.reception));
      return pageResult(result, await withPartyNames(ctx, rows), limit, page);
    },
  );

  readTool(
    server,
    "dolibarr_reception_get",
    {
      title: "Get a reception",
      description: "One reception by id or ref, with its lines, warehouses and lots.",
      input: { reception: idOrRef },
    },
    async ({ reception }) => receptionDetail(await fetchOne(ctx, { path: "/receptions" }, reception)),
  );

  writeTool(
    server,
    ctx,
    "dolibarr_reception_create",
    {
      title: "Create a reception",
      description:
        "Creates a draft reception for a supplier order that has been sent (status ordered or partially received). " +
        "Each line names the supplier order line, the quantity received and the warehouse; lot-tracked products also need the lot. " +
        "Several lines may point at the same order line (e.g. one per lot). Validate it with dolibarr_reception_action to post the stock.",
      input: {
        supplier_order_id: z.number().int().positive(),
        date_delivery: dateInput.optional().describe("Date the goods arrived."),
        ref_supplier: z.string().max(255).optional().describe("The supplier's delivery note number."),
        ...noteInputs,
        lines: z
          .array(
            z.object({
              order_line_id: z.number().int().positive(),
              qty: z.number().positive(),
              warehouse_id: z.number().int().positive(),
              batch: z.string().max(128).optional(),
              eatby: dateInput.optional(),
              sellby: dateInput.optional(),
            }),
          )
          .min(1)
          .max(200),
      },
    },
    async (a) => {
      const order = await ctx.api.get<Json>(`/supplierorders/${a.supplier_order_id}`);
      const orderLines = (Array.isArray(order.lines) ? order.lines : []) as Json[];
      const reply = await ctx.api.post<unknown>(
        "/receptions",
        defined({
          socid: toInt(order.socid),
          origin_id: a.supplier_order_id,
          origin_type: "supplier_order",
          date_delivery: toUnix(a.date_delivery),
          ref_supplier: a.ref_supplier,
          note_public: a.note_public,
          note_private: a.note_private,
          lines: a.lines.map((line) => {
            const orderLine = orderLines.find((l) => toInt(l.id ?? l.rowid) === line.order_line_id);
            if (!orderLine) {
              throw new DolibarrApiError(404, `Line ${line.order_line_id} is not on supplier order ${String(order.ref)}`, "POST", "/receptions");
            }
            return defined({
              fk_product: toInt(orderLine.fk_product),
              fk_entrepot: line.warehouse_id,
              origin_type: "supplier_order",
              origin_id: a.supplier_order_id,
              origin_line_id: line.order_line_id,
              qty: line.qty,
              batch: line.batch,
              eatby: line.eatby,
              sellby: line.sellby,
              cost_price: orderLine.subprice ?? orderLine.pu_ht,
            });
          }),
        }),
      );
      const id = createdId(reply, "/receptions");
      return { created: true, ...(await receptionDetail(await ctx.api.get<Json>(`/receptions/${id}`))) };
    },
  );

  statusTool(server, ctx, {
    name: "dolibarr_reception_action",
    title: "Validate, close or delete a reception",
    noun: "reception",
    path: "/receptions",
    statusMap: STATUS.reception,
    actions: {
      validate: {
        route: "validate",
        body: { notrigger: 0 },
        effect: "the draft gets its final ref; depending on the stock setup this posts the goods into stock",
      },
      close: { route: "close", body: { notrigger: 0 }, effect: "classifies the reception as closed (processed)" },
      delete: { method: "DELETE", effect: "deletes the reception permanently" },
    },
  });

  // =========================================================================
  // Supplier invoices
  // =========================================================================

  const supplierInvoiceDetail = async (id: number): Promise<Json> => {
    const record = await ctx.api.get<Json>(`/supplierinvoices/${id}`);
    const [detail] = await withPartyNames(ctx, [documentDetail(record, STATUS.supplierInvoice, PAID)]);
    return detail!;
  };

  readTool(
    server,
    "dolibarr_supplier_invoice_search",
    {
      title: "Search supplier invoices",
      description: "Finds supplier invoices by ref or the supplier's invoice number. Newest first.",
      input: {
        query: z.string().max(100).optional(),
        thirdparty_id: supplierFilter,
        status: z.enum(["draft", "unpaid", "paid", "cancelled"]).optional(),
        ...paging,
      },
    },
    async ({ query, thirdparty_id, status, limit, page }) => {
      const result = await list(ctx, "/supplierinvoices", {
        sqlfilters: textFilter(query, ["t.ref", "t.ref_supplier"]),
        thirdparty_ids: thirdparty_id,
        status,
        limit,
        page,
        sortfield: "t.rowid",
        sortorder: "DESC",
      });
      const rows = result.rows.map((r) => documentRow(r, STATUS.supplierInvoice, PAID));
      return pageResult(result, await withPartyNames(ctx, rows), limit, page);
    },
  );

  readTool(
    server,
    "dolibarr_supplier_invoice_get",
    {
      title: "Get a supplier invoice",
      description: "One supplier invoice by id or ref, with its lines and the payments made.",
      input: { supplier_invoice: idOrRef },
    },
    async ({ supplier_invoice }) => {
      const record = await fetchOne(ctx, { path: "/supplierinvoices" }, supplier_invoice);
      const id = toInt(record.id)!;
      const payments = await optional(() => ctx.api.get<unknown>(`/supplierinvoices/${id}/payments`));
      return { ...(await supplierInvoiceDetail(id)), payments: compact(payments) };
    },
  );

  writeTool(
    server,
    ctx,
    "dolibarr_supplier_invoice_create",
    {
      title: "Create a supplier invoice",
      description:
        "Records a draft invoice received from a supplier, with its lines. Product lines without unit_price use the supplier's price for that product. " +
        "Validate it with dolibarr_supplier_invoice_action.",
      input: {
        thirdparty_id: z.number().int().positive().describe("Supplier id."),
        ref_supplier: z.string().min(1).max(255).describe("The supplier's invoice number (required, unique per supplier)."),
        date: dateInput.optional().describe("Invoice date; default today."),
        due_date: dateInput.optional(),
        label: z.string().max(255).optional(),
        ...noteInputs,
        custom_fields: customFieldsInput,
        lines: z.array(lineSchema).max(200).default([]),
      },
    },
    async (a) => {
      const reply = await ctx.api.post<unknown>(
        "/supplierinvoices",
        defined({
          socid: a.thirdparty_id,
          ref_supplier: a.ref_supplier,
          type: 0,
          date: toUnix(a.date) ?? today(),
          date_echeance: toUnix(a.due_date),
          label: a.label,
          note_public: a.note_public,
          note_private: a.note_private,
          array_options: toArrayOptions(a.custom_fields),
        }),
      );
      const id = createdId(reply, "/supplierinvoices");
      const problems = await addLines(ctx, `/supplierinvoices/${id}`, a.lines, "supplier", a.thirdparty_id);
      return {
        created: true,
        ...(await supplierInvoiceDetail(id)),
        ...(problems.length > 0 ? { lines_not_added: problems } : {}),
      };
    },
  );

  lineTool(server, ctx, {
    name: "dolibarr_supplier_invoice_line",
    noun: "supplier invoice",
    path: "/supplierinvoices",
    dialect: "supplier",
    detail: supplierInvoiceDetail,
  });

  statusTool(server, ctx, {
    name: "dolibarr_supplier_invoice_action",
    title: "Validate a supplier invoice, set it back to draft or delete it",
    noun: "supplier invoice",
    path: "/supplierinvoices",
    statusMap: STATUS.supplierInvoice,
    actions: {
      validate: { route: "validate", body: { idwarehouse: 0, notrigger: 0 }, effect: "the draft gets its final ref and becomes payable; this is an accounting document" },
      set_draft: { route: "settodraft", body: {}, effect: "an unpaid validated invoice goes back to draft" },
      delete: { method: "DELETE", effect: "deletes the supplier invoice permanently" },
    },
  });

  writeTool(
    server,
    ctx,
    "dolibarr_supplier_invoice_record_payment",
    {
      title: "Record a payment made on a supplier invoice",
      description:
        "Records in Dolibarr that a supplier invoice was paid. Without amount it books the whole amount still due; it moves no money.",
      guarded: true,
      input: {
        supplier_invoice_id: z.number().int().positive(),
        ...paymentInput,
        amount: z.number().positive().optional().describe("Amount paid; default the whole amount still due."),
      },
    },
    async (a) => {
      const paymentId = await ctx.api.post<unknown>(
        `/supplierinvoices/${a.supplier_invoice_id}/payments`,
        defined({
          datepaye: toUnix(a.date),
          payment_mode_id: a.payment_mode_id,
          closepaidinvoices: a.close_invoice ? "yes" : "no",
          accountid: a.bank_account_id,
          num_payment: a.payment_reference,
          comment: a.comment,
          amount: a.amount,
        }),
      );
      const record = await ctx.api.get<Json>(`/supplierinvoices/${a.supplier_invoice_id}`);
      return {
        done: "payment recorded",
        payment_id: toInt(paymentId),
        supplier_invoice: { ...(await summary(ctx, record, STATUS.supplierInvoice)), remaining: compact(record.remaintopay) },
      };
    },
    async (a) => {
      const record = await ctx.api.get<Json>(`/supplierinvoices/${a.supplier_invoice_id}`);
      return {
        effect: a.amount ? `books a payment of ${a.amount}` : "books a payment for the amount still due",
        supplier_invoice: await summary(ctx, record, STATUS.supplierInvoice),
        still_due: compact(record.remaintopay),
        payment: a,
      };
    },
  );
}
