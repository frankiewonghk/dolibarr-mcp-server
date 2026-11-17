import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { compact, extraFields, isoDate, shape, STATUS, statusCode, statusLabel, toInt } from "../dolibarr/shape.js";
import { createdId } from "./actions.js";
import type { ToolContext } from "./context.js";
import { withPartyNames } from "./documents.js";
import {
  allOf,
  customFieldsInput,
  defined,
  equals,
  fetchOne,
  idOrRef,
  list,
  pageResult,
  paging,
  readTool,
  textFilter,
  toArrayOptions,
  writeTool,
  type Json,
} from "./helpers.js";

const TICKET_FIELDS = [
  "id",
  "ref",
  "track_id",
  "subject",
  "type_code",
  "category_code",
  "severity_code",
  "origin_email",
  "fk_user_assign",
  "progress",
  "datec",
  "date_read",
  "date_close",
] as const;

function ticketRow(record: Json): Json {
  const party = toInt(record.fk_soc ?? record.socid);
  return {
    ...shape(record, TICKET_FIELDS),
    status: statusLabel(STATUS.ticket, record.fk_statut ?? record.status),
    ...(party && party > 0 ? { thirdparty_id: party } : {}),
  };
}

export function registerTicketTools(server: McpServer, ctx: ToolContext): void {
  const ticketDetail = async (record: Json): Promise<Json> => {
    const [row] = await withPartyNames(ctx, [ticketRow(record)]);
    const messages = Array.isArray(record.messages) ? (record.messages as Json[]) : [];
    return {
      ...row,
      message: compact(record.message),
      project_id: toInt(record.fk_project) || undefined,
      contact_id: toInt(record.fk_contact) || undefined,
      custom_fields: extraFields(record),
      messages: messages.map((m) =>
        compact({
          date: isoDate(m.datec) ?? m.datec,
          from: m.fk_user_author ? `user ${String(m.fk_user_author)}` : undefined,
          message: m.message,
        }),
      ),
    };
  };

  readTool(
    server,
    "dolibarr_ticket_search",
    {
      title: "Search tickets",
      description: "Finds helpdesk tickets by ref, subject or track id, optionally for one third party. Newest first.",
      input: {
        query: z.string().max(100).optional(),
        thirdparty_id: z.number().int().positive().optional(),
        status: z.enum(Object.values(STATUS.ticket) as [string, ...string[]]).optional(),
        ...paging,
      },
    },
    async ({ query, thirdparty_id, status, limit, page }) => {
      const result = await list(ctx, "/tickets", {
        socid: thirdparty_id,
        sqlfilters: allOf(
          textFilter(query, ["t.ref", "t.subject", "t.track_id"]),
          status ? equals("t.fk_statut", statusCode(STATUS.ticket, status)) : undefined,
        ),
        limit,
        page,
        sortfield: "t.rowid",
        sortorder: "DESC",
      });
      return pageResult(result, await withPartyNames(ctx, result.rows.map(ticketRow)), limit, page);
    },
  );

  readTool(
    server,
    "dolibarr_ticket_get",
    {
      title: "Get a ticket",
      description: "One ticket by id or ref, with its original message and the messages that followed.",
      input: { ticket: idOrRef },
    },
    async ({ ticket }) => ticketDetail(await fetchOne(ctx, { path: "/tickets", refPath: "/tickets/ref" }, ticket)),
  );

  writeTool(
    server,
    ctx,
    "dolibarr_ticket_create",
    {
      title: "Create a ticket",
      description:
        "Opens a helpdesk ticket. Type, category and severity codes come from dolibarr_dictionary (ticket_types, ticket_categories, ticket_severities).",
      input: {
        subject: z.string().min(1).max(255),
        message: z.string().min(1).max(50_000),
        thirdparty_id: z.number().int().positive().optional(),
        contact_id: z.number().int().positive().optional(),
        project_id: z.number().int().positive().optional(),
        type_code: z.string().max(32).optional(),
        category_code: z.string().max(32).optional(),
        severity_code: z.string().max(32).optional(),
        assign_to_user_id: z.number().int().positive().optional(),
        origin_email: z.email().optional().describe("Email address of the requester."),
        custom_fields: customFieldsInput,
      },
    },
    async (a) => {
      const id = createdId(
        await ctx.api.post<unknown>(
          "/tickets",
          defined({
            subject: a.subject,
            message: a.message,
            fk_soc: a.thirdparty_id,
            fk_contact: a.contact_id,
            fk_project: a.project_id,
            type_code: a.type_code,
            category_code: a.category_code,
            severity_code: a.severity_code,
            fk_user_assign: a.assign_to_user_id,
            origin_email: a.origin_email,
            array_options: toArrayOptions(a.custom_fields),
          }),
        ),
        "/tickets",
      );
      return { created: true, ...(await ticketDetail(await ctx.api.get<Json>(`/tickets/${id}`))) };
    },
  );

  writeTool(
    server,
    ctx,
    "dolibarr_ticket_update",
    {
      title: "Update a ticket",
      description:
        "Changes a ticket: its status, assignee, progress, type, category or severity. Only the fields given are changed.",
      input: {
        ticket_id: z.number().int().positive(),
        status: z.enum(Object.values(STATUS.ticket) as [string, ...string[]]).optional(),
        assign_to_user_id: z.number().int().positive().optional(),
        progress: z.number().int().min(0).max(100).optional(),
        type_code: z.string().max(32).optional(),
        category_code: z.string().max(32).optional(),
        severity_code: z.string().max(32).optional(),
        custom_fields: customFieldsInput,
      },
    },
    async (a) => {
      await ctx.api.put(
        `/tickets/${a.ticket_id}`,
        defined({
          fk_statut: a.status ? statusCode(STATUS.ticket, a.status) : undefined,
          status: a.status ? statusCode(STATUS.ticket, a.status) : undefined,
          fk_user_assign: a.assign_to_user_id,
          progress: a.progress,
          type_code: a.type_code,
          category_code: a.category_code,
          severity_code: a.severity_code,
          array_options: toArrayOptions(a.custom_fields),
        }),
      );
      return { updated: true, ...(await ticketDetail(await ctx.api.get<Json>(`/tickets/${a.ticket_id}`))) };
    },
  );

  writeTool(
    server,
    ctx,
    "dolibarr_ticket_add_message",
    {
      title: "Add a message to a ticket",
      description: "Adds a message to a ticket's thread. It is recorded in Dolibarr; it is not emailed by this tool.",
      input: {
        ticket_id: z.number().int().positive(),
        message: z.string().min(1).max(50_000),
      },
    },
    async (a) => {
      const ticket = await ctx.api.get<Json>(`/tickets/${a.ticket_id}`);
      await ctx.api.post("/tickets/newmessage", { track_id: ticket.track_id, message: a.message });
      return { done: "message added", ...(await ticketDetail(await ctx.api.get<Json>(`/tickets/${a.ticket_id}`))) };
    },
  );
}
