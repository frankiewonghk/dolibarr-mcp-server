/**
 * Helpers that turn Dolibarr's raw API replies into something compact and
 * predictable for an agent.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Decode the HTML entities Dolibarr leaves in messages (&amp;, &#039;, ...). */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    if (body.startsWith("#")) {
      const code =
        body[1] === "x" || body[1] === "X"
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

/** Message text as a person would read it: no tags, no entities. */
export function cleanMessage(text: string): string {
  return decodeEntities(text.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, ""))
    .replace(/[ \t]+/g, " ")
    .trim();
}

/** Dolibarr returns ids sometimes as "12", sometimes as 12. */
export function toInt(value: unknown): number | null {
  if (typeof value === "number") return Number.isInteger(value) ? value : null;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    return Number.parseInt(value, 10);
  }
  return null;
}

/** Keep only the listed fields, dropping null / empty ones. */
export function pick<T extends Record<string, unknown>>(
  source: T,
  fields: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const value = source[field];
    if (value === null || value === undefined || value === "") continue;
    out[field] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Compacting raw API replies
// ---------------------------------------------------------------------------

/** Keys that are never useful to an agent, or must not leave the server. */
const DROP_KEYS = new Set([
  "db", // Dolibarr leaks its database handle (name, user, host) in some nested objects
  "entity",
  "module",
  "element",
  "table_element",
  "parent_element",
  "fk_parent_attribute",
  "import_key",
  "tms",
  "online_payment_url",
  "last_main_doc",
  "model_pdf",
  "fk_multicurrency",
  "multicurrency_tx",
  "trueSize",
  "api_key",
  "pass",
  "pass_crypted",
  "pass_indatabase",
  "pass_indatabase_crypted",
]);
const DROP_PATTERN =
  /^localtax|^total_localtax|^revenuestamp$|^user_\w+_id$|^fk_user|_units$|^specimen$/;

const DATE_KEY =
  /^(date|datec|datem|datev|datep|eatby|sellby|delivery_date|datelimite)$|^date_|_date$|^date[a-z]+$/;

/** Fields that hold quantities or amounts, sometimes sent as "150". */
const NUMBER_KEY =
  /^(qty|quantity|stock_|total_|totalpaid|sumpayed|remaintopay|subprice|price|pmp|real$|tva_tx|remise_percent|fk_|id$|rowid$|socid$|userownerid$|progress$|percentage$|planned_workload$|duration_effective$|paye$|fulldayevent$|efficiency$|position$|budget_amount$|opp_amount$|opp_percent$)|_id$/;

/** Unix seconds to a readable date; midnight values are plain dates. */
export function isoDate(value: unknown): string | null {
  const seconds =
    typeof value === "number" ? value : typeof value === "string" && /^\d{9,11}$/.test(value) ? Number(value) : NaN;
  if (!Number.isFinite(seconds) || seconds < 100_000_000) return null;
  const iso = new Date(seconds * 1000).toISOString();
  return seconds % 86_400 === 0 ? iso.slice(0, 10) : `${iso.slice(0, 16)}Z`;
}

const isEmpty = (value: unknown): boolean =>
  value === null ||
  value === undefined ||
  value === "" ||
  (Array.isArray(value) && value.length === 0) ||
  (typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === 0);

/**
 * Make an API reply small and readable: drop empty and noisy fields, turn
 * timestamps into dates and "9.95000000" into 9.95, clean message text.
 */
export function compact(value: unknown, key = ""): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => compact(item)).filter((item) => !isEmpty(item));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (DROP_KEYS.has(k) || DROP_PATTERN.test(k)) continue;
      const shaped = compact(v, k);
      if (!isEmpty(shaped)) out[k] = shaped;
    }
    return out;
  }
  if (DATE_KEY.test(key)) {
    const date = isoDate(value);
    if (date !== null) return date;
  }
  if (typeof value === "string") {
    // Dolibarr prints amounts with 4 to 8 decimals.
    if (/^-?\d+\.\d{4,}$/.test(value)) return Number(value);
    if (NUMBER_KEY.test(key) && /^-?\d+(\.\d+)?$/.test(value)) return Number(value);
    return /[<&]/.test(value) ? cleanMessage(value) : value;
  }
  return value;
}

/** pick() then compact(): the usual way to shape a stock Dolibarr object. */
export function shape(
  source: Record<string, unknown>,
  fields: readonly string[],
): Record<string, unknown> {
  const out = compact(pick(source, fields)) as Record<string, unknown>;
  if ("id" in out) out.id = toInt(out.id) ?? out.id;
  return out;
}

/** Custom fields: array_options {options_x: v} becomes {x: v}. */
export function extraFields(source: Record<string, unknown>): Record<string, unknown> | undefined {
  const raw = source.array_options;
  if (raw === null || typeof raw !== "object") return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!isEmpty(v)) out[k.replace(/^options_/, "")] = compact(v, k);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// ---------------------------------------------------------------------------
// Status codes
// ---------------------------------------------------------------------------

export const STATUS = {
  proposal: { "-1": "cancelled", 0: "draft", 1: "validated", 2: "signed", 3: "not signed", 4: "billed" },
  order: { "-1": "cancelled", 0: "draft", 1: "validated", 2: "in process", 3: "delivered" },
  shipment: { "-1": "cancelled", 0: "draft", 1: "validated", 2: "closed", 3: "in progress" },
  invoice: { 0: "draft", 1: "unpaid", 2: "paid", 3: "abandoned" },
  supplierOrder: {
    0: "draft",
    1: "validated",
    2: "approved",
    3: "ordered",
    4: "partially received",
    5: "received",
    6: "cancelled",
    7: "cancelled",
    9: "refused",
  },
  reception: { 0: "draft", 1: "validated", 2: "closed" },
  supplierInvoice: { 0: "draft", 1: "unpaid", 2: "paid", 3: "abandoned" },
  mo: { 0: "draft", 1: "validated", 2: "in progress", 3: "produced", 9: "cancelled" },
  bom: { 0: "draft", 1: "validated", 9: "disabled" },
  project: { 0: "draft", 1: "open", 2: "closed" },
  ticket: {
    0: "not read",
    1: "read",
    2: "assigned",
    3: "in progress",
    5: "waiting for requester",
    7: "on hold",
    8: "closed",
    9: "cancelled",
  },
} as const satisfies Record<string, Record<string, string>>;

/** "validated (1)" style label; unknown codes stay as the number. */
export function statusLabel(map: Record<string, string>, code: unknown): string | null {
  const n = toInt(code);
  if (n === null) return null;
  const label = map[String(n)];
  return label ? `${label} (${n})` : String(n);
}

/** The code for a label, for filters. */
export function statusCode(map: Record<string, string>, label: string): number | null {
  const hit = Object.entries(map).find(([, name]) => name === label);
  return hit ? Number(hit[0]) : null;
}
