import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { cleanMessage, decodeEntities, pick, toInt } from "../src/dolibarr/shape.js";
import { flattenRights, shapeWhoami } from "../src/tools/core.js";

describe("shape helpers", () => {
  it("decodes named and numeric entities", () => {
    expect(decodeEntities("A &amp; B &#039;x&#x27; &lt;1&gt; &unknown;")).toBe(
      "A & B 'x' <1> &unknown;",
    );
  });

  it("cleans HTML messages", () => {
    expect(cleanMessage("Lot <b>L1</b> &amp; L2<br />  done")).toBe("Lot L1 & L2\n done");
  });

  it("normalises ids", () => {
    expect(toInt("12")).toBe(12);
    expect(toInt(12)).toBe(12);
    expect(toInt("12a")).toBeNull();
    expect(toInt(null)).toBeNull();
  });

  it("picks only filled fields", () => {
    expect(pick({ a: 1, b: null, c: "", d: 0 }, ["a", "b", "c", "d", "e"])).toEqual({
      a: 1,
      d: 0,
    });
  });
});

describe("whoami shaping", () => {
  it("flattens rights and skips switched-off ones", () => {
    expect(
      flattenRights({
        commande: { lire: 1, creer: 0, order_advance: { validate: 1 } },
        stock: { mouvement: { creer: "1" } },
      }),
    ).toEqual(["commande.lire", "commande.order_advance.validate", "stock.mouvement.creer"]);
  });

  it("returns a compact user", () => {
    const shaped = shapeWhoami(
      {
        id: "3",
        login: "amy",
        lastname: "Lee",
        email: "",
        admin: "0",
        pass_crypted: "should-not-leak",
        user_group_list: [{ id: "2", name: "Sales" }],
      },
      { success: { code: 200, dolibarr_version: "22.0.2" } },
      "Test",
    );
    expect(shaped).toEqual({
      site: "Test",
      dolibarr_version: "22.0.2",
      user: { id: 3, login: "amy", lastname: "Lee", admin: false },
      groups: ["Sales"],
    });
  });
});

describe("config", () => {
  it("applies defaults and trims the URL", () => {
    const config = loadConfig({ DOLIBARR_URL: "https://dolibarr.example.test//" });
    expect(config.dolibarrUrl).toBe("https://dolibarr.example.test");
    expect(config.toolsets).toContain("core");
    expect(config.toolsets).toContain("agenda");
    expect(config.siteName).toBe("Dolibarr");
    expect(config.port).toBe(3900);
    expect(config.writeMode).toBe("guarded");
  });

  it("rejects an unknown toolset", () => {
    expect(() =>
      loadConfig({ DOLIBARR_URL: "https://dolibarr.example.test", DOLIBARR_TOOLSETS: "core,nope" }),
    ).toThrow(/DOLIBARR_TOOLSETS/);
  });

  it("always includes core", () => {
    const config = loadConfig({ DOLIBARR_URL: "https://dolibarr.example.test", DOLIBARR_TOOLSETS: "sales, invoices" });
    expect(config.toolsets).toEqual(["core", "sales", "invoices"]);
  });
});
