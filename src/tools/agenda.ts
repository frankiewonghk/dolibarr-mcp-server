import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DolibarrApiError } from "../dolibarr/client.js";
import { extraFields, isoDate, shape, toInt } from "../dolibarr/shape.js";
import { createdId } from "./actions.js";
import type { ToolContext } from "./context.js";
import { withPartyNames } from "./documents.js";
import {
  allOf,
  customFieldsInput,
  defined,
  equals,
  list,
  pageResult,
  paging,
  readTool,
  textFilter,
  toArrayOptions,
  writeTool,
  type Json,
} from "./helpers.js";

const EVENT_FIELDS = ["id", "ref", "label", "type_code", "location", "percentage", "fulldayevent", "userownerid", "fk_project", "contact_id"] as const;

const dateTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/)
  .describe("YYYY-MM-DD or YYYY-MM-DD HH:MM (UTC).");

/** "YYYY-MM-DD[ HH:MM[:SS]]" (UTC) to unix seconds. */
function toUnixDateTime(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const [day, time = "00:00"] = value.split(/[ T]/);
  const ms = Date.parse(`${day}T${time.length === 5 ? `${time}:00` : time}Z`);
  if (Number.isNaN(ms)) throw new DolibarrApiError(400, `"${value}" is not a date`, "POST", "/agendaevents");
  return ms / 1000;
}

function eventRow(record: Json): Json {
  const party = toInt(record.socid ?? record.fk_soc);
  return {
    ...shape(record, EVENT_FIELDS),
    start: isoDate(record.datep) ?? undefined,
    end: isoDate(record.datef) ?? undefined,
    done: toInt(record.percentage) === 100,
    ...(party && party > 0 ? { thirdparty_id: party } : {}),
  };
}

export function registerAgendaTools(server: McpServer, ctx: ToolContext): void {
  readTool(
    server,
    "dolibarr_event_search",
    {
      title: "Search agenda events",
      description:
        "Finds agenda events (meetings, calls, tasks to do, and events Dolibarr logs automatically) by label, third party, owner or date range. Newest first.",
      input: {
        query: z.string().max(100).optional().describe("Part of the label or location."),
        thirdparty_id: z.number().int().positive().optional(),
        user_id: z.number().int().positive().optional().describe("Only events owned by this user."),
        from: dateTime.optional().describe("Only events starting on or after this date."),
        to: dateTime.optional().describe("Only events starting before this date."),
        type_code: z.string().max(50).optional().describe("e.g. AC_RDV (meeting), AC_TEL (call), AC_OTH (other). See dolibarr_dictionary event_types."),
        ...paging,
      },
    },
    async ({ query, thirdparty_id, user_id, from, to, type_code, limit, page }) => {
      const fromTs = toUnixDateTime(from);
      const toTs = toUnixDateTime(to);
      const result = await list(ctx, "/agendaevents", {
        user_ids: user_id,
        sqlfilters: allOf(
          textFilter(query, ["t.label", "t.location"]),
          equals("t.fk_soc", thirdparty_id),
          equals("t.code", type_code),
          fromTs !== undefined ? `(t.datep:>=:'${new Date(fromTs * 1000).toISOString().slice(0, 19).replace("T", " ")}')` : undefined,
          toTs !== undefined ? `(t.datep:<:'${new Date(toTs * 1000).toISOString().slice(0, 19).replace("T", " ")}')` : undefined,
        ),
        limit,
        page,
        sortfield: "t.datep",
        sortorder: "DESC",
      });
      return pageResult(result, await withPartyNames(ctx, result.rows.map(eventRow)), limit, page);
    },
  );

  readTool(
    server,
    "dolibarr_event_get",
    {
      title: "Get an agenda event",
      description: "One agenda event by id, with its note and the records it is linked to.",
      input: { event_id: z.number().int().positive() },
    },
    async ({ event_id }) => {
      const record = await ctx.api.get<Json>(`/agendaevents/${event_id}`);
      const [row] = await withPartyNames(ctx, [eventRow(record)]);
      return {
        ...row,
        note: record.note_private || record.note || undefined,
        linked_record: record.elementtype ? { type: record.elementtype, id: toInt(record.fk_element) } : undefined,
        custom_fields: extraFields(record),
      };
    },
  );

  const eventFields = {
    label: z.string().min(1).max(255),
    type_code: z.string().max(50).default("AC_OTH").describe("AC_RDV meeting, AC_TEL call, AC_EMAIL email, AC_OTH other; see dolibarr_dictionary event_types."),
    start: dateTime,
    end: dateTime.optional(),
    full_day: z.boolean().default(false),
    location: z.string().max(255).optional(),
    thirdparty_id: z.number().int().positive().optional(),
    contact_id: z.number().int().positive().optional(),
    project_id: z.number().int().positive().optional(),
    owner_user_id: z.number().int().positive().optional().describe("Default: the connected user."),
    done: z.boolean().optional().describe("true = done (100%), false = to do (0%). Leave out for a plain appointment."),
    note: z.string().max(10_000).optional(),
    custom_fields: customFieldsInput,
  };

  const eventBody = (a: Partial<z.infer<z.ZodObject<typeof eventFields>>>, ownerId?: number): Json =>
    defined({
      label: a.label,
      type_code: a.type_code,
      datep: toUnixDateTime(a.start),
      datef: toUnixDateTime(a.end),
      fulldayevent: a.full_day === undefined ? undefined : a.full_day ? 1 : 0,
      location: a.location,
      socid: a.thirdparty_id,
      contact_id: a.contact_id,
      fk_project: a.project_id,
      userownerid: a.owner_user_id ?? ownerId,
      percentage: a.done === undefined ? undefined : a.done ? 100 : 0,
      note_private: a.note,
      array_options: toArrayOptions(a.custom_fields),
    });

  writeTool(
    server,
    ctx,
    "dolibarr_event_create",
    {
      title: "Create an agenda event",
      description: "Adds an event to the agenda: a meeting, a call, or a task to do, optionally linked to a third party, contact or project.",
      input: eventFields,
    },
    async (a) => {
      let owner = a.owner_user_id;
      if (!owner) {
        const me = await ctx.api.get<Json>("/users/info").catch(() => null);
        owner = toInt(me?.id) ?? undefined;
        if (!owner) {
          throw new DolibarrApiError(400, "Give owner_user_id: this user may not read their own user record", "POST", "/agendaevents");
        }
      }
      const id = createdId(await ctx.api.post<unknown>("/agendaevents", eventBody(a, owner)), "/agendaevents");
      return { created: true, ...eventRow(await ctx.api.get<Json>(`/agendaevents/${id}`)) };
    },
  );

  writeTool(
    server,
    ctx,
    "dolibarr_event_update",
    {
      title: "Update an agenda event",
      description: "Changes an agenda event, e.g. its time, or marks it done. Only the fields given are changed.",
      input: {
        event_id: z.number().int().positive(),
        ...eventFields,
        label: eventFields.label.optional(),
        type_code: z.string().max(50).optional(),
        start: dateTime.optional(),
        full_day: z.boolean().optional(),
      },
    },
    async ({ event_id, ...a }) => {
      // Dolibarr's update needs the owner and type, which it does not keep from the stored record.
      const current = await ctx.api.get<Json>(`/agendaevents/${event_id}`);
      await ctx.api.put(`/agendaevents/${event_id}`, {
        userownerid: toInt(current.userownerid),
        type_code: current.type_code,
        ...eventBody(a),
      });
      return { updated: true, ...eventRow(await ctx.api.get<Json>(`/agendaevents/${event_id}`)) };
    },
  );
}
