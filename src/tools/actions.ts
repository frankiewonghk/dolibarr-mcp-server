import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DolibarrApiError } from "../dolibarr/client.js";
import { compact, toInt } from "../dolibarr/shape.js";
import type { ToolContext } from "./context.js";
import { documentRow, withPartyNames } from "./documents.js";
import { optional, writeTool, type Json } from "./helpers.js";

export interface ActionSpec {
  /** Route after the record id, e.g. "validate". Omit for DELETE on the record itself. */
  route?: string;
  method?: "POST" | "DELETE";
  body?: Json;
  /** Plain words on what the step does, shown in the preview. */
  effect: string;
}

export interface StatusToolSpec {
  name: string;
  title: string;
  /** "order", "shipment" … */
  noun: string;
  /** Collection path, e.g. "/orders". */
  path: string;
  statusMap: Record<string, string>;
  actions: Record<string, ActionSpec>;
  /** Extra checks to show in the preview (dry runs, warnings). */
  previewExtra?: (id: number, action: string, record: Json) => Promise<Json | undefined>;
  /** Extra inputs, passed to bodyFor. */
  extraInput?: Record<string, z.ZodType>;
  bodyFor?: (action: string, args: Json) => Json | undefined;
}

/** A short summary of a document: ref, status, totals, third party. */
export async function summary(
  ctx: ToolContext,
  record: Json,
  statusMap: Record<string, string>,
): Promise<Json> {
  const [row] = await withPartyNames(ctx, [documentRow(record, statusMap)]);
  return {
    ...row,
    line_count: Array.isArray(record.lines) ? record.lines.length : undefined,
  };
}

/** Messages Dolibarr showed (what a user would see as green/orange/red banners). */
export function messagesOf(reply: unknown): Json | undefined {
  const messages = (reply as Json | null)?.messages;
  const shaped = compact(messages) as Json | undefined;
  return shaped && Object.keys(shaped).length > 0 ? shaped : undefined;
}

/**
 * One guarded tool per document type for its status steps
 * (validate, close, reopen, set to draft, delete …).
 * Every step needs confirm=true; without it the tool only previews.
 */
export function statusTool(server: McpServer, ctx: ToolContext, spec: StatusToolSpec): void {
  const actionNames = Object.keys(spec.actions) as [string, ...string[]];
  const idKey = `${spec.noun.replace(/ /g, "_")}_id`;

  const load = (id: number): Promise<Json> => ctx.api.get<Json>(`${spec.path}/${id}`);

  writeTool(
    server,
    ctx,
    spec.name,
    {
      title: spec.title,
      guarded: true,
      description:
        `Moves a ${spec.noun} to another status. Actions: ` +
        Object.entries(spec.actions)
          .map(([action, a]) => `${action} (${a.effect})`)
          .join("; ") +
        ".",
      input: {
        [idKey]: z.number().int().positive(),
        action: z.enum(actionNames),
        ...(spec.extraInput ?? {}),
      },
    },
    async (args) => {
      const id = (args as Json)[idKey] as number;
      const action = (args as Json).action as string;
      const step = spec.actions[action]!;
      const body = spec.bodyFor?.(action, args as Json) ?? step.body;

      if (step.method === "DELETE") {
        const before = await load(id);
        const reply = await ctx.api.delete<unknown>(`${spec.path}/${id}`);
        // Some delete routes report success even when Dolibarr refused: check.
        const still = await optional(() => load(id));
        if (still) {
          throw new DolibarrApiError(
            409,
            `The ${spec.noun} ${String(before.ref)} was not deleted: Dolibarr refused (it may have linked documents)`,
            "DELETE",
            `${spec.path}/${id}`,
          );
        }
        return { done: action, id, ref: before.ref, messages: messagesOf(reply) };
      }

      const reply = await ctx.api.post<unknown>(`${spec.path}/${id}/${step.route}`, body);
      const after = await load(id);
      return {
        done: action,
        ...(await summary(ctx, after, spec.statusMap)),
        messages: messagesOf(reply),
      };
    },
    async (args) => {
      const id = (args as Json)[idKey] as number;
      const action = (args as Json).action as string;
      const record = await load(id);
      return {
        action,
        effect: spec.actions[action]!.effect,
        [spec.noun.replace(/ /g, "_")]: await summary(ctx, record, spec.statusMap),
        ...((await spec.previewExtra?.(id, action, record)) ?? {}),
      };
    },
  );
}

/** id from a create reply, which is an int, a numeric string, or {id, warnings}. */
export function createdId(reply: unknown, path: string): number {
  const id = toInt(typeof reply === "object" && reply !== null ? (reply as Json).id : reply);
  if (id === null || id <= 0) {
    throw new DolibarrApiError(500, "Dolibarr did not return the id of the new record", "POST", path);
  }
  return id;
}
