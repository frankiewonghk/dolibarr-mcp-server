import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { extraFields, shape, toInt } from "../dolibarr/shape.js";
import { createdId } from "./actions.js";
import type { ToolContext } from "./context.js";
import {
  countryId,
  customFieldsInput,
  defined,
  list,
  noteInputs,
  optional,
  pageResult,
  paging,
  readTool,
  textFilter,
  toArrayOptions,
  writeTool,
  type Json,
} from "./helpers.js";

const PARTY_ROW = [
  "id",
  "name",
  "name_alias",
  "code_client",
  "code_fournisseur",
  "town",
  "country_code",
  "email",
  "phone",
] as const;

const PARTY_FULL = [
  ...PARTY_ROW,
  "address",
  "zip",
  "state",
  "url",
  "tva_intra",
  "idprof1",
  "idprof2",
  "idprof3",
  "idprof4",
  "multicurrency_code",
  "cond_reglement_id",
  "mode_reglement_id",
  "outstanding_limit",
  "note_public",
  "note_private",
  "date_creation",
  "date_modification",
] as const;

const CONTACT_FIELDS = [
  "id",
  "firstname",
  "lastname",
  "poste",
  "email",
  "phone_pro",
  "phone_mobile",
  "address",
  "zip",
  "town",
  "country_code",
] as const;

export function partyRoles(party: Json): string[] {
  const roles: string[] = [];
  const client = toInt(party.client);
  if (client === 1 || client === 3) roles.push("customer");
  if (client === 2 || client === 3) roles.push("prospect");
  if (toInt(party.fournisseur) === 1) roles.push("supplier");
  return roles;
}

/** Roles to Dolibarr's client (0-3) and fournisseur (0/1) flags. */
function roleFlags(roles: string[] | undefined): Json {
  if (!roles) return {};
  const customer = roles.includes("customer");
  const prospect = roles.includes("prospect");
  return {
    client: customer && prospect ? 3 : customer ? 1 : prospect ? 2 : 0,
    fournisseur: roles.includes("supplier") ? 1 : 0,
  };
}

const partyFields = {
  name: z.string().min(1).max(128),
  name_alias: z.string().max(128).optional().describe("Trade name or short name."),
  roles: z
    .array(z.enum(["customer", "prospect", "supplier"]))
    .min(1)
    .optional()
    .describe("What the third party is to the company."),
  address: z.string().max(255).optional(),
  zip: z.string().max(25).optional(),
  town: z.string().max(50).optional(),
  country_code: z.string().length(2).optional().describe("ISO 3166 country code, e.g. FR, US."),
  email: z.email().optional(),
  phone: z.string().max(30).optional(),
  url: z.string().max(255).optional(),
  vat_number: z.string().max(20).optional().describe("Intra-community VAT number."),
  ...noteInputs,
  custom_fields: customFieldsInput,
};

const contactFields = {
  thirdparty_id: z.number().int().positive().optional().describe("Third party the contact belongs to."),
  firstname: z.string().max(50).optional(),
  lastname: z.string().min(1).max(50),
  job_title: z.string().max(80).optional(),
  email: z.email().optional(),
  phone_pro: z.string().max(30).optional(),
  phone_mobile: z.string().max(30).optional(),
  address: z.string().max(255).optional(),
  zip: z.string().max(25).optional(),
  town: z.string().max(50).optional(),
  country_code: z.string().length(2).optional(),
  note_private: noteInputs.note_private,
  custom_fields: customFieldsInput,
};

