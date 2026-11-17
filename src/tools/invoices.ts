import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { compact, STATUS, toInt } from "../dolibarr/shape.js";
import { createdId, messagesOf, statusTool, summary } from "./actions.js";
import type { ToolContext } from "./context.js";
import { documentDetail, documentRow, withPartyNames } from "./documents.js";
import {
  customFieldsInput,
  dateInput,
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
  today,
  toUnix,
  writeTool,
  type Json,
} from "./helpers.js";
import { addLines, lineSchema, lineTool } from "./lines.js";

const PAID = ["totalpaid", "remaintopay", "paye"] as const;

/** Inputs of a payment, shared by customer and supplier invoices. */
export const paymentInput = {
  date: dateInput.describe("Date of the payment (YYYY-MM-DD)."),
  payment_mode_id: z
    .number()
    .int()
    .positive()
    .describe("Payment type id, from dolibarr_dictionary payment_types."),
  bank_account_id: z
    .number()
    .int()
    .positive()
    .describe("Bank account id, from dolibarr_api_get /bankaccounts. Needed when the Bank module is enabled."),
  close_invoice: z.boolean().default(true).describe("Mark the invoice as paid when the payment covers it."),
  payment_reference: z.string().max(50).optional().describe("Cheque or transfer number."),
  comment: z.string().max(500).optional(),
};

