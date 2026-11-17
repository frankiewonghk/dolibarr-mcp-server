import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { DolibarrClient } from "../src/dolibarr/client.js";
import { compact, isoDate, STATUS, statusCode, statusLabel } from "../src/dolibarr/shape.js";
import { buildServer } from "../src/server.js";
import { checkApiPath, parseCatalogue, searchCatalogue } from "../src/tools/core.js";
import { documentRow } from "../src/tools/documents.js";
import { allOf, equals, fetchOne, list, pageResult, shapeLines, textFilter } from "../src/tools/helpers.js";
import { lineBody, mergedLineBody } from "../src/tools/lines.js";

const BASE = "https://dolibarr.example.test";

describe("compact", () => {
  it("drops empty and internal fields, including a leaked db handle", () => {
    const out = compact({
      id: "7",
      ref: "SO1",
      entity: "1",
      note: null,
      empty: [],
      lines: [{ batch: "L1", db: { database_user: "secret" }, qty: "150" }],
    });
    expect(out).toEqual({ id: 7, ref: "SO1", lines: [{ batch: "L1", qty: 150 }] });
    expect(JSON.stringify(out)).not.toContain("secret");
  });

  it("turns timestamps into dates and long decimals into numbers", () => {
    expect(
      compact({ date_creation: 1794480404, delivery_date: 1795132800, total_ht: "1492.50000000", qty: 0 }),
    ).toEqual({ date_creation: "2026-11-12T10:46Z", delivery_date: "2026-11-20", total_ht: 1492.5, qty: 0 });
    expect(isoDate("abc")).toBeNull();
    expect(isoDate(5)).toBeNull();
  });

  it("keeps refs that look like numbers as text and cleans HTML", () => {
    expect(compact({ ref: "00123", note_public: "A &amp; B<br>C" })).toEqual({ ref: "00123", note_public: "A & B\nC" });
  });
});

describe("status labels", () => {
  it("labels known codes and passes unknown ones through", () => {
    expect(statusLabel(STATUS.order, "1")).toBe("validated (1)");
    expect(statusLabel(STATUS.order, -1)).toBe("cancelled (-1)");
    expect(statusLabel(STATUS.invoice, 7)).toBe("7");
    expect(statusCode(STATUS.supplierOrder, "received")).toBe(5);
    expect(statusCode(STATUS.proposal, "signed")).toBe(2);
  });
});

describe("filters", () => {
  it("builds a text search over several columns", () => {
    expect(textFilter("abc", ["t.ref", "t.label"])).toBe("((t.ref:like:'%abc%') or (t.label:like:'%abc%'))");
    expect(textFilter("  ", ["t.ref"])).toBeUndefined();
  });

  it("strips characters that could break out of the filter", () => {
    expect(textFilter("x') or (t.rowid:>:'0", ["t.ref"])).toBe("((t.ref:like:'%x or t.rowid > 0%'))");
    expect(equals("t.batch", "L'1")).toBe("(t.batch:=:'L 1')");
  });

  it("joins filters with and", () => {
    expect(allOf(equals("t.fk_statut", 1), undefined, equals("t.fk_product", 5))).toBe("(t.fk_statut:=:1) and (t.fk_product:=:5)");
    expect(allOf(undefined)).toBeUndefined();
  });
});

