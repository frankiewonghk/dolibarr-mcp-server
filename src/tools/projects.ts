import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { compact, extraFields, shape, STATUS, statusCode, statusLabel, toInt } from "../dolibarr/shape.js";
import { createdId, statusTool } from "./actions.js";
import type { ToolContext } from "./context.js";
import { withPartyNames } from "./documents.js";
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
  toUnix,
  writeTool,
  type Json,
} from "./helpers.js";

const PROJECT_FIELDS = [
  "id",
  "ref",
  "title",
  "description",
  "date_start",
  "date_end",
  "budget_amount",
  "opp_amount",
  "opp_percent",
  "public",
  "date_creation",
] as const;

const TASK_FIELDS = [
  "id",
  "ref",
  "label",
  "description",
  "fk_project",
  "fk_task_parent",
  "date_start",
  "date_end",
  "planned_workload",
  "duration_effective",
  "progress",
  "budget_amount",
] as const;

/** Durations in Dolibarr are seconds; show hours as well. */
function withHours(task: Json): Json {
  const out = { ...task };
  for (const key of ["planned_workload", "duration_effective"]) {
    const seconds = Number(out[key]);
    if (Number.isFinite(seconds) && seconds > 0) out[`${key}_hours`] = Math.round((seconds / 3600) * 100) / 100;
  }
  return out;
}

function projectRow(record: Json): Json {
  const party = toInt(record.socid ?? record.fk_soc);
  return {
    ...shape(record, PROJECT_FIELDS),
    status: statusLabel(STATUS.project, record.status ?? record.statut),
    ...(party && party > 0 ? { thirdparty_id: party } : {}),
  };
}

