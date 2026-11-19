import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { buildServer } from "./server.js";
import { Store, ApiError } from "./store.js";
import type { Authenticator, VenueGateway, PreparedPerp } from "./contracts.js";
const sol = "So11111111111111111111111111111111111111112";
const usdc = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const eth = "0x1234567890123456789012345678901234567890";
const token = "valid-user";
const headers = { authorization: `Bearer ${token}` };
const signature = "0x" + "1".repeat(130);
async function setup(t: test.TestContext, executionEnabled = true) {
  let time = Date.now(),
    dispatches = 0;
  const store = new Store();
  const auth: Authenticator = {
    verify: async (token) => {
      if (token !== "valid-user" && token !== "other-user")
        throw new ApiError(401, "invalid_token", "Invalid token");
      return {
        userId: "did:privy:" + token,
        wallets: [
          { address: sol, chain: "solana" },
          { address: eth, chain: "ethereum" },
        ],
      };
    },
  };
  const venues: VenueGateway = {
    quoteSpot: async (input) => ({
      ...input,
      inAmount: input.amount,
      outAmount: "1000000",
      minOutAmount: "990000",
      priceImpactPct: 0.01,
      routeLabels: ["Meteora"],
      raw: {},
    }),
    spotNotionalUsd: async () => 10,
    prepareSpot: async () => ({
      transactionBase64: "unsigned-demo-transaction",
      lastValidBlockHeight: 100,
    }),
    submitSpot: async () => {
      dispatches++;
      return { reference: "test-signature", status: "submitted" };
    },
    spotStatus: async (ref) => ({ reference: ref, status: "confirmed" }),
    perpNotionalUsd: async (prepared) => prepared.notionalUsd,
    preparePerp: async (input, cloid, nonce) => ({
      action: { ...input },
      nonce,
      expiresAfter: nonce + 30000,
      typedData: {},
      cloid,
      notionalUsd: Number(input.limitPrice) * Number(input.size),
    }),
    submitPerp: async (prepared) => {
      dispatches++;
      return { reference: prepared.cloid, status: "resting" };
    },
    perpStatus: async (_wallet, cloid) => ({
      reference: cloid,
      status: "filled",
    }),
    portfolio: async (wallet) => ({ wallet, assets: [] }),
    markets: async () => ({ source: "mock" }),
  };
  const app = await buildServer({
    store,
    auth,
    venues,
    executionEnabled,
    now: () => time,
  });
  t.after(() => app.close());
  return {
    app,
    store,
    venues,
    setTime: (v: number) => {
      time = v;
    },
    now: () => time,
    dispatches: () => dispatches,
  };
}
const perp = {
  walletAddress: eth,
  symbol: "BTC",
  side: "buy",
  size: "0.001",
  limitPrice: "50000",
  reduceOnly: false,
};
const postPerp = async (
  app: Awaited<ReturnType<typeof buildServer>>,
  body = perp,
  key = randomUUID(),
) =>
  app.inject({
    method: "POST",
    url: "/v1/orders/perp",
    headers: { ...headers, "idempotency-key": key },
    payload: body,
  });