describe("documents", () => {
  it("shapes a search row", () => {
    const row = documentRow(
      {
        id: "2",
        ref: "SO2",
        ref_client: "PO-9",
        ref_customer: "PO-9",
        statut: "3",
        socid: "4",
        date: 1794441600,
        date_commande: 1794441600,
        total_ht: "10.00000000",
        multicurrency_total_ht: "10.00000000",
        multicurrency_code: "EUR",
        lines: [{ id: 1 }],
      },
      STATUS.order,
    );
    expect(row).toEqual({
      id: 2,
      ref: "SO2",
      ref_customer: "PO-9",
      date: "2026-11-12",
      total_ht: 10,
      multicurrency_code: "EUR",
      status: "delivered (3)",
      thirdparty_id: 4,
    });
  });

  it("shapes lines with their lots", () => {
    const lines = shapeLines([
      {
        id: "1",
        fk_product: "5",
        product_ref: "P5",
        product_label: "Jar",
        desc: "Jar",
        qty: "150",
        subprice: "9.95000000",
        detail_batch: [{ batch: "L1", qty: "150", db: { x: 1 }, eatby: 1856649600 }],
      },
    ]);
    expect(lines).toEqual([
      { id: 1, fk_product: 5, product_ref: "P5", product_label: "Jar", qty: 150, subprice: 9.95, lots: [{ batch: "L1", qty: 150, eatby: "2028-11-01" }] },
    ]);
  });

  it("says whether there is another page", () => {
    expect(pageResult({ rows: [], total: 45 }, [1, 2], 20, 1)).toMatchObject({ total: 45, more: true });
    expect(pageResult({ rows: [], total: 40 }, [1, 2], 20, 1)).toMatchObject({ more: false });
    expect(pageResult({ rows: [] }, [1, 2], 2, 0)).toMatchObject({ more: true });
  });
});

describe("endpoint catalogue", () => {
  const swagger = {
    paths: {
      "/orders/{id}/contacts": {
        get: { summary: "Get contacts of given order 🔐", parameters: [{ name: "id", in: "path" }, { name: "type", in: "query" }] },
      },
      "/orders": {
        post: { summary: "Create a sales order", parameters: [{ in: "body", schema: { properties: { socid: {}, date: {} } } }] },
        get: { summary: "List orders", parameters: [{ name: "limit", in: "query" }, { name: "socid", in: "query", required: true }] },
      },
    },
  };
  const endpoints = parseCatalogue(swagger);

  it("flattens routes with their parameters", () => {
    expect(endpoints).toHaveLength(3);
    expect(endpoints.find((e) => e.method === "POST")!.params).toEqual(["body.socid", "body.date"]);
    expect(endpoints.find((e) => e.path === "/orders" && e.method === "GET")!.params).toEqual(["limit", "socid*"]);
    expect(endpoints[0]!.summary).not.toContain("🔐");
  });

  it("matches every word and can filter by method", () => {
    expect(searchCatalogue(endpoints, "orders contacts")).toHaveLength(1);
    expect(searchCatalogue(endpoints, "orders", "POST")).toHaveLength(1);
    expect(searchCatalogue(endpoints, "invoice")).toHaveLength(0);
  });

  it("keeps the generic tools away from sign-in and odd paths", () => {
    expect(checkApiPath("orders/1")).toBe("/orders/1");
    expect(() => checkApiPath("/login")).toThrow(/not available/);
    expect(() => checkApiPath("/explorer/swagger.json")).toThrow(/not available/);
    expect(() => checkApiPath("/orders/../users")).toThrow();
    expect(() => checkApiPath("/orders?limit=1")).toThrow();
  });
});