export function registerProjectTools(server: McpServer, ctx: ToolContext): void {
  const projectDetail = async (id: number): Promise<Json> => {
    const [record, tasks] = await Promise.all([
      ctx.api.get<Json>(`/projects/${id}`),
      optional(() => ctx.api.get<Json[]>(`/projects/${id}/tasks`)),
    ]);
    const [row] = await withPartyNames(ctx, [projectRow(record)]);
    return {
      ...row,
      note_public: record.note_public || undefined,
      note_private: record.note_private || undefined,
      custom_fields: extraFields(record),
      tasks: Array.isArray(tasks) ? tasks.map((t) => withHours(shape(t, TASK_FIELDS))) : undefined,
    };
  };

  readTool(
    server,
    "dolibarr_project_search",
    {
      title: "Search projects",
      description: "Finds projects by ref or title, optionally for one third party. Newest first.",
      input: {
        query: z.string().max(100).optional(),
        thirdparty_id: z.number().int().positive().optional(),
        status: z.enum(["draft", "open", "closed"]).optional(),
        ...paging,
      },
    },
    async ({ query, thirdparty_id, status, limit, page }) => {
      const result = await list(ctx, "/projects", {
        sqlfilters: allOf(
          textFilter(query, ["t.ref", "t.title"]),
          status ? equals("t.fk_statut", statusCode(STATUS.project, status)) : undefined,
        ),
        thirdparty_ids: thirdparty_id,
        limit,
        page,
        sortfield: "t.rowid",
        sortorder: "DESC",
      });
      return pageResult(result, await withPartyNames(ctx, result.rows.map(projectRow)), limit, page);
    },
  );

  readTool(
    server,
    "dolibarr_project_get",
    {
      title: "Get a project",
      description: "One project by id or ref, with its tasks (planned and spent time in hours).",
      input: { project: idOrRef },
    },
    async ({ project }) => {
      const record = await fetchOne(ctx, { path: "/projects", refPath: "/projects/ref" }, project);
      return projectDetail(toInt(record.id)!);
    },
  );

  const projectFields = {
    title: z.string().min(1).max(255),
    thirdparty_id: z.number().int().positive().optional(),
    description: z.string().max(10_000).optional(),
    date_start: dateInput.optional(),
    date_end: dateInput.optional(),
    budget_amount: z.number().min(0).optional(),
    public: z.boolean().optional().describe("true = visible to every user; false = only to project contacts."),
    ...noteInputs,
    custom_fields: customFieldsInput,
  };

  const projectBody = (a: Partial<z.infer<z.ZodObject<typeof projectFields>>>): Json =>
    defined({
      title: a.title,
      socid: a.thirdparty_id,
      description: a.description,
      date_start: toUnix(a.date_start),
      date_end: toUnix(a.date_end),
      budget_amount: a.budget_amount,
      public: a.public === undefined ? undefined : a.public ? 1 : 0,
      note_public: a.note_public,
      note_private: a.note_private,
      array_options: toArrayOptions(a.custom_fields),
    });

  writeTool(
    server,
    ctx,
    "dolibarr_project_create",
    {
      title: "Create a project",
      description: "Creates a draft project; its ref comes from Dolibarr's numbering rule unless given. Open it with dolibarr_project_action validate.",
      input: { ref: z.string().max(50).optional().describe("Leave out for an automatic ref."), ...projectFields },
    },
    async ({ ref, ...a }) => {
      const id = createdId(await ctx.api.post<unknown>("/projects", { ref: ref ?? "auto", ...projectBody(a) }), "/projects");
      return { created: true, ...(await projectDetail(id)) };
    },
  );

  writeTool(
    server,
    ctx,
    "dolibarr_project_update",
    {
      title: "Update a project",
      description: "Changes fields of a project. Only the fields given are changed.",
      input: { project_id: z.number().int().positive(), ...projectFields, title: projectFields.title.optional() },
    },
    async ({ project_id, ...a }) => {
      await ctx.api.put(`/projects/${project_id}`, projectBody(a));
      return { updated: true, ...(await projectDetail(project_id)) };
    },
  );

  statusTool(server, ctx, {
    name: "dolibarr_project_action",
    title: "Validate or delete a project",
    noun: "project",
    path: "/projects",
    statusMap: STATUS.project,
    actions: {
      validate: { route: "validate", body: { notrigger: 0 }, effect: "the draft project becomes open" },
      delete: { method: "DELETE", effect: "deletes the project and its tasks permanently" },
    },
  });

  // --- Tasks -----------------------------------------------------------------

  readTool(
    server,
    "dolibarr_task_get",
    {
      title: "Get a project task",
      description: "One task by id, with planned and spent time and its progress.",
      input: { task_id: z.number().int().positive() },
    },
    async ({ task_id }) => {
      const task = await ctx.api.get<Json>(`/tasks/${task_id}`);
      return { ...withHours(shape(task, [...TASK_FIELDS, "note_public", "note_private"])), custom_fields: extraFields(task) };
    },
  );

  writeTool(
    server,
    ctx,
    "dolibarr_task_create",
    {
      title: "Create a project task",
      description: "Adds a task to a project.",
      input: {
        project_id: z.number().int().positive(),
        label: z.string().min(1).max(255),
        ref: z.string().max(50).optional().describe("Leave out to number it after the project ref."),
        description: z.string().max(10_000).optional(),
        parent_task_id: z.number().int().positive().optional(),
        date_start: dateInput.optional(),
        date_end: dateInput.optional(),
        planned_hours: z.number().min(0).optional(),
        custom_fields: customFieldsInput,
      },
    },
    async (a) => {
      let ref = a.ref;
      if (!ref) {
        const [project, tasks] = await Promise.all([
          ctx.api.get<Json>(`/projects/${a.project_id}`),
          optional(() => ctx.api.get<Json[]>(`/projects/${a.project_id}/tasks`)),
        ]);
        ref = `${String(project.ref)}-T${(Array.isArray(tasks) ? tasks.length : 0) + 1}`;
      }
      const id = createdId(
        await ctx.api.post<unknown>(
          "/tasks",
          defined({
            ref,
            label: a.label,
            fk_project: a.project_id,
            description: a.description,
            fk_task_parent: a.parent_task_id ?? 0,
            date_start: toUnix(a.date_start),
            date_end: toUnix(a.date_end),
            planned_workload: a.planned_hours === undefined ? undefined : Math.round(a.planned_hours * 3600),
            array_options: toArrayOptions(a.custom_fields),
          }),
        ),
        "/tasks",
      );
      return { created: true, ...withHours(shape(await ctx.api.get<Json>(`/tasks/${id}`), TASK_FIELDS)) };
    },
  );

  writeTool(
    server,
    ctx,
    "dolibarr_task_update",
    {
      title: "Update a project task",
      description: "Changes fields of a task, such as its dates, planned hours or progress. Only the fields given are changed.",
      input: {
        task_id: z.number().int().positive(),
        label: z.string().min(1).max(255).optional(),
        description: z.string().max(10_000).optional(),
        date_start: dateInput.optional(),
        date_end: dateInput.optional(),
        planned_hours: z.number().min(0).optional(),
        progress: z.number().int().min(0).max(100).optional().describe("Progress in percent."),
      },
    },
    async (a) => {
      await ctx.api.put(
        `/tasks/${a.task_id}`,
        defined({
          label: a.label,
          description: a.description,
          date_start: toUnix(a.date_start),
          date_end: toUnix(a.date_end),
          planned_workload: a.planned_hours === undefined ? undefined : Math.round(a.planned_hours * 3600),
          progress: a.progress,
        }),
      );
      return { updated: true, ...withHours(shape(await ctx.api.get<Json>(`/tasks/${a.task_id}`), TASK_FIELDS)) };
    },
  );

  writeTool(
    server,
    ctx,
    "dolibarr_task_add_time",
    {
      title: "Record time spent on a task",
      description: "Records time spent on a project task, for the connected user or another user.",
      input: {
        task_id: z.number().int().positive(),
        date: dateInput.describe("Day the work was done."),
        hours: z.number().positive().max(24),
        user_id: z.number().int().positive().optional().describe("Who did the work; default the connected user."),
        note: z.string().max(2000).optional(),
      },
    },
    async (a) => {
      await ctx.api.post(
        `/tasks/${a.task_id}/addtimespent`,
        defined({
          date: `${a.date} 12:00:00`,
          duration: Math.round(a.hours * 3600),
          user_id: a.user_id,
          note: a.note,
        }),
      );
      const task = await ctx.api.get<Json>(`/tasks/${a.task_id}`);
      return { done: "time recorded", hours: a.hours, task: compact(withHours(shape(task, TASK_FIELDS))) };
    },
  );
}
