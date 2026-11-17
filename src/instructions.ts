import type { Config, Toolset } from "./config.js";

/**
 * What an agent should know before it uses the tools. Sent to the client when
 * it connects. Kept short: detail belongs in the tool descriptions and in the
 * workflow prompts.
 */

const TOOLSET_NOTES: Record<Toolset, string[]> = {
  core: [],
  thirdparties: [
    "A third party can be a customer, a prospect and a supplier at the same time. Search before creating one; duplicates are hard to clean up.",
  ],
  products: ["Products are physical goods and can hold stock; services cannot."],
  sales: [
    "The sales flow is proposal → order → shipment → invoice. Each step can be created from the previous one, which keeps the documents linked.",
    "Drafts carry a provisional ref like (PROV12); the final ref is given on validation.",
  ],
  invoices: [
    "A validated invoice is an accounting document: it cannot be edited, and usually only the last one can be deleted. Corrections are made with a credit note.",
  ],
  purchasing: [
    "A supplier order runs draft → validated → approved → ordered → received. Goods arrive through a reception (Receptions module) or by receiving on the order directly.",
  ],
  stock: [
    "Stock changes should come from documents (shipments, receptions, manufacturing orders). Manual corrections and transfers are for inventory fixes.",
  ],
  production: [
    "A manufacturing order usually comes from a validated bill of materials. BOMs and manufacturing orders are validated in the Dolibarr web interface; the standard API has no route for that.",
  ],
  projects: ["Time spent is recorded on project tasks, in hours."],
  tickets: [],
  agenda: [],
};

export function buildInstructions(config: Config, canWrite: boolean): string {
  const lines: string[] = [
    `This server works with ${config.siteName}, a Dolibarr ERP & CRM instance, through its REST API.`,
    "",
    "How to work:",
    "- Every call runs as the connected Dolibarr user, with that user's permissions. Start with dolibarr_whoami.",
    "- A refusal that names a missing right (HTTP 403) is final: tell the user which right is missing; do not retry or look for another route. A price or amount that is absent is hidden from this user, not zero: never fill it in.",
    "- Find a record with the matching dolibarr_*_search tool, then read it with dolibarr_*_get. Search tools return the ids and refs the other tools take. Never guess an id.",
    "- Read before you change: get the record, check its status, then act. After a change, the reply shows the new state; check it and pass on any message from Dolibarr word for word.",
    "- Use only values Dolibarr offers. Codes and allowed values of custom fields come from dolibarr_custom_field_list; ids of payment types, countries, units and the like from dolibarr_dictionary.",
    "- Dates are YYYY-MM-DD in UTC. Amounts are in the document's currency, before tax unless the field says otherwise.",
    "- If no dedicated tool covers a need, use dolibarr_api_find_endpoint with dolibarr_api_get" +
      (canWrite ? " (or, as a last resort for a change, dolibarr_api_write)." : "."),
  ];

  lines.push("", "Changes:");
  if (canWrite) {
    lines.push(
      "- Creating and editing drafts is safe and can be done directly: a draft moves no stock, has no accounting effect and can be deleted.",
      "- Steps that cannot simply be undone are guarded: validate, approve, close, reopen, delete, stock movements, production postings and payments. " +
        "Call the tool once without confirm: it changes nothing and returns a preview. Show the preview to the user in plain words. " +
        "Only when the user agrees to that exact step, call it again with the same arguments, confirm=true and a short reason. " +
        "Never set confirm=true on your own initiative, and never bundle several confirmations into one question.",
      "- Do only what was asked. Give the user the ref of everything you created or changed.",
    );
  } else {
    lines.push("- This connection is read-only. It has no tools that change data; if the user asks for a change, say so.");
  }

  const notes = config.toolsets.flatMap((toolset) => TOOLSET_NOTES[toolset]);
  if (notes.length > 0) {
    lines.push("", "About Dolibarr:", ...notes.map((note) => `- ${note}`));
  }

  lines.push(
    "",
    "When stuck: re-read the record and Dolibarr's last message, then tell the user what you tried, what Dolibarr answered (quote it) and the ref of the record. Guessing on a live ERP costs more than asking.",
  );
  return lines.join("\n");
}
