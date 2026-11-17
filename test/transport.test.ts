import { createServer, type Server } from "node:net";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DolibarrClient, parseReply } from "../src/dolibarr/client.js";

const NOTICE =
  '<br />\n<b>Warning</b>:  Undefined property: stdClass::$label in <b>/var/www/htdocs/api_orders.class.php</b> on line <b>438</b><br />\n';

/** A raw TCP server, to send replies a normal HTTP server would refuse to send. */
let server: Server;
let base: string;
const replies: Record<string, string> = {
  "/api/index.php/notice": `HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Type: application/json\r\n\r\n${NOTICE}${NOTICE}42`,
  "/api/index.php/hidden-error": `HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Type: application/json\r\n\r\n${NOTICE}{"error":{"code":403,"message":"Forbidden: not allowed"}}`,
  "/api/index.php/not-modified": `HTTP/1.1 304 Not Modified\r\nConnection: close\r\nContent-Type: application/json\r\n\r\n{"error":{"code":304,"message":"Not Modified: already closed"}}`,
};

beforeAll(async () => {
  server = createServer((socket) => {
    socket.once("data", (data) => {
      const path = String(data).split(" ")[1] ?? "";
      socket.end(replies[path] ?? "HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe("reply parsing", () => {
  it("drops PHP notices printed in front of the JSON", () => {
    expect(parseReply(`${NOTICE}{"id":5}`)).toEqual({ id: 5 });
    expect(parseReply("[1,2]")).toEqual([1, 2]);
    expect(parseReply("")).toBeNull();
    expect(parseReply("<html>oops</html>")).toBeUndefined();
  });
});

describe("node transport", () => {
  const client = () => new DolibarrClient({ baseUrl: base, apiKey: "k", timeoutMs: 3000 });

  it("reads a reply that starts with notices and has no length", async () => {
    expect(await client().post("/notice", {})).toBe(42);
  });

  it("turns an error hidden behind status 200 into an error", async () => {
    await expect(client().get("/hidden-error")).rejects.toMatchObject({ status: 403, message: "Forbidden: not allowed" });
  });

  it("copes with a 304 that carries a body", async () => {
    const error = await client().post("/not-modified", {}).catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 304 });
    expect((error as { toAgentText(): string }).toAgentText()).toContain("Nothing was changed");
  });
});
