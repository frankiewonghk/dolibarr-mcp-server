import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DolibarrApiError } from "../dolibarr/client.js";
import { cleanMessage, compact, pick, toInt } from "../dolibarr/shape.js";
import { run, type ToolContext } from "./context.js";
import { readTool, writeTool, type Json } from "./helpers.js";

// ---------------------------------------------------------------------------
// Who am I
// ---------------------------------------------------------------------------

/** Flatten Dolibarr's nested rights object into "module.right[.sub]" names. */
export function flattenRights(rights: unknown): string[] {
  const out: string[] = [];
  const walk = (node: unknown, path: string[]): void => {
    if (node === null || typeof node !== "object") {
      if (node && path.length > 0) out.push(path.join("."));
      return;
    }
    for (const [key, value] of Object.entries(node as Json)) {
      walk(value, [...path, key]);
    }
  };
  walk(rights, []);
  return out.sort();
}

export function shapeWhoami(
  user: Json,
  status: Json | null,
  siteName: string,
  includeRights = false,
): Json {
  const groups = Array.isArray(user.user_group_list)
    ? (user.user_group_list as Json[])
        .map((group) => group.name ?? group.nom)
        .filter((name): name is string => typeof name === "string")
    : [];
  const success = (status?.success ?? null) as Json | null;
  return {
    site: siteName,
    dolibarr_version: success?.dolibarr_version ?? null,
    user: {
      id: toInt(user.id),
      ...pick(user, ["login", "firstname", "lastname", "email", "job"]),
      admin: toInt(user.admin) === 1,
    },
    groups,
    ...(includeRights ? { rights: flattenRights(user.rights) } : {}),
  };
}

// ---------------------------------------------------------------------------
// API catalogue (generic fallback)
// ---------------------------------------------------------------------------

export interface Endpoint {
  method: string;
  path: string;
  summary: string;
  params: string[];
}

const CACHE_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; endpoints: Endpoint[] }>();

