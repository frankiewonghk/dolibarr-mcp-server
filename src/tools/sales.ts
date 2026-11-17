import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { shape, STATUS, statusCode, statusLabel, toInt } from "../dolibarr/shape.js";
import { createdId, statusTool } from "./actions.js";
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
import { addLines, lineSchema, lineTool } from "./lines.js";

const customerFilter = z
  .number()
  .int()
  .positive()
  .optional()
  .describe("Only records of this third party (id from dolibarr_thirdparty_search).");

const linesInput = z.array(lineSchema).max(200).default([]).describe("Lines to add to the new draft.");

/** A document with the third party's name filled in. */
async function detailOf(ctx: ToolContext, record: Json, statusMap: Record<string, string>, more: readonly string[] = []): Promise<Json> {
  const [detail] = await withPartyNames(ctx, [documentDetail(record, statusMap, more)]);
  return detail!;
}

const linesNote = (problems: string[], noun: string, lineTool: string): Json =>
  problems.length > 0
    ? {
        lines_not_added: problems,
        note: `The ${noun} exists as a draft, but some lines were refused. Fix them with ${lineTool} or delete the draft.`,
      }
    : {};

export function registerSalesTools(server: McpServer, ctx: ToolContext): void {
  // =========================================================================
  // Proposals (quotes)
  // =========================================================================

  const proposalDetail = async (id: number): Promise<Json> =>
    detailOf(ctx, await ctx.api.get<Json>(`/proposals/${id}`), STATUS.proposal, ["fin_validite"]);

  readTool(
    server,
    "dolibarr_proposal_search",
    {
      title: "Search commercial proposals",
      description: "Finds commercial proposals (quotes) by ref or the customer's reference. Newest first.",
      input: {
        query: z.string().max(100).optional().describe("Part of the proposal ref or customer reference."),
        thirdparty_id: customerFilter,
        status: z.enum(["draft", "validated", "signed", "not signed", "billed"]).optional(),
        ...paging,
      },
    },
    async ({ query, thirdparty_id, status, limit, page }) => {
      const result = await list(ctx, "/proposals", {
        sqlfilters: allOf(
          textFilter(query, ["t.ref", "t.ref_client"]),
          status ? equals("t.fk_statut", statusCode(STATUS.proposal, status)) : undefined,
        ),
        thirdparty_ids: thirdparty_id,
        limit,
        page,
        sortfield: "t.rowid",
        sortorder: "DESC",
      });
      const rows = result.rows.map((p) => documentRow(p, STATUS.proposal, ["fin_validite"]));
      return pageResult(result, await withPartyNames(ctx, rows), limit, page);
    },
  );

  readTool(
    server,
    "dolibarr_proposal_get",
    {
      title: "Get a commercial proposal",
      description: "One proposal by id or ref: head, custom fields and lines.",
      input: { proposal: idOrRef },
    },
    async ({ proposal }) => {
      const record = await fetchOne(ctx, { path: "/proposals", refPath: "/proposals/ref" }, proposal);
      return detailOf(ctx, record, STATUS.proposal, ["fin_validite"]);
    },
  );

  writeTool(
    server,
    ctx,
    "dolibarr_proposal_create",
    {
      title: "Create a commercial proposal",
      description:
        "Creates a draft proposal (quote) for a customer or prospect and adds its lines. A draft can be edited or deleted; validate it with dolibarr_proposal_action.",
      input: {
        thirdparty_id: z.number().int().positive(),
        date: dateInput.optional().describe("Proposal date; default today."),
        valid_days: z.number().int().min(1).max(365).optional().describe("Validity in days; default from Dolibarr's setup."),
        delivery_date: dateInput.optional(),
        ref_customer: z.string().max(255).optional().describe("The customer's own reference."),
        ...noteInputs,
        custom_fields: customFieldsInput,
        lines: linesInput,
      },
    },
    async (a) => {
      const reply = await ctx.api.post<unknown>(
        "/proposals",
        defined({
          socid: a.thirdparty_id,
          date: toUnix(a.date) ?? today(),
          duree_validite: a.valid_days,
          delivery_date: toUnix(a.delivery_date),
          ref_client: a.ref_customer,
          note_public: a.note_public,
          note_private: a.note_private,
          array_options: toArrayOptions(a.custom_fields),
        }),
      );
      const id = createdId(reply, "/proposals");
      const problems = await addLines(ctx, `/proposals/${id}`, a.lines, "customer", undefined, "line");
      return {
        created: true,
        ...(await proposalDetail(id)),
        ...linesNote(problems, "proposal", "dolibarr_proposal_line"),
      };
    },
  );

  writeTool(
    server,
    ctx,
    "dolibarr_proposal_update",
    {
      title: "Update a commercial proposal's head",
      description: "Changes head fields of a proposal (not its lines). Only the fields given are changed.",
      input: {
        proposal_id: z.number().int().positive(),
        delivery_date: dateInput.optional(),
        ref_customer: z.string().max(255).optional(),
        ...noteInputs,
        custom_fields: customFieldsInput,
      },
    },
    async (a) => {
      await ctx.api.put(
        `/proposals/${a.proposal_id}`,
        defined({
          delivery_date: toUnix(a.delivery_date),
          ref_client: a.ref_customer,
          note_public: a.note_public,
          note_private: a.note_private,
          array_options: toArrayOptions(a.custom_fields),
        }),
      );
      return { updated: true, ...(await proposalDetail(a.proposal_id)) };
    },
  );

  lineTool(server, ctx, {
    name: "dolibarr_proposal_line",
    noun: "proposal",
    path: "/proposals",
    dialect: "customer",
    addRoute: "line",
    detail: proposalDetail,
  });

  statusTool(server, ctx, {
    name: "dolibarr_proposal_action",
    title: "Validate, sign, refuse, bill, reopen or delete a proposal",
    noun: "proposal",
    path: "/proposals",
    statusMap: STATUS.proposal,
    extraInput: {
      note: z.string().max(2000).optional().describe("With sign or refuse: an internal note on the outcome."),
    },
    bodyFor: (action, args) =>
      action === "sign" || action === "refuse"
        ? defined({ status: action === "sign" ? 2 : 3, note_private: args.note as string | undefined, notrigger: 0 })
        : undefined,
    actions: {
      validate: { route: "validate", body: { notrigger: 0 }, effect: "the draft gets its final ref and can be sent to the customer" },
      set_draft: { route: "settodraft", body: {}, effect: "a validated proposal goes back to draft for editing" },
      sign: { route: "close", effect: "records that the customer accepted the proposal" },
      refuse: { route: "close", effect: "records that the customer declined the proposal" },
      set_billed: { route: "setinvoiced", body: {}, effect: "classifies a signed proposal as billed" },
      delete: { method: "DELETE", effect: "deletes the proposal permanently" },
    },
  });

  // =========================================================================
  // Sales orders
  // =========================================================================

  const orderDetail = async (id: number): Promise<Json> => {
    const record = await ctx.api.get<Json>(`/orders/${id}`);
    return { ...(await detailOf(ctx, record, STATUS.order)), billed: toInt(record.billed) === 1 };
  };

  readTool(
    server,
    "dolibarr_order_search",
    {
      title: "Search sales orders",
      description: "Finds customer orders by ref or the customer's reference. Newest first.",
      input: {
        query: z.string().max(100).optional().describe("Part of the order ref or customer reference."),
        thirdparty_id: customerFilter,
        status: z.enum(["draft", "validated", "in process", "delivered", "cancelled"]).optional(),
        ...paging,
      },
    },
    async ({ query, thirdparty_id, status, limit, page }) => {
      const result = await list(ctx, "/orders", {
        sqlfilters: allOf(
          textFilter(query, ["t.ref", "t.ref_client"]),
          status ? equals("t.fk_statut", statusCode(STATUS.order, status)) : undefined,
        ),
        thirdparty_ids: thirdparty_id,
        limit,
        page,
        sortfield: "t.rowid",
        sortorder: "DESC",
      });
      const rows = result.rows.map((order) => ({
        ...documentRow(order, STATUS.order),
        billed: toInt(order.billed) === 1,
      }));
      return pageResult(result, await withPartyNames(ctx, rows), limit, page);
    },
  );

  readTool(
    server,
    "dolibarr_order_get",
    {
      title: "Get a sales order",
      description: "One customer order by id or ref: head, custom fields, lines and its shipments.",
      input: { order: idOrRef },
    },
    async ({ order }) => {
      const record = await fetchOne(ctx, { path: "/orders", refPath: "/orders/ref" }, order);
      const shipments = await optional(() => ctx.api.get<Json[]>(`/orders/${toInt(record.id)}/shipment`));
      return {
        ...(await detailOf(ctx, record, STATUS.order)),
        billed: toInt(record.billed) === 1,
        shipments: Array.isArray(shipments)
          ? shipments.map((s) => ({
              ...shape(s, ["id", "ref", "date_delivery", "date_valid", "tracking_number"]),
              status: statusLabel(STATUS.shipment, s.status ?? s.statut),
            }))
          : undefined,
      };
    },
  );

  writeTool(
    server,
    ctx,
    "dolibarr_order_create",
    {
      title: "Create a sales order",
      description:
        "Creates a draft customer order and adds its lines. A draft can be edited or deleted; validate it with dolibarr_order_action. " +
        "To turn a signed proposal into an order use dolibarr_order_create_from_proposal instead.",
      input: {
        thirdparty_id: z.number().int().positive().describe("Customer id."),
        date: dateInput.optional().describe("Order date; default today."),
        delivery_date: dateInput.optional(),
        ref_customer: z.string().max(255).optional().describe("The customer's own reference (their PO number)."),
        ...noteInputs,
        custom_fields: customFieldsInput,
        lines: linesInput,
      },
    },
    async (a) => {
      const reply = await ctx.api.post<unknown>(
        "/orders",
        defined({
          socid: a.thirdparty_id,
          date: toUnix(a.date) ?? today(),
          delivery_date: toUnix(a.delivery_date),
          ref_client: a.ref_customer,
          note_public: a.note_public,
          note_private: a.note_private,
          array_options: toArrayOptions(a.custom_fields),
        }),
      );
      const id = createdId(reply, "/orders");
      const problems = await addLines(ctx, `/orders/${id}`, a.lines, "customer");
      return { created: true, ...(await orderDetail(id)), ...linesNote(problems, "order", "dolibarr_order_line") };
    },
  );

  writeTool(
    server,
    ctx,
    "dolibarr_order_create_from_proposal",
    {
      title: "Create a sales order from a proposal",
      description: "Creates a draft sales order with the customer and lines of a proposal, linked to it.",
      input: { proposal_id: z.number().int().positive() },
    },
    async ({ proposal_id }) => {
      const reply = await ctx.api.post<Json>(`/orders/createfromproposal/${proposal_id}`, {});
      return { created: true, ...(await orderDetail(createdId(reply, "/orders/createfromproposal"))), proposal_id };
    },
  );

  writeTool(
    server,
    ctx,
    "dolibarr_order_update",
    {
      title: "Update a sales order's head",
      description: "Changes head fields of a sales order (not its lines). Only the fields given are changed.",
      input: {
        order_id: z.number().int().positive(),
        delivery_date: dateInput.optional(),
        ref_customer: z.string().max(255).optional(),
        ...noteInputs,
        custom_fields: customFieldsInput,
      },
    },
    async (a) => {
      await ctx.api.put(
        `/orders/${a.order_id}`,
        defined({
          delivery_date: toUnix(a.delivery_date),
          ref_client: a.ref_customer,
          note_public: a.note_public,
          note_private: a.note_private,
          array_options: toArrayOptions(a.custom_fields),
        }),
      );
      return { updated: true, ...(await orderDetail(a.order_id)) };
    },
  );

  lineTool(server, ctx, {
    name: "dolibarr_order_line",
    noun: "order",
    path: "/orders",
    dialect: "customer",
    detail: orderDetail,
  });

  statusTool(server, ctx, {
    name: "dolibarr_order_action",
    title: "Validate, close, reopen or delete a sales order",
    noun: "order",
    path: "/orders",
    statusMap: STATUS.order,
    actions: {
      validate: { route: "validate", body: { idwarehouse: 0, notrigger: 0 }, effect: "the draft gets its final ref and is open for shipping and invoicing" },
      set_draft: { route: "settodraft", body: { idwarehouse: -1 }, effect: "a validated order goes back to draft" },
      close: { route: "close", body: { notrigger: 0 }, effect: "classifies the order as delivered" },
      reopen: { route: "reopen", body: {}, effect: "a delivered or cancelled order becomes validated again" },
      set_billed: { route: "setinvoiced", body: {}, effect: "classifies the order as billed" },
      delete: { method: "DELETE", effect: "deletes the order permanently" },
    },
  });

  // =========================================================================
  // Shipments
  // =========================================================================

  readTool(
    server,
    "dolibarr_shipment_search",
    {
      title: "Search shipments",
      description: "Finds shipments by ref or the customer's reference. Newest first.",
      input: {
        query: z.string().max(100).optional().describe("Part of the shipment ref or customer reference."),
        thirdparty_id: customerFilter,
        status: z.enum(["draft", "validated", "closed", "cancelled"]).optional(),
        ...paging,
      },
    },
    async ({ query, thirdparty_id, status, limit, page }) => {
      const result = await list(ctx, "/shipments", {
        sqlfilters: allOf(
          textFilter(query, ["t.ref", "t.ref_customer"]),
          status ? equals("t.fk_statut", statusCode(STATUS.shipment, status)) : undefined,
        ),
        thirdparty_ids: thirdparty_id,
        limit,
        page,
        sortfield: "t.rowid",
        sortorder: "DESC",
      });
      const rows = result.rows.map((s) => ({
        ...documentRow(s, STATUS.shipment),
        order_id: s.origin_type === "commande" ? toInt(s.origin_id) : undefined,
      }));
      return pageResult(result, await withPartyNames(ctx, rows), limit, page);
    },
  );

  readTool(
    server,
    "dolibarr_shipment_get",
    {
      title: "Get a shipment",
      description: "One shipment by id or ref, with its lines and the lots shipped on each line.",
      input: { shipment: idOrRef },
    },
    async ({ shipment }) => {
      const record = await fetchOne(ctx, { path: "/shipments" }, shipment);
      return {
        ...(await detailOf(ctx, record, STATUS.shipment)),
        order_id: record.origin_type === "commande" ? toInt(record.origin_id) : undefined,
      };
    },
  );

  writeTool(
    server,
    ctx,
    "dolibarr_shipment_create",
    {
      title: "Create a shipment",
      description:
        "Creates a draft shipment for a validated sales order. Read the order with dolibarr_order_get for its line ids and quantities, " +
        "and dolibarr_product_stock for where the goods are. Each line ships from one warehouse. " +
        "Products tracked by lot or serial number cannot be shipped through the standard API; ship those in the Dolibarr web interface. " +
        "A draft moves no stock; validate it with dolibarr_shipment_action.",
      input: {
        order_id: z.number().int().positive(),
        date_delivery: dateInput.optional().describe("Planned delivery date."),
        tracking_number: z.string().max(100).optional(),
        ...noteInputs,
        lines: z
          .array(
            z.object({
              order_line_id: z.number().int().positive(),
              qty: z.number().positive(),
              warehouse_id: z.number().int().positive().describe("Warehouse the goods leave from."),
            }),
          )
          .min(1)
          .max(200),
      },
    },
    async (a) => {
      const order = await ctx.api.get<Json>(`/orders/${a.order_id}`);
      const reply = await ctx.api.post<unknown>(
        "/shipments",
        defined({
          socid: toInt(order.socid),
          origin_id: a.order_id,
          origin_type: "commande",
          date_delivery: toUnix(a.date_delivery),
          tracking_number: a.tracking_number,
          note_public: a.note_public,
          note_private: a.note_private,
          lines: a.lines.map((line, index) => ({
            origin_type: "commande",
            origin_id: a.order_id,
            origin_line_id: line.order_line_id,
            qty: line.qty,
            entrepot_id: line.warehouse_id,
            rang: index + 1,
          })),
        }),
      );
      const id = createdId(reply, "/shipments");
      const record = await ctx.api.get<Json>(`/shipments/${id}`);
      return { created: true, ...(await detailOf(ctx, record, STATUS.shipment)), order_id: a.order_id };
    },
  );

  statusTool(server, ctx, {
    name: "dolibarr_shipment_action",
    title: "Validate, close or delete a shipment",
    noun: "shipment",
    path: "/shipments",
    statusMap: STATUS.shipment,
    actions: {
      validate: {
        route: "validate",
        body: { notrigger: 0 },
        effect: "the draft gets its final ref; depending on the stock setup this takes the goods out of stock",
      },
      close: { route: "close", body: { notrigger: 0 }, effect: "classifies the shipment as delivered" },
      delete: { method: "DELETE", effect: "deletes the shipment permanently" },
    },
  });
}