test("health public; protected routes fail closed; token and wallet identity are server-derived", async (t) => {
  const { app } = await setup(t);
  assert.equal((await app.inject("/health")).statusCode, 200);
  assert.equal((await app.inject("/v1/me")).statusCode, 401);
  assert.equal(
    (
      await app.inject({
        url: "/v1/me",
        headers: { authorization: "Bearer fake" },
      })
    ).statusCode,
    401,
  );
  const me = await app.inject({ url: "/v1/me", headers });
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().userId, "did:privy:valid-user");
  const foreign = await app.inject({
    method: "POST",
    url: "/v1/quotes/spot",
    headers,
    payload: {
      walletAddress: "11111111111111111111111111111111",
      inputMint: sol,
      outputMint: usdc,
      amount: "1",
      slippageBps: 50,
    },
  });
  assert.equal(foreign.statusCode, 403);
});
test("strict spot validation, slippage policy and risk valuation apply before preparation", async (t) => {
  const { app, venues } = await setup(t);
  const payload = {
    walletAddress: sol,
    inputMint: sol,
    outputMint: usdc,
    amount: "1000000",
    slippageBps: 50,
  };
  for (const amount of ["0", "-1", "1.1", "1e5", "18446744073709551616"])
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/v1/quotes/spot",
          headers,
          payload: { ...payload, amount },
        })
      ).statusCode,
      400,
    );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/v1/quotes/spot",
        headers,
        payload: { ...payload, slippageBps: 101 },
      })
    ).statusCode,
    403,
  );
  venues.spotNotionalUsd = async () => NaN;
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/v1/quotes/spot",
        headers,
        payload,
      })
    ).statusCode,
    422,
  );
});
test("spot quote is immutable, owned, single-use and expires; unknown fields are rejected", async (t) => {
  const { app, now, setTime } = await setup(t);
  const quote = await app.inject({
    method: "POST",
    url: "/v1/quotes/spot",
    headers,
    payload: {
      walletAddress: sol,
      inputMint: sol,
      outputMint: usdc,
      amount: "1000000",
      slippageBps: 50,
    },
  });
  assert.equal(quote.statusCode, 201);
  const quoteId = quote.json().id;
  const request = {
    method: "POST" as const,
    url: "/v1/orders/spot",
    headers: { ...headers, "idempotency-key": randomUUID() },
    payload: { quoteId },
  };
  const a = await app.inject(request);
  assert.equal(a.statusCode, 201);
  const duplicate = await app.inject({
    ...request,
    headers: { ...headers, "idempotency-key": randomUUID() },
  });
  assert.equal(duplicate.statusCode, 409);
  const other = await app.inject({
    ...request,
    headers: {
      authorization: "Bearer other-user",
      "idempotency-key": randomUUID(),
    },
  });
  assert.equal(other.statusCode, 404);
  assert.equal(
    (await app.inject({ ...request, payload: { quoteId, notionalCents: 1 } }))
      .statusCode,
    400,
  );
  setTime(now() + 31000);
  const next = await app.inject({
    ...request,
    headers: { ...headers, "idempotency-key": randomUUID() },
  });
  assert.equal(next.statusCode, 409);
});
test("idempotency returns same intent, rejects mismatched bodies and requires header", async (t) => {
  const { app } = await setup(t);
  const key = randomUUID();
  const a = await postPerp(app, perp, key);
  const b = await postPerp(app, perp, key);
  assert.equal(a.statusCode, 201);
  assert.equal(a.json().id, b.json().id);
  assert.equal(
    (await postPerp(app, { ...perp, size: "0.0001" }, key)).statusCode,
    409,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/v1/orders/perp",
        headers,
        payload: perp,
      })
    ).statusCode,
    400,
  );
});
test("reservations enforce daily limits under parallel requests", async (t) => {
  const { app } = await setup(t);
  await app.inject({
    method: "PATCH",
    url: "/v1/risk",
    headers,
    payload: { maxOrderCents: 6000, dailyLimitCents: 6000 },
  });
  const responses = await Promise.all([postPerp(app), postPerp(app)]);
  assert.deepEqual(responses.map((r) => r.statusCode).sort(), [201, 403]);
});
test("kill blocks entries, permits reduce-only perps, and is rechecked at submission", async (t) => {
  const { app, dispatches } = await setup(t);
  const order = (await postPerp(app)).json();
  await app.inject({
    method: "PATCH",
    url: "/v1/risk",
    headers,
    payload: { killed: true },
  });
  assert.equal((await postPerp(app)).statusCode, 403);
  assert.equal(
    (await postPerp(app, { ...perp, reduceOnly: true })).statusCode,
    201,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `/v1/orders/${order.id}/submit`,
        headers,
        payload: { signature },
      })
    ).statusCode,
    403,
  );
  assert.equal(dispatches(), 0);
});
test("agent budget is scoped by owner, wallet, venue, activation and lifetime reservation", async (t) => {
  const { app } = await setup(t);
  const created = await app.inject({
    method: "POST",
    url: "/v1/agents",
    headers,
    payload: {
      name: "Scout",
      walletAddress: eth,
      venue: "hyperliquid",
      budgetCents: 6000,
      maxOrderCents: 5000,
    },
  });
  assert.equal(created.statusCode, 201);
  const agentId = created.json().id;
  assert.equal(
    (await postPerp(app, { ...perp, agentId } as typeof perp)).statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        method: "PATCH",
        url: `/v1/agents/${agentId}`,
        headers,
        payload: { enabled: true },
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (await postPerp(app, { ...perp, agentId } as typeof perp)).statusCode,
    201,
  );
  assert.equal(
    (await postPerp(app, { ...perp, agentId } as typeof perp)).statusCode,
    403,
  );
  const foreign = await app.inject({
    method: "PATCH",
    url: `/v1/agents/${agentId}`,
    headers: { authorization: "Bearer other-user" },
    payload: { enabled: false },
  });
  assert.equal(foreign.statusCode, 404);
});
test("dispatch is single-shot on repeated and concurrent submits; reconcile tracks fill", async (t) => {
  const { app, dispatches } = await setup(t);
  const id = (await postPerp(app)).json().id;
  const request = {
    method: "POST" as const,
    url: `/v1/orders/${id}/submit`,
    headers,
    payload: { signature },
  };
  const rs = await Promise.all([app.inject(request), app.inject(request)]);
  assert.equal(rs[0].statusCode, 200);
  assert.equal(rs[1].statusCode, 200);
  assert.equal(dispatches(), 1);
  const reconcile = await app.inject({
    method: "POST",
    url: `/v1/orders/${id}/reconcile`,
    headers,
  });
  assert.equal(reconcile.json().status, "filled");
  assert.equal(
    (
      await app.inject({
        ...request,
        payload: { signature: "0x" + "2".repeat(130) },
      })
    ).statusCode,
    409,
  );
});
test("uncertain network dispatch stays reserved and never auto-retries", async (t) => {
  const { app, venues, store } = await setup(t);
  let attempts = 0;
  venues.submitPerp = async () => {
    attempts++;
    throw Error("network unavailable");
  };
  const id = (await postPerp(app)).json().id;
  const request = {
    method: "POST" as const,
    url: `/v1/orders/${id}/submit`,
    headers,
    payload: { signature },
  };
  assert.equal((await app.inject(request)).statusCode, 502);
  assert.equal(store.order("did:privy:valid-user", id).status, "unknown");
  assert.equal((await app.inject(request)).statusCode, 200);
  assert.equal(attempts, 1);
});
test("execution disabled, expired and canceled intents never dispatch", async (t) => {
  const { app, dispatches, now, setTime } = await setup(t, false);
  const id = (await postPerp(app)).json().id;
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `/v1/orders/${id}/submit`,
        headers,
        payload: { signature },
      })
    ).statusCode,
    503,
  );
  assert.equal(dispatches(), 0);
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `/v1/orders/${id}/cancel`,
        headers,
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `/v1/orders/${id}/submit`,
        headers,
        payload: { signature },
      })
    ).statusCode,
    409,
  );
  const next = (await postPerp(app)).json().id;
  setTime(now() + 31000);
  const status = await app.inject({ url: `/v1/orders/${next}`, headers });
  assert.equal(status.json().status, "expired");
});
test("cross-user orders, audit and portfolios are isolated", async (t) => {
  const { app } = await setup(t);
  const id = (await postPerp(app)).json().id;
  const other = { authorization: "Bearer other-user" };
  assert.equal(
    (await app.inject({ url: `/v1/orders/${id}`, headers: other })).statusCode,
    404,
  );
  assert.equal(
    (await app.inject({ url: "/v1/orders", headers: other })).json().orders
      .length,
    0,
  );
  assert.equal(
    (await app.inject({ url: "/v1/audit", headers: other })).json().events
      .length,
    0,
  );
  const foreign = await app.inject({
    url: "/v1/portfolio?chain=ethereum&walletAddress=0x2222222222222222222222222222222222222222",
    headers,
  });
  assert.equal(foreign.statusCode, 403);
});
test("durable SQLite store recovers interrupted dispatch as unknown after restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "orbit-test-"));
  const path = join(dir, "db.sqlite");
  try {
    let store = new Store(path);
    const userId = "did:privy:restart";
    store.ensureUser(userId);
    const id = randomUUID(),
      time = Date.now();
    store.reserve(
      {
        id,
        userId,
        walletAddress: eth,
        venue: "hyperliquid",
        reduceOnly: false,
        notionalCents: 100,
        prepared: {} as PreparedPerp,
        idempotencyKey: randomUUID(),
        fingerprint: "x",
        createdAt: time,
        expiresAt: time + 30000,
        status: "prepared",
      },
      time,
    );
    assert.equal(store.claim(userId, id, "hash", "ref", time).dispatch, true);
    store.close();
    store = new Store(path);
    assert.equal(store.order(userId, id).status, "unknown");
    assert.equal(store.claim(userId, id, "hash", "ref", time).dispatch, false);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