/** Flatten Dolibarr's API explorer document into a searchable route list. */
export function parseCatalogue(swagger: unknown): Endpoint[] {
  const paths = (swagger as { paths?: Record<string, Record<string, Json>> } | null)?.paths ?? {};
  const out: Endpoint[] = [];
  for (const [path, methods] of Object.entries(paths)) {
    for (const [method, spec] of Object.entries(methods)) {
      const parameters = Array.isArray(spec.parameters) ? (spec.parameters as Json[]) : [];
      const params: string[] = [];
      for (const p of parameters) {
        if (p.in === "path") continue;
        if (p.in === "body") {
          const props = ((p.schema as Json | undefined)?.properties ?? {}) as Record<string, unknown>;
          params.push(...Object.keys(props).map((name) => `body.${name}`));
        } else {
          params.push(`${String(p.name)}${p.required ? "*" : ""}`);
        }
      }
      out.push({
        method: method.toUpperCase(),
        path,
        summary: cleanMessage(String(spec.summary ?? "")).replace(/\s*🔐\s*/g, "").trim(),
        params,
      });
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

/** Routes whose path or summary contains every word of the query. */
export function searchCatalogue(endpoints: Endpoint[], query: string, method?: string): Endpoint[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return endpoints.filter((endpoint) => {
    if (method && endpoint.method !== method) return false;
    const hay = `${endpoint.path} ${endpoint.summary}`.toLowerCase();
    return words.every((word) => hay.includes(word));
  });
}

async function loadCatalogue(ctx: ToolContext): Promise<Endpoint[]> {
  const key = ctx.config.dolibarrUrl;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.endpoints;
  const endpoints = parseCatalogue(await ctx.api.get("/explorer/swagger.json"));
  cache.set(key, { at: Date.now(), endpoints });
  return endpoints;
}

/** Paths the generic tools must not reach: sign-in and the catalogue itself. */
const BLOCKED = /^\/(login|explorer)(\/|$)/i;

export function checkApiPath(path: string): string {
  const clean = `/${path.trim().replace(/^\/+/, "")}`;
  if (clean.includes("..") || clean.includes("?") || clean.includes("#") || /\s/.test(clean)) {
    throw new DolibarrApiError(400, "Give the path only, e.g. /orders/12/lines; put filters in query", "GET", clean);
  }
  if (BLOCKED.test(clean)) {
    throw new DolibarrApiError(400, "This path is not available through the MCP server", "GET", clean);
  }
  return clean;
}

// ---------------------------------------------------------------------------
// Custom fields and dictionaries
// ---------------------------------------------------------------------------

/** Record names used by the tools, to Dolibarr's extrafield element types. */
export const EXTRAFIELD_ELEMENTS: Record<string, string> = {
  thirdparty: "societe",
  contact: "socpeople",
  product: "product",
  proposal: "propal",
  proposal_line: "propaldet",
  order: "commande",
  order_line: "commandedet",
  shipment: "expedition",
  invoice: "facture",
  invoice_line: "facturedet",
  supplier_order: "commande_fournisseur",
  supplier_order_line: "commande_fournisseurdet",
  reception: "reception",
  supplier_invoice: "facture_fourn",
  warehouse: "entrepot",
  lot: "product_lot",
  bom: "bom_bom",
  manufacturing_order: "mrp_mo",
  project: "projet",
  task: "projet_task",
  ticket: "ticket",
  event: "actioncomm",
  user: "user",
};

/** Dictionaries a tool may need values from, to their API route. */
export const DICTIONARIES: Record<string, string> = {
  payment_types: "payment_types",
  payment_terms: "payment_terms",
  countries: "countries",
  states: "states",
  currencies: "currencies",
  units: "units",
  shipping_methods: "shipping_methods",
  incoterms: "incoterms",
  contact_types: "contact_types",
  civilities: "civilities",
  legal_forms: "legal_form",
  event_types: "event_types",
  availability: "availability",
  ordering_methods: "ordering_methods",
  ticket_types: "ticket_types",
  ticket_categories: "ticket_categories",
  ticket_severities: "ticket_severities",
};

export function registerCoreTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "dolibarr_whoami",
    {
      title: "Who am I in Dolibarr",
      description:
        "Returns the Dolibarr user this connection acts as, the Dolibarr version, the user's groups and (optionally) permissions. " +
        "Call it first in a session, and again with include_rights=true when Dolibarr refuses an action, to tell the user which right is missing.",
      inputSchema: {
        include_rights: z.boolean().default(false).describe("Also list the user's permissions (long list)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ include_rights }) =>
      run(async () => {
        const [user, status] = await Promise.all([
          ctx.api
            .get<Json>("/users/info", { includepermissions: include_rights ? 1 : 0 })
            // Reading one's own user record needs a user right that many accounts lack.
            .catch((error: unknown) => {
              if (error instanceof DolibarrApiError && error.status === 403) return null;
              throw error;
            }),
          // /status needs no special right but may be switched off; not fatal.
          ctx.api.get<Json>("/status").catch(() => null),
        ]);
        if (user === null) {
          const success = (status?.success ?? null) as Json | null;
          return {
            site: ctx.config.siteName,
            dolibarr_version: success?.dolibarr_version ?? null,
            user: { login: ctx.login },
            note: "Dolibarr does not let this user read their own user record, so groups and rights cannot be listed. The connection works; each tool will say when a right is missing.",
          };
        }
        return shapeWhoami(user, status, ctx.config.siteName, include_rights);
      }),
  );

  readTool(
    server,
    "dolibarr_custom_field_list",
    {
      title: "List the custom fields of a record type",
      description:
        "The custom fields (extrafields) a record type has on this Dolibarr instance: code, label, type, whether it is required, and the allowed values of choice fields. " +
        "Call it before creating or updating a record with custom_fields, so the codes and values are right.",
      input: {
        record: z
          .enum(Object.keys(EXTRAFIELD_ELEMENTS) as [string, ...string[]])
          .describe("The kind of record."),
      },
    },
    async ({ record }) => {
      const element = EXTRAFIELD_ELEMENTS[record]!;
      const all = await ctx.api
        .get<Record<string, Record<string, Json>>>("/setup/extrafields", {
          sortfield: "t.pos",
          sortorder: "ASC",
          elementtype: element,
        })
        .catch((error: unknown) => {
          // Dolibarr answers 404 when the record type has no custom fields.
          if (error instanceof DolibarrApiError && error.status === 404) return {} as Record<string, Record<string, Json>>;
          throw error;
        });
      const fields = all[element] ?? {};
      return Object.entries(fields).map(([code, def]) => {
        const options = ((def.param as Json | undefined)?.options ?? {}) as Record<string, unknown>;
        const isChoice = ["select", "radio", "checkbox"].includes(String(def.type));
        return compact({
          code,
          label: def.label,
          type: def.type,
          required: toInt(def.required) === 1,
          choices: isChoice ? options : undefined,
          // sellist / chkbxlst / link point at another table: "table:label:key".
          source: isChoice ? undefined : Object.keys(options)[0],
        });
      });
    },
  );

  readTool(
    server,
    "dolibarr_dictionary",
    {
      title: "Look up a Dolibarr dictionary",
      description:
        "Reads one of Dolibarr's reference lists: payment types and terms, countries, currencies, units, shipping methods, contact types, event types and so on. " +
        "Use it to find the id or code another tool asks for (e.g. payment_mode_id for a payment).",
      input: {
        dictionary: z.enum(Object.keys(DICTIONARIES) as [string, ...string[]]),
        query: z.string().max(100).optional().describe("Only entries whose code or label contains this text."),
        limit: z.number().int().min(1).max(500).default(100),
      },
    },
    async ({ dictionary, query, limit }) => {
      const rows = await ctx.api.get<Json[]>(`/setup/dictionary/${DICTIONARIES[dictionary]}`, {
        limit: 500,
        active: 1,
      });
      const needle = query?.toLowerCase();
      const hits = (Array.isArray(rows) ? rows : []).filter(
        (row) =>
          !needle ||
          Object.values(row).some((value) => typeof value === "string" && value.toLowerCase().includes(needle)),
      );
      return { count: hits.length, rows: compact(hits.slice(0, limit)) };
    },
  );

  readTool(
    server,
    "dolibarr_api_find_endpoint",
    {
      title: "Find a Dolibarr API endpoint",
      description:
        "Searches the instance's full REST API catalogue by words in the path or summary. It lists only the modules enabled on this instance. " +
        "Use it only when no dedicated dolibarr_* tool covers the need, then call the route with dolibarr_api_get. " +
        "In params, * marks a required query parameter and body.x a field of the JSON body.",
      input: {
        query: z.string().min(2).max(100).describe('Words to look for, e.g. "orders contacts" or "bank accounts".'),
        method: z.enum(["GET", "POST", "PUT", "DELETE"]).optional().describe("Only this HTTP method."),
      },
    },
    async ({ query, method }) => {
      const hits = searchCatalogue(await loadCatalogue(ctx), query, method);
      return {
        count: hits.length,
        shown: Math.min(hits.length, 25),
        endpoints: hits.slice(0, 25),
        ...(hits.length > 25 ? { note: "More than 25 matches: add a word to narrow the search." } : {}),
      };
    },
  );

  readTool(
    server,
    "dolibarr_api_get",
    {
      title: "Read from any Dolibarr API endpoint",
      description:
        "Calls any GET route of the Dolibarr REST API and returns the reply with empty fields removed. " +
        "A fallback for look-ups that no dedicated dolibarr_* tool covers; find the route with dolibarr_api_find_endpoint first. " +
        "List routes accept limit, page, sortfield, sortorder and sqlfilters, e.g. (t.ref:like:'SO%').",
      input: {
        path: z.string().min(2).max(300).describe("Route path without the query string, e.g. /orders/12/contacts."),
        query: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
          .optional()
          .describe('Query parameters, e.g. {"limit": 10}.'),
      },
    },
    async ({ path, query }) => compact(await ctx.api.get(checkApiPath(path), query)),
  );

  writeTool(
    server,
    ctx,
    "dolibarr_api_write",
    {
      title: "Write to any Dolibarr API endpoint",
      description:
        "Calls any POST, PUT or DELETE route of the Dolibarr REST API. A last resort for changes that no dedicated dolibarr_* tool covers: " +
        "find the route and its body fields with dolibarr_api_find_endpoint first, and prefer a dedicated tool whenever one exists.",
      guarded: true,
      input: {
        method: z.enum(["POST", "PUT", "DELETE"]),
        path: z.string().min(2).max(300).describe("Route path, e.g. /thirdparties or /orders/12/contact/5/SHIPPING."),
        body: z.record(z.string(), z.unknown()).optional().describe("JSON body for POST and PUT."),
      },
    },
    async ({ method, path, body }) => compact(await ctx.api.request(method, checkApiPath(path), { body })),
    async ({ method, path, body }) => ({ method, path: checkApiPath(path), body }),
  );
}
