import { describe, expect, it, vi } from "vitest";
import { DolibarrApiError, DolibarrClient } from "../src/dolibarr/client.js";

function clientWith(reply: { status: number; body: string }) {
  const fetchImpl = vi.fn(
    async (_url: URL | RequestInfo, _init?: RequestInit) =>
      new Response(reply.body, { status: reply.status }),
  );
  const client = new DolibarrClient({
    baseUrl: "https://dolibarr.example.test/",
    apiKey: "k-123",
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  return { client, fetchImpl };
}

describe("DolibarrClient", () => {
  it("sends the key as a header and builds the API URL", async () => {
    const { client, fetchImpl } = clientWith({ status: 200, body: '{"id":"7"}' });
    const result = await client.get("users/info", {
      includepermissions: 1,
      skipped: undefined,
    });
    expect(result).toEqual({ id: "7" });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://dolibarr.example.test/api/index.php/users/info?includepermissions=1",
    );
    expect((init!.headers as Record<string, string>).DOLAPIKEY).toBe("k-123");
    expect(String(url)).not.toContain("k-123");
    expect(init!.body).toBeUndefined();
  });

  it("gives a body-less POST the notrigger body Restler needs", async () => {
    const { client, fetchImpl } = clientWith({ status: 200, body: "{}" });
    await client.post("/orders/5/validate");
    expect(fetchImpl.mock.calls[0]![1]!.body).toBe('{"notrigger":0}');
  });

  it("turns a Dolibarr error into a readable error with a hint", async () => {
    const { client } = clientWith({
      status: 403,
      body: '{"error":{"code":403,"message":"Forbidden: Right stock-&gt;creer required"}}',
    });
    const error = await client.post("/stockmovements").catch((e) => e);
    expect(error).toBeInstanceOf(DolibarrApiError);
    expect(error.status).toBe(403);
    expect(error.message).toBe("Forbidden: Right stock->creer required");
    expect(error.toAgentText()).toContain("Do not retry");
    expect(error.toAgentText()).toContain("POST /stockmovements");
  });

  it("keeps Dolibarr's error details, which say why", async () => {
    const { client } = clientWith({
      status: 500,
      body: '{"error":{"code":500,"message":"Internal Server Error: Error creating thirdparty","0":"","1":"ErrorCustomerCodeRequired","2":"Name is wrong","3":["Name is wrong"]}}',
    });
    const error = await client.post("/thirdparties", { name: "X" }).catch((e) => e);
    expect(error.message).toBe(
      "Internal Server Error: Error creating thirdparty: Customer code required (ErrorCustomerCodeRequired); Name is wrong",
    );
  });

  it("copes with an error page that is not JSON", async () => {
    const { client } = clientWith({
      status: 500,
      body: "<html><body><b>Fatal</b> error<br>line 2</body></html>",
    });
    const error = await client.get("/products/1").catch((e) => e);
    expect(error.status).toBe(500);
    expect(error.message).toBe("Fatal error\nline 2");
  });

  it("reports an unreachable Dolibarr as status 0", async () => {
    const client = new DolibarrClient({
      baseUrl: "https://dolibarr.example.test",
      apiKey: "k",
      fetchImpl: (async () => {
        throw new Error("connect ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    const error = await client.get("/status").catch((e) => e);
    expect(error.status).toBe(0);
    expect(error.message).toContain("ECONNREFUSED");
  });
});