export function registerThirdpartyTools(server: McpServer, ctx: ToolContext): void {
  // --- Third parties -----------------------------------------------------------

  readTool(
    server,
    "dolibarr_thirdparty_search",
    {
      title: "Search third parties",
      description:
        "Finds third parties (customers, prospects, suppliers) by name, alias, customer or supplier code, email or town. " +
        "Use the returned id as thirdparty_id in the other tools.",
      input: {
        query: z.string().max(100).optional().describe("Part of the name, alias, code, email or town."),
        role: z.enum(["customer", "prospect", "supplier"]).optional().describe("Only this kind of third party."),
        ...paging,
      },
    },
    async ({ query, role, limit, page }) => {
      const mode = role === "customer" ? 1 : role === "prospect" ? 2 : role === "supplier" ? 4 : undefined;
      const result = await list(ctx, "/thirdparties", {
        sqlfilters: textFilter(query, ["t.nom", "t.name_alias", "t.code_client", "t.code_fournisseur", "t.email", "t.town"]),
        mode,
        limit,
        page,
        sortfield: "t.nom",
        sortorder: "ASC",
      });
      const rows = result.rows.map((party) => ({ ...shape(party, PARTY_ROW), roles: partyRoles(party) }));
      return pageResult(result, rows, limit, page);
    },
  );

  readTool(
    server,
    "dolibarr_thirdparty_get",
    {
      title: "Get a third party",
      description:
        "Full record of one third party by id: address, tax and payment data, custom fields, its contacts and its sales representatives.",
      input: { thirdparty_id: z.number().int().positive().describe("Id from dolibarr_thirdparty_search.") },
    },
    async ({ thirdparty_id: id }) => {
      const [party, contacts, reps] = await Promise.all([
        ctx.api.get<Json>(`/thirdparties/${id}`),
        optional(() => list(ctx, "/contacts", { thirdparty_ids: id, limit: 50 }, { pagination: false })),
        optional(() => ctx.api.get<Json[]>(`/thirdparties/${id}/representatives`)),
      ]);
      return {
        ...shape(party, PARTY_FULL),
        roles: partyRoles(party),
        active: toInt(party.status) === 1,
        custom_fields: extraFields(party),
        contacts: (contacts?.rows ?? []).map((c) => shape(c, CONTACT_FIELDS)),
        sales_representatives: Array.isArray(reps)
          ? reps.map((r) => shape(r, ["id", "login", "firstname", "lastname", "email"]))
          : undefined,
      };
    },
  );

  writeTool(
    server,
    ctx,
    "dolibarr_thirdparty_create",
    {
      title: "Create a third party",
      description:
        "Creates a customer, prospect or supplier. Search first with dolibarr_thirdparty_search: duplicates are hard to clean up. " +
        "Customer and supplier codes are generated by Dolibarr's numbering rule.",
      input: { ...partyFields, roles: partyFields.roles.default(["customer"]) },
    },
    async (a) => {
      const flags = roleFlags(a.roles);
      const reply = await ctx.api.post<unknown>(
        "/thirdparties",
        defined({
          name: a.name,
          name_alias: a.name_alias,
          ...flags,
          code_client: toInt(flags.client) ? "auto" : undefined,
          code_fournisseur: flags.fournisseur === 1 ? "auto" : undefined,
          address: a.address,
          zip: a.zip,
          town: a.town,
          country_id: await countryId(ctx, a.country_code),
          email: a.email,
          phone: a.phone,
          url: a.url,
          tva_intra: a.vat_number,
          note_public: a.note_public,
          note_private: a.note_private,
          array_options: toArrayOptions(a.custom_fields),
        }),
      );
      const id = createdId(reply, "/thirdparties");
      const party = await ctx.api.get<Json>(`/thirdparties/${id}`);
      return { created: true, ...shape(party, PARTY_ROW), roles: partyRoles(party) };
    },
  );

  writeTool(
    server,
    ctx,
    "dolibarr_thirdparty_update",
    {
      title: "Update a third party",
      description: "Changes fields of a third party. Only the fields given are changed.",
      input: {
        thirdparty_id: z.number().int().positive(),
        ...partyFields,
        name: partyFields.name.optional(),
      },
    },
    async ({ thirdparty_id, ...a }) => {
      await ctx.api.put(
        `/thirdparties/${thirdparty_id}`,
        defined({
          name: a.name,
          name_alias: a.name_alias,
          ...roleFlags(a.roles),
          address: a.address,
          zip: a.zip,
          town: a.town,
          country_id: await countryId(ctx, a.country_code),
          email: a.email,
          phone: a.phone,
          url: a.url,
          tva_intra: a.vat_number,
          note_public: a.note_public,
          note_private: a.note_private,
          array_options: toArrayOptions(a.custom_fields),
        }),
      );
      const party = await ctx.api.get<Json>(`/thirdparties/${thirdparty_id}`);
      return {
        updated: true,
        ...shape(party, PARTY_FULL),
        roles: partyRoles(party),
        custom_fields: extraFields(party),
      };
    },
  );

  // --- Contacts ------------------------------------------------------------------

  readTool(
    server,
    "dolibarr_contact_search",
    {
      title: "Search contacts",
      description: "Finds contacts (people) by name or email, optionally only those of one third party.",
      input: {
        query: z.string().max(100).optional().describe("Part of the first name, last name or email."),
        thirdparty_id: z.number().int().positive().optional(),
        ...paging,
      },
    },
    async ({ query, thirdparty_id, limit, page }) => {
      const result = await list(ctx, "/contacts", {
        sqlfilters: textFilter(query, ["t.lastname", "t.firstname", "t.email"]),
        thirdparty_ids: thirdparty_id,
        limit,
        page,
        sortfield: "t.lastname",
        sortorder: "ASC",
      });
      const rows = result.rows.map((c) => ({
        ...shape(c, CONTACT_FIELDS),
        thirdparty_id: toInt(c.socid) ?? undefined,
      }));
      return pageResult(result, rows, limit, page);
    },
  );

  readTool(
    server,
    "dolibarr_contact_get",
    {
      title: "Get a contact",
      description: "One contact by id, with custom fields.",
      input: { contact_id: z.number().int().positive() },
    },
    async ({ contact_id }) => {
      const c = await ctx.api.get<Json>(`/contacts/${contact_id}`);
      return {
        ...shape(c, [...CONTACT_FIELDS, "note_public", "note_private", "birthday"]),
        thirdparty_id: toInt(c.socid) ?? undefined,
        custom_fields: extraFields(c),
      };
    },
  );

  const contactBody = async (a: Partial<z.infer<z.ZodObject<typeof contactFields>>>): Promise<Json> =>
    defined({
      socid: a.thirdparty_id,
      firstname: a.firstname,
      lastname: a.lastname,
      poste: a.job_title,
      email: a.email,
      phone_pro: a.phone_pro,
      phone_mobile: a.phone_mobile,
      address: a.address,
      zip: a.zip,
      town: a.town,
      country_id: await countryId(ctx, a.country_code),
      note_private: a.note_private,
      array_options: toArrayOptions(a.custom_fields),
    });

  writeTool(
    server,
    ctx,
    "dolibarr_contact_create",
    {
      title: "Create a contact",
      description: "Creates a contact person, usually attached to a third party.",
      input: contactFields,
    },
    async (a) => {
      const id = createdId(await ctx.api.post<unknown>("/contacts", await contactBody(a)), "/contacts");
      const c = await ctx.api.get<Json>(`/contacts/${id}`);
      return { created: true, ...shape(c, CONTACT_FIELDS), thirdparty_id: toInt(c.socid) ?? undefined };
    },
  );

  writeTool(
    server,
    ctx,
    "dolibarr_contact_update",
    {
      title: "Update a contact",
      description: "Changes fields of a contact. Only the fields given are changed.",
      input: { contact_id: z.number().int().positive(), ...contactFields, lastname: contactFields.lastname.optional() },
    },
    async ({ contact_id, ...a }) => {
      await ctx.api.put(`/contacts/${contact_id}`, await contactBody(a));
      const c = await ctx.api.get<Json>(`/contacts/${contact_id}`);
      return { updated: true, ...shape(c, CONTACT_FIELDS), thirdparty_id: toInt(c.socid) ?? undefined };
    },
  );

}
