import { afterEach, describe, expect, test } from "bun:test";
import { Flovia } from "../src/index";

describe("Flovia agent SDK client", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("throws error if secret is missing", () => {
    expect(() => new Flovia({ secret: "" } as any)).toThrow("missing 'secret'");
  });

  test("initializes with default testnet options", () => {
    const client = new Flovia({
      secret: "SDJKSDFJKLSDJFKSDJFKLSDJFKLSDJFKLSDJFKLSDJFKLSDJFKLSDJ",
    });
    expect(client).toBeInstanceOf(Flovia);
  });

  test("normalizes bffUrl by stripping trailing slash", () => {
    const client = new Flovia({
      secret: "SDJKSDFJKLSDJFKSDJFKLSDJFKLSDJFKLSDJFKLSDJFKLSDJFKLSDJ",
      bffUrl: "http://localhost:3001/",
    });
    expect((client as any).bffUrl).toBe("http://localhost:3001");
  });

  test("discover fetches provider catalog from BFF", async () => {
    const mockProviders = [
      {
        id: "1",
        name: "Test Provider",
        endpoint: "http://localhost:5402/api/rate",
        destination: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
        category: "rates",
        active: true,
      },
    ];

    globalThis.fetch = (async (url: string | URL | Request) => {
      expect(String(url)).toBe("http://localhost:3001/stellar/providers");
      return new Response(JSON.stringify(mockProviders), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as any;

    const client = new Flovia({
      secret: "SDJKSDFJKLSDJFKSDJFKLSDJFKLSDJFKLSDJFKLSDJFKLSDJFKLSDJ",
    });

    const res = await client.discover();
    expect(res).toEqual(mockProviders as any);
  });

  test("recommend formats query params and returns ranked providers", async () => {
    const mockRanked = [
      {
        provider: {
          id: "1",
          name: "Test Provider",
          endpoint: "http://localhost:5402/api/rate",
        },
        trustScore: { score: 85 },
        matchScore: 0.95,
        reasons: ["Category match"],
      },
    ];

    globalThis.fetch = (async (url: string | URL | Request) => {
      const urlStr = String(url);
      expect(urlStr).toContain("/stellar/recommend");
      expect(urlStr).toContain("category=rates");
      expect(urlStr).toContain("maxPriceUsdc=0.01");
      return new Response(JSON.stringify(mockRanked), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as any;

    const client = new Flovia({
      secret: "SDJKSDFJKLSDJFKSDJFKLSDJFKLSDJFKLSDJFKLSDJFKLSDJFKLSDJ",
    });

    const res = await client.recommend({ category: "rates", maxPriceUsdc: 0.01 });
    expect(res).toEqual(mockRanked as any);
  });

  test("throws descriptive error when BFF responds with an error status", async () => {
    globalThis.fetch = (async () => {
      return new Response("Internal Server Error", { status: 500 });
    }) as any;

    const client = new Flovia({
      secret: "SDJKSDFJKLSDJFKSDJFKLSDJFKLSDJFKLSDJFKLSDJFKLSDJFKLSDJ",
    });

    expect(client.discover()).rejects.toThrow("Flovia.discover: BFF respondió 500");
  });
});
