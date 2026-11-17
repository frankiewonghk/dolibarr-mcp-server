import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config, Toolset } from "./config.js";

interface WorkflowPrompt {
  name: string;
  title: string;
  description: string;
  /** Registered only when every one of these toolsets is on. */
  needs: Toolset[];
  /** Registered only for connections that can change data. */
  write: boolean;
  args: Record<string, { description: string; required: boolean }>;
  text: (args: Record<string, string | undefined>) => string;
}

const CONFIRM_RULE =
  "Guarded steps (marked ⚠) change things that cannot simply be undone: run the tool once without confirm, show me the preview in plain words, and wait for my yes before running it with confirm=true. One step per question.";

const PROMPTS: WorkflowPrompt[] = [
  {
    name: "customer_overview",
    title: "Customer overview",
    description: "Everything open with one customer: proposals, orders, shipments, unpaid invoices and recent activity.",
    needs: ["thirdparties", "sales", "invoices"],
    write: false,
    args: { customer: { description: "Customer name or code", required: true } },
    text: ({ customer }) =>
      [
        `Give me an overview of the customer ${customer}. Read only; change nothing.`,
        "",
        "1. dolibarr_thirdparty_search (role customer); ask me if several match. Then dolibarr_thirdparty_get.",
        "2. dolibarr_proposal_search with thirdparty_id: open proposals (validated, not yet signed).",
        "3. dolibarr_order_search with thirdparty_id: orders not yet delivered.",
        "4. dolibarr_invoice_search with thirdparty_id and status unpaid: what is still due, and since when.",
        "5. If available: dolibarr_event_search with thirdparty_id: the last few events.",
        "",
        "Report: one line on the relationship, then short lists of what is open, with refs, amounts and dates. Flag overdue invoices.",
      ].join("\n"),
  },
  {
    name: "order_status",
    title: "Where does this order stand?",
    description: "Status of one sales order: lines, shipments and invoicing.",
    needs: ["sales"],
    write: false,
    args: { order: { description: "Sales order ref or id", required: true } },
    text: ({ order }) =>
      [
        `Give me a status report on sales order ${order}. Read only; change nothing.`,
        "",
        "1. dolibarr_order_get: status, customer, delivery date, lines and shipments.",
        "2. dolibarr_shipment_get for each shipment: what left, when, with which tracking number.",
        "3. If available: dolibarr_invoice_search for the customer; match invoices to this order by reference.",
        "",
        "Report: one line on where the order stands, then what is done, what is open and what is blocking, with refs. Say plainly if it is late against the delivery date.",
      ].join("\n"),
  },
  {
    name: "stock_check",
    title: "What stock do we have of this product?",
    description: "Stock of one product by warehouse and lot, and its recent movements.",
    needs: ["products", "stock"],
    write: false,
    args: { product: { description: "Product ref, or words from its name", required: true } },
    text: ({ product }) =>
      [
        `Tell me what stock we have of ${product}. Read only.`,
        "",
        "1. dolibarr_product_search if that is not an exact ref; ask me if several products match.",
        "2. dolibarr_product_stock: physical stock per warehouse and lot, with best-before dates, and the virtual stock.",
        "3. dolibarr_stock_movement_search (product_id, limit 10): the latest movements.",
        "",
        "Report a small table per warehouse (and lot): quantity, best-before. Then one line with the total, and anything expiring within 90 days.",
      ].join("\n"),
  },
  {
    name: "unpaid_invoices",
    title: "Unpaid customer invoices",
    description: "The customer invoices still to be paid, oldest first, with what is overdue.",
    needs: ["invoices"],
    write: false,
    args: { customer: { description: "Only this customer (optional)", required: false } },
    text: ({ customer }) =>
      [
        `List the unpaid customer invoices${customer ? ` of ${customer}` : ""}. Read only.`,
        "",
        customer ? "1. dolibarr_thirdparty_search to find the customer; ask me if several match." : "1. No customer filter.",
        "2. dolibarr_invoice_search with status unpaid; page through all results.",
        "3. For each: ref, customer, invoice date, due date (date_lim_reglement), total and remaining amount.",
        "",
        "Report a table sorted by due date, mark the overdue ones, and give the total outstanding per currency.",
      ].join("\n"),
  },
  {
    name: "new_quote",
    title: "Prepare a quote",
    description: "Create a commercial proposal for a customer or prospect, check it with the user, and validate it.",
    needs: ["thirdparties", "products", "sales"],
    write: true,
    args: {
      customer: { description: "Customer or prospect name", required: true },
      details: { description: "Products or services, quantities, prices, validity", required: true },
    },
    text: ({ customer, details }) =>
      [
        `Prepare a quote for ${customer}: ${details}`,
        "",
        CONFIRM_RULE,
        "",
        "1. dolibarr_thirdparty_search. If none matches, ask me whether to create the prospect with dolibarr_thirdparty_create; if several match, ask me which.",
        "2. dolibarr_product_search for each item; ask me if one is not found or several match. Items that are not products become free-text lines.",
        "3. dolibarr_proposal_create with the lines. Show me the draft: lines, prices, totals.",
        "4. Apply my corrections with dolibarr_proposal_line.",
        "5. ⚠ dolibarr_proposal_action validate, once I agree. Give me the final ref.",
      ].join("\n"),
  },
  {
    name: "new_sales_order",
    title: "Enter a sales order",
    description: "Create a sales order for a customer, check it with the user, and validate it.",
    needs: ["thirdparties", "products", "sales"],
    write: true,
    args: {
      customer: { description: "Customer name or code", required: true },
      details: { description: "What they ordered: products, quantities, prices, delivery date, their PO number", required: true },
    },
    text: ({ customer, details }) =>
      [
        `Enter a sales order for ${customer}: ${details}`,
        "",
        CONFIRM_RULE,
        "",
        "1. dolibarr_thirdparty_search (role customer). If none or several match, ask me. Do not create a customer without asking.",
        "2. dolibarr_product_search for each product. If one is not found or several match, ask me.",
        "3. dolibarr_custom_field_list (order) to see which custom fields are required; ask me for any required value I did not give.",
        "4. If the customer accepted a proposal, use dolibarr_order_create_from_proposal; otherwise dolibarr_order_create with the lines.",
        "5. Show me the draft: lines, prices, totals, delivery date. Apply corrections with dolibarr_order_line or dolibarr_order_update.",
        "6. ⚠ dolibarr_order_action validate, once I agree. Give me the final ref.",
      ].join("\n"),
  },
  {
    name: "ship_and_invoice",
    title: "Ship and invoice an order",
    description: "Create the shipment for a validated sales order, then the invoice.",
    needs: ["sales", "invoices", "stock"],
    write: true,
    args: { order: { description: "Sales order ref or id", required: true } },
    text: ({ order }) =>
      [
        `Ship and invoice sales order ${order}.`,
        "",
        CONFIRM_RULE,
        "",
        "1. dolibarr_order_get: the order must be validated. Note the line ids and quantities still to ship.",
        "2. dolibarr_product_stock for each product line: which warehouse has the goods. If stock is short, tell me and ask whether to ship part.",
        "3. dolibarr_shipment_create with one line per order line and warehouse. Show me the draft.",
        "4. ⚠ dolibarr_shipment_action validate.",
        "5. dolibarr_invoice_create_from_order. Show me the draft invoice.",
        "6. ⚠ dolibarr_invoice_action validate. This gives the invoice its final number.",
        "7. Give me the shipment and invoice refs. Do not record a payment unless I ask.",
      ].join("\n"),
  },
  {
    name: "purchase_and_receive",
    title: "Order from a supplier and receive the goods",
    description: "Create a supplier order, take it through approval, and book the goods into stock when they arrive.",
    needs: ["thirdparties", "products", "purchasing", "stock"],
    write: true,
    args: {
      supplier: { description: "Supplier name", required: true },
      details: { description: "Products and quantities to order", required: true },
    },
    text: ({ supplier, details }) =>
      [
        `Order from ${supplier}: ${details}`,
        "",
        CONFIRM_RULE,
        "",
        "1. dolibarr_thirdparty_search (role supplier); ask me if none or several match.",
        "2. dolibarr_product_search for each product. dolibarr_product_get shows the supplier prices; if this supplier has no price for a product, ask me for it.",
        "3. dolibarr_supplier_order_create. Show me the draft.",
        "4. ⚠ dolibarr_supplier_order_action validate, then ⚠ approve, then ⚠ mark_ordered — each only after my yes.",
        "5. When I tell you the goods arrived: dolibarr_warehouse_list, ask me which warehouse, then dolibarr_reception_create and ⚠ dolibarr_reception_action validate (or ⚠ dolibarr_supplier_order_receive if receptions are not used).",
        "6. Give me the refs of everything created.",
      ].join("\n"),
  },
  {
    name: "log_time",
    title: "Record time on a project",
    description: "Record hours spent on a project task.",
    needs: ["projects"],
    write: true,
    args: {
      project: { description: "Project ref or title", required: true },
      details: { description: "Task, date and hours, e.g. 'design review, yesterday, 2.5h'", required: true },
    },
    text: ({ project, details }) =>
      [
        `Record time on project ${project}: ${details}`,
        "",
        "1. dolibarr_project_search, then dolibarr_project_get for its tasks. Ask me if the project or task is ambiguous.",
        "2. If the task does not exist, ask me before creating it with dolibarr_task_create.",
        "3. dolibarr_task_add_time with the date and hours.",
        "4. Confirm what was recorded and the task's total time spent.",
      ].join("\n"),
  },
];

/** Register the workflow prompts that fit this instance and connection. */
export function registerPrompts(server: McpServer, config: Config, canWrite: boolean): string[] {
  const registered: string[] = [];
  for (const prompt of PROMPTS) {
    if (prompt.write && !canWrite) continue;
    if (!prompt.needs.every((toolset) => config.toolsets.includes(toolset))) continue;
    const argsSchema = Object.fromEntries(
      Object.entries(prompt.args).map(([name, arg]) => {
        const field = z.string().max(2000).describe(arg.description);
        return [name, arg.required ? field : field.optional()];
      }),
    );
    server.registerPrompt(
      prompt.name,
      { title: prompt.title, description: prompt.description, argsSchema },
      (args: Record<string, string | undefined>) => ({
        messages: [{ role: "user" as const, content: { type: "text" as const, text: prompt.text(args) } }],
      }),
    );
    registered.push(prompt.name);
  }
  return registered;
}

export const PROMPT_NAMES = PROMPTS.map((prompt) => prompt.name);
