import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { loadConfig } from "../src/config.js";
import { DolibarrApiError, DolibarrClient } from "../src/dolibarr/client.js";
import { defined, toArrayOptions, toUnix, writeTool } from "../src/tools/helpers.js";

const config = loadConfig({ DOLIBARR_URL: "https://dolibarr.example.test" });
const api = new DolibarrClient({ baseUrl: "https://dolibarr.example.test", apiKey: "k" });

type Registered = Record<
  string,
  { annotations?: Record<string, unknown>; handler: (args: unknown, extra: unknown) => Promise<{ isError?: boolean; content: Array<{ text: string }> }> }
>;
const toolsOf = (server: McpServer): Registered => (server as unknown as { _registeredTools: Registered })._registeredTools;

function setup(canWrite: boolean, guarded: boolean) {
  const server = new McpServer({ name: "t", version: "0" });
  const handler = vi.fn(async (args: { id: number }) => ({ done: args.id }));
  const preview = vi.fn(async (args: { id: number }) => ({ order: `SO-${args.id}` }));
  writeTool(server, { config, api, canWrite }, "dolibarr_test_write", { title: "T", description: "Test.", input: { id: z.number() }, guarded }, handler, preview);
  return { tool: toolsOf(server).dolibarr_test_write, handler, preview };
}

const call = async (tool: Registered[string], args: unknown) => {
  const result = await tool.handler(args, {});
  return { isError: result.isError === true, text: result.content[0]!.text };
};

describe("write tools", () => {
  it("do not exist on a read-only connection", () => {
    expect(setup(false, true).tool).toBeUndefined();
    expect(setup(false, false).tool).toBeUndefined();
  });

  it("a guarded tool only previews until confirmed", async () => {
    const { tool, handler, preview } = setup(true, true);
    expect(tool!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    const first = await call(tool!, { id: 7 });
    expect(first.isError).toBe(false);
    expect(JSON.parse(first.text)).toMatchObject({ preview: true, nothing_changed: true, would_do: { order: "SO-7" } });
    expect(preview).toHaveBeenCalledOnce();
    expect(handler).not.toHaveBeenCalled();
  });

  it("a guarded tool needs a reason with the confirmation", async () => {
    const { tool, handler } = setup(true, true);
    const noReason = await call(tool!, { id: 7, confirm: true });
    expect(noReason.isError).toBe(true);
    expect(noReason.text).toContain("reason");
    expect(handler).not.toHaveBeenCalled();

    const done = await call(tool!, { id: 7, confirm: true, reason: "user asked" });
    expect(JSON.parse(done.text)).toEqual({ done: 7 });
    // confirm and reason are not passed on to Dolibarr.
    expect(handler).toHaveBeenCalledWith({ id: 7 });
  });

  it("an unguarded tool runs straight away and is not marked destructive", async () => {
    const { tool, handler } = setup(true, false);
    expect(tool!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(JSON.parse((await call(tool!, { id: 3 })).text)).toEqual({ done: 3 });
    expect(handler).toHaveBeenCalledOnce();
  });

  it("a Dolibarr refusal during the preview reaches the agent as an error", async () => {
    const server = new McpServer({ name: "t", version: "0" });
    writeTool(
      server,
      { config, api, canWrite: true },
      "dolibarr_test_refused",
      { title: "T", description: "Test.", input: {}, guarded: true },
      async () => ({}),
      async () => {
        throw new DolibarrApiError(409, "Order is not validated", "GET", "/orders/1");
      },
    );
    const result = await call(toolsOf(server).dolibarr_test_refused!, {});
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Order is not validated");
  });

  it("a guarded tool cannot define its own confirm input", () => {
    const server = new McpServer({ name: "t", version: "0" });
    expect(() =>
      writeTool(server, { config, api, canWrite: true }, "dolibarr_bad", { title: "T", description: "T.", input: { confirm: z.boolean() }, guarded: true }, async () => ({})),
    ).toThrow(/confirm/);
  });
});

describe("body helpers", () => {
  it("converts dates, custom fields and drops undefined", () => {
    expect(toUnix("2026-11-20")).toBe(1795132800);
    expect(toUnix(undefined)).toBeUndefined();
    expect(() => toUnix("20/11/2026")).toThrow(/YYYY-MM-DD/);
    expect(toArrayOptions({ region: 1, options_x: "y" })).toEqual({ options_region: 1, options_x: "y" });
    expect(toArrayOptions({})).toBeUndefined();
    expect(defined({ a: 1, b: undefined, c: null })).toEqual({ a: 1, c: null });
  });
});
