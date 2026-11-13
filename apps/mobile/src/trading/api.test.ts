import test from "node:test";
import assert from "node:assert/strict";
import { TradingApi } from "./api";
test("API client fails closed without Privy session and never fetches", async () => {
  let called = false;
  const api = new TradingApi(
    async () => null,
    "https://backend.example",
    async () => {
      called = true;
      return new Response("{}");
    },
  );
  await assert.rejects(api.request("/v1/me"), /Privy/);
  assert.equal(called, false);
});
test("API client forwards fresh bearer and stable idempotency key without logging either", async () => {
  let tokenCalls = 0;
  const api = new TradingApi(
    async () => {
      tokenCalls++;
      return "test-session";
    },
    "https://backend.example/",
    async (input, init) => {
      assert.equal(input, "https://backend.example/v1/orders/spot");
      assert.equal(
        (init?.headers as Record<string, string>).Authorization,
        "Bearer test-session",
      );
      assert.equal(
        (init?.headers as Record<string, string>)["Idempotency-Key"],
        "same-order-idempotency-key",
      );
      assert.deepEqual(JSON.parse(String(init?.body)), { quoteId: "quote" });
      return new Response('{"id":"order"}');
    },
  );
  assert.equal(
    (
      await api.request<{ id: string }>(
        "/v1/orders/spot",
        "POST",
        { quoteId: "quote" },
        "same-order-idempotency-key",
      )
    ).id,
    "order",
  );
  assert.equal(tokenCalls, 1);
});
test("API client surfaces server rejection, invalid JSON and ambiguous connection outcomes", async () => {
  const make = (fetcher: typeof fetch) =>
    new TradingApi(async () => "session", "https://backend.example", fetcher);
  await assert.rejects(
    make(
      async () => new Response('{"message":"Risk limit"}', { status: 403 }),
    ).request("/v1/orders"),
    /Risk limit/,
  );
  await assert.rejects(
    make(async () => new Response("bad")).request("/v1/orders"),
    /inválida/,
  );
  await assert.rejects(
    make(async () => {
      throw Error("network");
    }).request("/v1/orders"),
    /Não repita/,
  );
  await assert.rejects(
    make(async () => new Response("{}")).request("https://elsewhere.example"),
    /Invalid API route/,
  );
});