/** A context whose Dolibarr answers with the given handler, recording each call. */
function ctxWith(handler: (url: URL, init?: RequestInit) => { status: number; body: unknown }) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const api = new DolibarrClient({
    baseUrl: BASE,
    apiKey: "k",
    fetchImpl: (async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({
        method: init?.method ?? "GET",
        path: url.pathname.replace("/api/index.php", "") + url.search,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      const { status, body } = handler(url, init);
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch,
  });
  return { ctx: { config: loadConfig({ DOLIBARR_URL: BASE }), api, canWrite: true }, calls };
}

describe("fetching", () => {
  it("reads both list shapes and treats 404 as no rows", async () => {
    const wrapped = ctxWith(() => ({ status: 200, body: { data: [{ id: 1 }], pagination: { total: 9 } } }));
    expect(await list(wrapped.ctx, "/orders", { limit: 1 })).toEqual({ rows: [{ id: 1 }], total: 9 });
    const plain = ctxWith(() => ({ status: 200, body: [{ id: 1 }] }));
    expect(await list(plain.ctx, "/mos", {}, { pagination: false })).toEqual({ rows: [{ id: 1 }] });
    const none = ctxWith(() => ({ status: 404, body: { error: { message: "No order found" } } }));
    expect(await list(none.ctx, "/orders", {})).toEqual({ rows: [], total: 0 });
  });

  it("finds a record by id, by ref route, or by exact-ref search", async () => {
    const { ctx, calls } = ctxWith((url) =>
      url.pathname.endsWith("/supplierorders")
        ? { status: 200, body: [{ id: "8", ref: "PO-8" }, { id: "9", ref: "PO-88" }] }
        : { status: 200, body: { id: "8", ref: "PO-8" } },
    );
    await fetchOne(ctx, { path: "/orders", refPath: "/orders/ref" }, 12);
    await fetchOne(ctx, { path: "/orders", refPath: "/orders/ref" }, "SO 1/2");
    await fetchOne(ctx, { path: "/supplierorders" }, "po-8");
    expect(calls[0]!.path).toBe("/orders/12");
    expect(calls[1]!.path).toBe("/orders/ref/SO%201%2F2");
    expect(decodeURIComponent(calls[2]!.path)).toContain("sqlfilters=(t.ref:=:'po-8')");
    expect(calls[3]!.path).toBe("/supplierorders/8");
    await expect(fetchOne(ctx, { path: "/supplierorders" }, "PO-1")).rejects.toThrow(/Nothing found/);
  });
});

describe("document lines", () => {
  it("fills in the product's price and VAT rate when they are left out", async () => {
    const { ctx } = ctxWith(() => ({ status: 200, body: { id: "5", ref: "P5", price: "12.50000000", tva_tx: "20.000" } }));
    expect(await lineBody(ctx, { product_id: 5, qty: 2 }, "customer")).toEqual({
      fk_product: 5,
      qty: 2,
      subprice: 12.5,
      tva_tx: 20,
      desc: "",
      price_base_type: "HT",
    });
  });

  it("uses the supplier's own price on supplier documents", async () => {
    const { ctx } = ctxWith((url) =>
      url.pathname.endsWith("/purchase_prices")
        ? { status: 200, body: [{ fourn_id: "3", fourn_qty: "1", fourn_unitprice: "4.2" }, { fourn_id: "9", fourn_qty: "1", fourn_unitprice: "1" }] }
        : { status: 200, body: { id: "5", ref: "P5", price: "12.5", tva_tx: "0" } },
    );
    expect(await lineBody(ctx, { product_id: 5, qty: 2 }, "supplier", 3)).toMatchObject({ pu_ht: 4.2, description: "" });
  });

  it("marks a free-text line as a service unless told otherwise", async () => {
    const { ctx, calls } = ctxWith(() => ({ status: 200, body: {} }));
    expect(await lineBody(ctx, { qty: 1, unit_price: 50, description: "Setup", free_line_kind: "service" }, "customer")).toMatchObject({
      product_type: 1,
      subprice: 50,
    });
    expect(calls).toHaveLength(0);
  });

  it("sends the whole line back on update, with the changes on top", () => {
    const current = { id: "4", fk_product: "5", qty: "2", subprice: "12.5", tva_tx: "20", desc: "Jar", product_type: "0", remise_percent: "0" };
    expect(mergedLineBody(current, { qty: 3 }, "customer")).toEqual({
      fk_product: 5,
      qty: 3,
      subprice: "12.5",
      tva_tx: "20",
      remise_percent: "0",
      desc: "Jar",
      product_type: 0,
      price_base_type: "HT",
    });
  });
});

describe("toolsets", () => {
  const api = new DolibarrClient({ baseUrl: BASE, apiKey: "k" });
  type Tool = { annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } };
  const toolsFor = (toolsets: string, canWrite: boolean, writeMode = "guarded"): Record<string, Tool> => {
    const config = loadConfig({ DOLIBARR_URL: BASE, DOLIBARR_TOOLSETS: toolsets, DOLIBARR_WRITE_MODE: writeMode });
    const server = buildServer(config, api, { login: "t", clientId: "t", canWrite });
    return (server as unknown as { _registeredTools: Record<string, Tool> })._registeredTools;
  };

  it("a read-only connection gets only read-only tools", () => {
    const tools = toolsFor("all", false);
    for (const tool of Object.values(tools)) expect(tool.annotations?.readOnlyHint).toBe(true);
    expect(Object.keys(toolsFor("core", false))).toEqual([
      "dolibarr_whoami",
      "dolibarr_custom_field_list",
      "dolibarr_dictionary",
      "dolibarr_api_find_endpoint",
      "dolibarr_api_get",
    ]);
  });

  it("a read-only instance hides write tools even from a write token", () => {
    expect(Object.keys(toolsFor("all", true, "off"))).toEqual(Object.keys(toolsFor("all", false)));
  });

  it("a write connection adds the write tools, the irreversible ones marked destructive", () => {
    const tools = toolsFor("all", true);
    const reads = Object.keys(toolsFor("all", false));
    const writes = Object.entries(tools).filter(([, tool]) => tool.annotations?.readOnlyHint === false);
    expect(Object.keys(tools)).toHaveLength(reads.length + writes.length);
    const destructive = writes.filter(([, tool]) => tool.annotations?.destructiveHint).map(([name]) => name);
    expect(destructive.sort()).toEqual(
      [
        "dolibarr_api_write",
        "dolibarr_proposal_action",
        "dolibarr_order_action",
        "dolibarr_shipment_action",
        "dolibarr_invoice_action",
        "dolibarr_invoice_record_payment",
        "dolibarr_supplier_order_action",
        "dolibarr_supplier_order_receive",
        "dolibarr_reception_action",
        "dolibarr_supplier_invoice_action",
        "dolibarr_supplier_invoice_record_payment",
        "dolibarr_stock_correct",
        "dolibarr_stock_transfer",
        "dolibarr_bom_delete",
        "dolibarr_mo_delete",
        "dolibarr_mo_produce",
        "dolibarr_project_action",
      ].sort(),
    );
  });

  it("every tool name is unique, prefixed and short enough for MCP clients", () => {
    const names = Object.keys(toolsFor("all", true));
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(name).toMatch(/^dolibarr_[a-z_]+$/);
      expect(name.length).toBeLessThanOrEqual(64);
    }
  });

  it("registers only the toolsets that are on", () => {
    const names = Object.keys(toolsFor("sales", true));
    expect(names.some((n) => n.startsWith("dolibarr_order_"))).toBe(true);
    expect(names.some((n) => n.startsWith("dolibarr_ticket_"))).toBe(false);
    expect(names).toContain("dolibarr_whoami");
  });
});

