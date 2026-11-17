import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { DolibarrClient } from "../src/dolibarr/client.js";
import { buildInstructions } from "../src/instructions.js";
import { PROMPT_NAMES } from "../src/prompts.js";
import { buildServer, SERVER_VERSION } from "../src/server.js";
import pkg from "../package.json" with { type: "json" };

const config = (toolsets: string, writeMode = "guarded") =>
  loadConfig({ DOLIBARR_URL: "https://dolibarr.example.test", DOLIBARR_NAME: "Acme ERP", DOLIBARR_TOOLSETS: toolsets, DOLIBARR_WRITE_MODE: writeMode });
const api = new DolibarrClient({ baseUrl: "https://dolibarr.example.test", apiKey: "k" });

type Internals = {
  _registeredPrompts: Record<string, { callback: (args: Record<string, string>) => { messages: Array<{ content: { text: string } }> } }>;
  _registeredTools: Record<string, { annotations?: { destructiveHint?: boolean } }>;
};
const build = (toolsets: string, canWrite: boolean, writeMode = "guarded") =>
  buildServer(config(toolsets, writeMode), api, { login: "t", clientId: "t", canWrite }) as unknown as Internals;

describe("server instructions", () => {
  it("explain the confirm protocol to a write connection", () => {
    const text = buildInstructions(config("all"), true);
    expect(text).toContain("Acme ERP");
    expect(text).toContain("confirm=true");
    expect(text).toContain("Never set confirm=true on your own initiative");
  });

  it("tell a read-only connection that it cannot change anything", () => {
    const text = buildInstructions(config("all"), false);
    expect(text).toContain("read-only");
    expect(text).not.toContain("confirm=true");
    expect(text).not.toContain("dolibarr_api_write");
  });

  it("leave out the notes of toolsets that are off", () => {
    const text = buildInstructions(config("sales"), true);
    expect(text).toContain("(PROV12)");
    expect(text).not.toContain("manufacturing order");
  });

  it("stay short enough to be read", () => {
    expect(buildInstructions(config("all"), true).length).toBeLessThan(6000);
  });
});

describe("workflow prompts", () => {
  it("offers every prompt to a write connection with all toolsets", () => {
    expect(Object.keys(build("all", true)._registeredPrompts).sort()).toEqual([...PROMPT_NAMES].sort());
  });

  it("offers only the read prompts to a read-only connection", () => {
    const reads = ["customer_overview", "order_status", "stock_check", "unpaid_invoices"];
    expect(Object.keys(build("all", false)._registeredPrompts).sort()).toEqual(reads);
    expect(Object.keys(build("all", true, "off")._registeredPrompts).sort()).toEqual(reads);
  });

  it("leaves out prompts whose toolsets are off", () => {
    const names = Object.keys(build("thirdparties,products,sales", true)._registeredPrompts);
    expect(names).toContain("new_sales_order");
    expect(names).not.toContain("ship_and_invoice");
    expect(names).not.toContain("log_time");
  });

  it("only names tools that exist, and marks guarded steps", () => {
    const server = build("all", true);
    const tools = server._registeredTools;
    for (const [name, prompt] of Object.entries(server._registeredPrompts)) {
      const text = prompt.callback({ order: "SO-1", product: "P1", customer: "ACME", supplier: "Supp", project: "PJ1", details: "x" }).messages[0]!
        .content.text;
      const mentioned = text.match(/dolibarr_[a-z_]+/g) ?? [];
      expect(mentioned.length, name).toBeGreaterThan(1);
      for (const tool of mentioned) expect(tools[tool], `${name} mentions ${tool}`).toBeDefined();
      for (const line of text.split("\n")) {
        const guarded = (line.match(/dolibarr_[a-z_]+/g) ?? []).filter((tool) => tools[tool]?.annotations?.destructiveHint);
        if (guarded.length > 0) expect(line.includes("⚠"), `${name}: "${line.trim().slice(0, 70)}"`).toBe(true);
      }
    }
  });

  it("puts the user's words into the prompt", () => {
    const text = build("all", true)._registeredPrompts.order_status!.callback({ order: "SO2611-0042" }).messages[0]!.content.text;
    expect(text).toContain("SO2611-0042");
  });
});

describe("version", () => {
  it("matches package.json", () => {
    expect(SERVER_VERSION).toBe(pkg.version);
  });
});