export function registerInvoiceTools(server: McpServer, ctx: ToolContext): void {
  const invoiceDetail = async (id: number): Promise<Json> => {
    const record = await ctx.api.get<Json>(`/invoices/${id}`);
    const [detail] = await withPartyNames(ctx, [documentDetail(record, STATUS.invoice, PAID)]);
    return detail!;
  };

  readTool(
    server,
    "dolibarr_invoice_search",
    {
      title: "Search customer invoices",
      description: "Finds customer invoices by ref or the customer's reference. Newest first. Rows show totals and what is still to pay.",
      input: {
        query: z.string().max(100).optional().describe("Part of the invoice ref or customer reference."),
        thirdparty_id: z.number().int().positive().optional(),
        status: z.enum(["draft", "unpaid", "paid", "cancelled"]).optional(),
        ...paging,
      },
    },
    async ({ query, thirdparty_id, status, limit, page }) => {
      const result = await list(ctx, "/invoices", {
        sqlfilters: textFilter(query, ["t.ref", "t.ref_client"]),
        thirdparty_ids: thirdparty_id,
        status,
        limit,
        page,
        sortfield: "t.rowid",
        sortorder: "DESC",
      });
      const rows = result.rows.map((invoice) => documentRow(invoice, STATUS.invoice, PAID));
      return pageResult(result, await withPartyNames(ctx, rows), limit, page);
    },
  );

  readTool(
    server,
    "dolibarr_invoice_get",
    {
      title: "Get a customer invoice",
      description: "One customer invoice by id or ref, with its lines and the payments received.",
      input: { invoice: idOrRef },
    },
    async ({ invoice }) => {
      const record = await fetchOne(ctx, { path: "/invoices", refPath: "/invoices/ref" }, invoice);
      const payments = await optional(() => ctx.api.get<unknown>(`/invoices/${toInt(record.id)}/payments`));
      const [detail] = await withPartyNames(ctx, [documentDetail(record, STATUS.invoice, PAID)]);
      return { ...detail, payments: compact(payments) };
    },
  );

  writeTool(
    server,
    ctx,
    "dolibarr_invoice_create",
    {
      title: "Create a customer invoice",
      description:
        "Creates a draft customer invoice and adds its lines. A draft has no accounting effect; validate it with dolibarr_invoice_action. " +
        "To bill a sales order use dolibarr_invoice_create_from_order instead.",
      input: {
        thirdparty_id: z.number().int().positive(),
        date: dateInput.optional().describe("Invoice date; default today."),
        ref_customer: z.string().max(255).optional(),
        payment_terms_id: z.number().int().positive().optional().describe("From dolibarr_dictionary payment_terms."),
        payment_mode_id: z.number().int().positive().optional().describe("From dolibarr_dictionary payment_types."),
        ...noteInputs,
        custom_fields: customFieldsInput,
        lines: z.array(lineSchema).max(200).default([]),
      },
    },
    async (a) => {
      const reply = await ctx.api.post<unknown>(
        "/invoices",
        defined({
          socid: a.thirdparty_id,
          type: 0,
          date: toUnix(a.date) ?? today(),
          ref_client: a.ref_customer,
          cond_reglement_id: a.payment_terms_id,
          mode_reglement_id: a.payment_mode_id,
          note_public: a.note_public,
          note_private: a.note_private,
          array_options: toArrayOptions(a.custom_fields),
        }),
      );
      const id = createdId(reply, "/invoices");
      const problems = await addLines(ctx, `/invoices/${id}`, a.lines, "customer");
      return {
        created: true,
        ...(await invoiceDetail(id)),
        ...(problems.length > 0 ? { lines_not_added: problems } : {}),
      };
    },
  );

  writeTool(
    server,
    ctx,
    "dolibarr_invoice_create_from_order",
    {
      title: "Create an invoice from a sales order",
      description: "Creates a draft customer invoice with the customer and lines of a sales order, linked to it.",
      input: { order_id: z.number().int().positive() },
    },
    async ({ order_id }) => {
      const reply = await ctx.api.post<Json>(`/invoices/createfromorder/${order_id}`, {});
      return { created: true, ...(await invoiceDetail(createdId(reply, "/invoices/createfromorder"))), order_id };
    },
  );

  writeTool(
    server,
    ctx,
    "dolibarr_invoice_update",
    {
      title: "Update a customer invoice's head",
      description: "Changes head fields of a draft invoice (not its lines). Only the fields given are changed.",
      input: {
        invoice_id: z.number().int().positive(),
        date: dateInput.optional(),
        ref_customer: z.string().max(255).optional(),
        payment_terms_id: z.number().int().positive().optional(),
        payment_mode_id: z.number().int().positive().optional(),
        ...noteInputs,
        custom_fields: customFieldsInput,
      },
    },
    async (a) => {
      await ctx.api.put(
        `/invoices/${a.invoice_id}`,
        defined({
          date: toUnix(a.date),
          ref_client: a.ref_customer,
          cond_reglement_id: a.payment_terms_id,
          mode_reglement_id: a.payment_mode_id,
          note_public: a.note_public,
          note_private: a.note_private,
          array_options: toArrayOptions(a.custom_fields),
        }),
      );
      return { updated: true, ...(await invoiceDetail(a.invoice_id)) };
    },
  );

  lineTool(server, ctx, {
    name: "dolibarr_invoice_line",
    noun: "invoice",
    path: "/invoices",
    dialect: "customer",
    detail: invoiceDetail,
  });

  statusTool(server, ctx, {
    name: "dolibarr_invoice_action",
    title: "Validate a customer invoice, set it back to draft, mark it paid or delete it",
    noun: "invoice",
    path: "/invoices",
    statusMap: STATUS.invoice,
    extraInput: {
      close_code: z
        .enum(["discount_vat", "badcustomer", "abandon", "other"])
        .optional()
        .describe("With set_paid on an invoice not fully paid: why the rest is written off."),
      close_note: z.string().max(500).optional().describe("With set_paid: a note on the write-off."),
    },
    bodyFor: (action, args) =>
      action === "set_paid"
        ? defined({ close_code: args.close_code as string | undefined, close_note: args.close_note as string | undefined })
        : undefined,
    actions: {
      validate: {
        route: "validate",
        body: { idwarehouse: 0, notrigger: 0 },
        effect: "the draft gets its final invoice number and becomes payable; this is an accounting document",
      },
      set_draft: { route: "settodraft", body: { idwarehouse: -1 }, effect: "an unpaid validated invoice goes back to draft" },
      set_paid: { route: "settopaid", effect: "classifies the invoice as paid, writing off any remainder with the close_code" },
      set_unpaid: { route: "settounpaid", body: {}, effect: "a paid invoice becomes unpaid again" },
      delete: { method: "DELETE", effect: "deletes the invoice (drafts only, or the last invoice of the numbering)" },
    },
  });

  writeTool(
    server,
    ctx,
    "dolibarr_invoice_record_payment",
    {
      title: "Record a payment received on a customer invoice",
      description:
        "Records in Dolibarr that the customer paid an invoice. It books the whole amount still due; it moves no money.",
      guarded: true,
      input: { invoice_id: z.number().int().positive(), ...paymentInput },
    },
    async (a) => {
      const paymentId = await ctx.api.post<unknown>(
        `/invoices/${a.invoice_id}/payments`,
        defined({
          datepaye: toUnix(a.date),
          paymentid: a.payment_mode_id,
          closepaidinvoices: a.close_invoice ? "yes" : "no",
          accountid: a.bank_account_id,
          num_payment: a.payment_reference,
          comment: a.comment,
        }),
      );
      const record = await ctx.api.get<Json>(`/invoices/${a.invoice_id}`);
      return {
        done: "payment recorded",
        payment_id: toInt(paymentId),
        invoice: { ...(await summary(ctx, record, STATUS.invoice)), remaining: compact(record.remaintopay) },
        messages: messagesOf(paymentId),
      };
    },
    async (a) => {
      const record = await ctx.api.get<Json>(`/invoices/${a.invoice_id}`);
      return {
        effect: "books a payment for the amount still due on this invoice",
        invoice: await summary(ctx, record, STATUS.invoice),
        already_paid: compact(record.totalpaid),
        still_due: compact(record.remaintopay),
        payment: a,
      };
    },
  );
}