describe("dolibarr_whoami", () => {
  const call = async (handler: (url: URL) => { status: number; body: unknown }) => {
    const { ctx } = ctxWith(handler);
    const server = buildServer(loadConfig({ DOLIBARR_URL: BASE, DOLIBARR_NAME: "Test Dolibarr" }), ctx.api, {
      login: "amy",
      clientId: "t",
      canWrite: false,
    });
    const tool = (
      server as unknown as {
        _registeredTools: Record<string, { handler: (a: unknown, e: unknown) => Promise<{ isError?: boolean; content: Array<{ text: string }> }> }>;
      }
    )._registeredTools.dolibarr_whoami!;
    const result = await tool.handler({ include_rights: false }, {});
    return { isError: result.isError === true, data: JSON.parse(result.content[0]!.text) as Record<string, unknown> };
  };

  it("still answers for a user who may not read their own user record", async () => {
    const { isError, data } = await call((url) =>
      url.pathname.endsWith("/users/info")
        ? { status: 403, body: { error: { code: 403, message: "Forbidden: Not allowed" } } }
        : { status: 200, body: { success: { dolibarr_version: "22.0.2" } } },
    );
    expect(isError).toBe(false);
    expect(data).toMatchObject({ site: "Test Dolibarr", dolibarr_version: "22.0.2", user: { login: "amy" } });
    expect(String(data.note)).toContain("groups and rights cannot be listed");
  });

  it("reports an invalid key as an error", async () => {
    const result = await call(() => ({ status: 401, body: { error: { code: 401, message: "Unauthorized" } } })).catch((e) => e);
    expect(result instanceof Error || result.isError === true).toBe(true);
  });
});
