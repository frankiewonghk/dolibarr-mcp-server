import { extraFields, shape, statusLabel, toInt } from "../dolibarr/shape.js";
import type { ToolContext } from "./context.js";
import { shapeLines, thirdPartyNames, type Json } from "./helpers.js";

/** Head fields shared by orders, invoices, shipments and receptions. */
const HEAD = [
  "id",
  "ref",
  "ref_client",
  "ref_customer",
  "ref_supplier",
  "label",
  "date",
  "date_commande",
  "delivery_date",
  "date_delivery",
  "date_lim_reglement",
  "date_echeance",
  "date_valid",
  "date_validation",
  "date_approve",
  "date_close",
  "date_creation",
  "total_ht",
  "total_tva",
  "total_ttc",
  "multicurrency_code",
  "multicurrency_total_ht",
  "multicurrency_total_ttc",
  "cond_reglement_code",
  "mode_reglement_code",
  "tracking_number",
  "shipping_method",
  "methode_commande",
] as const;

const DETAIL = ["note_public", "note_private"] as const;

/** One search row: head fields, readable status, third-party id. */
export function documentRow(record: Json, statusMap: Record<string, string>, more: readonly string[] = []): Json {
  const out = shape(record, [...HEAD, ...more]);
  // Foreign-currency amounts only matter when the currency is not the base one.
  if (out.multicurrency_total_ht === out.total_ht) {
    delete out.multicurrency_total_ht;
    delete out.multicurrency_total_ttc;
  }
  if (out.ref_client === out.ref_customer) delete out.ref_client;
  if (out.date_commande === out.date) delete out.date_commande;
  const status = statusLabel(statusMap, record.status ?? record.statut ?? record.fk_statut);
  if (status !== null) out.status = status;
  const party = toInt(record.socid ?? record.fk_soc);
  if (party !== null && party > 0) out.thirdparty_id = party;
  return out;
}

/** A full record: row + notes, custom fields and lines. */
export function documentDetail(record: Json, statusMap: Record<string, string>, more: readonly string[] = []): Json {
  return {
    ...documentRow(record, statusMap, [...DETAIL, ...more]),
    custom_fields: extraFields(record),
    lines: shapeLines(record.lines),
  };
}

/** Add the third party's name to rows that carry thirdparty_id. */
export async function withPartyNames<T extends Json>(ctx: ToolContext, rows: T[]): Promise<T[]> {
  const names = await thirdPartyNames(
    ctx,
    rows.map((row) => row.thirdparty_id),
  );
  for (const row of rows) {
    const name = names.get(row.thirdparty_id as number);
    if (name) (row as Json).thirdparty = name;
  }
  return rows;
}
