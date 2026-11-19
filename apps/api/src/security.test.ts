import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { buildServer } from "./server.js";
import { ApiError, Store } from "./store.js";
import { createVenueGateway, VenueError } from "./venues.js";
import type {
  Authenticator,
  SubmitResult,
  VenueGateway,
  Wallet,
} from "./contracts.js";

// Everything in this file is local: Fastify.inject, in-memory SQLite, mock gateways,
// and deterministic offline signatures. No provider transaction/order is broadcast.
const alice = "did:privy:alice";
const bob = "did:privy:bob";
const eth = "0x1234567890abcdef1234567890abcdef12345678";
const otherEth = "0x2222222222222222222222222222222222222222";
const signer = Keypair.fromSeed(new Uint8Array(32).fill(7));
const sol = signer.publicKey.toBase58();
const usdc = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const wsol = "So11111111111111111111111111111111111111112";
const signature = "0x" + "1".repeat(130);
const headers = { authorization: "Bearer alice" };
const bobHeaders = { authorization: "Bearer bob" };
const perp = {
  walletAddress: eth,
  symbol: "BTC",
  side: "buy" as const,
  size: "0.001",
  limitPrice: "50000",
  reduceOnly: false,
};
const spot = {
  walletAddress: sol,
  inputMint: wsol,
  outputMint: usdc,
  amount: "1000000",
  slippageBps: 50,
};
const transaction = new VersionedTransaction(
  new TransactionMessage({
    payerKey: signer.publicKey,
    recentBlockhash: PublicKey.default.toBase58(),
    instructions: [
      SystemProgram.transfer({
        fromPubkey: signer.publicKey,
        toPubkey: Keypair.fromSeed(new Uint8Array(32).fill(8)).publicKey,
        lamports: 1,
      }),
    ],
  }).compileToV0Message(),
);
const unsigned = Buffer.from(transaction.serialize()).toString("base64");
transaction.sign([signer]);
const signed = Buffer.from(transaction.serialize()).toString("base64");
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
async function setup(t: test.TestContext) {
  let time = Date.now();
  let dispatches = 0;
  let aliceWallets: Wallet[] = [
    { address: sol, chain: "solana" },
    { address: eth, chain: "ethereum" },
  ];
  const store = new Store();
  const auth: Authenticator = {
    verify: async (token) => {
      if (!["alice", "bob"].includes(token))
        throw new ApiError(401, "invalid_token", "Invalid authentication.");
      return {
        userId: token === "alice" ? alice : bob,
        wallets:
          token === "alice"
            ? aliceWallets
            : [{ address: otherEth, chain: "ethereum" }],
      };
    },
  };
  const venues: VenueGateway = {
    quoteSpot: async (input) => ({
      inputMint: input.inputMint,
      outputMint: input.outputMint,
      inAmount: input.amount,
      outAmount: "10000000",
      minOutAmount: "9950000",
      slippageBps: input.slippageBps,
      priceImpactPct: 0,
      routeLabels: ["mock"],
      raw: {},
    }),
    spotNotionalUsd: async () => 10,
    prepareSpot: async () => ({
      transactionBase64: unsigned,
      lastValidBlockHeight: 100,
    }),
    submitSpot: async () => {
      dispatches++;
      return { reference: "1".repeat(64), status: "submitted" };
    },
    spotStatus: async (reference) => ({ reference, status: "unknown" }),
    perpNotionalUsd: async (prepared) => prepared.notionalUsd,
    preparePerp: async (input, cloid, nonce) => ({
      action: { ...input },
      nonce,
      expiresAfter: nonce + 60_000,
      typedData: {},
      cloid,
      notionalUsd: 50,
    }),
    submitPerp: async (prepared) => {
      dispatches++;
      return { reference: prepared.cloid, status: "resting" };
    },
    perpStatus: async (_wallet, cloid) => ({
      reference: cloid,
      status: "unknown",
    }),
    portfolio: async (wallet) => ({ wallet, assets: [] }),
    markets: async () => ({ source: "mock" }),
  };
  const app = await buildServer({
    store,
    auth,
    venues,
    executionEnabled: true,
    now: () => time,
  });
  t.after(() => app.close());
  const postPerp = (
    body = perp,
    idempotencyKey = randomUUID(),
    authHeaders = headers,
  ) =>
    app.inject({
      method: "POST",
      url: "/v1/orders/perp",
      headers: { ...authHeaders, "idempotency-key": idempotencyKey },
      payload: body,
    });
  const quote = () =>
    app.inject({
      method: "POST",
      url: "/v1/quotes/spot",
      headers,
      payload: spot,
    });
  const prepareSpot = (quoteId: string, agentId?: string) =>
    app.inject({
      method: "POST",
      url: "/v1/orders/spot",
      headers: { ...headers, "idempotency-key": randomUUID() },
      payload: { quoteId, ...(agentId ? { agentId } : {}) },
    });
  const submit = (
    id: string,
    payload: { signature?: string; signedTransactionBase64?: string } = {
      signature,
    },
    authHeaders = headers,
  ) =>
    app.inject({
      method: "POST",
      url: `/v1/orders/${id}/submit`,
      headers: authHeaders,
      payload,
    });
  const reconcile = (id: string, authHeaders = headers) =>
    app.inject({
      method: "POST",
      url: `/v1/orders/${id}/reconcile`,
      headers: authHeaders,
    });
  const cancel = (id: string, authHeaders = headers) =>
    app.inject({
      method: "POST",
      url: `/v1/orders/${id}/cancel`,
      headers: authHeaders,
    });
  const risk = (payload: Record<string, unknown>) =>
    app.inject({ method: "PATCH", url: "/v1/risk", headers, payload });
  return {
    app,
    store,
    auth,
    venues,
    postPerp,
    quote,
    prepareSpot,
    submit,
    reconcile,
    cancel,
    risk,
    now: () => time,
    setTime: (value: number) => {
      time = value;
    },
    dispatches: () => dispatches,
    setWallets: (wallets: Wallet[]) => {
      aliceWallets = wallets;
    },
  };
}

test("security: browser policy permits documented Privy resources without arbitrary scripts", async (t) => {
  const s = await setup(t);
  const r = await s.app.inject({ url: "/health" });
  const policy = String(r.headers["content-security-policy"]);
  assert.match(policy, /script-src 'self' https:\/\/challenges.cloudflare.com/);
  assert.ok(policy.includes("https://auth.privy.io"));
  assert.ok(policy.includes("object-src 'none'"));
  assert.ok(!policy.match(/script-src[^;]*'unsafe-inline'/));
});
test("security: rising perp mid blocks a prepared intent before dispatch", async (t) => {
  const s = await setup(t);
  await s.risk({ maxOrderCents: 6000 });
  const order = (await s.postPerp()).json();
  s.venues.perpNotionalUsd = async () => 75;
  const r = await s.submit(order.id);
  assert.equal(r.statusCode, 403);
  assert.equal(s.dispatches(), 0);
});
test("security: policy tightened during current-valuation lookup is rechecked before dispatch", async (t) => {
  const s = await setup(t);
  const order = (await s.postPerp()).json();
  s.venues.perpNotionalUsd = async () => {
    await s.risk({ killed: true });
    return 50;
  };
  const r = await s.submit(order.id);
  assert.equal(r.statusCode, 403);
  assert.equal(s.dispatches(), 0);
});

test("security: same-millisecond orders receive wallet-scoped distinct nonces and cloids", async (t) => {
  const s = await setup(t);
  const responses = await Promise.all([
    s.postPerp(),
    s.postPerp(),
    s.postPerp(),
  ]);
  assert.deepEqual(
    responses.map((r) => r.statusCode),
    [201, 201, 201],
  );
  const orders = responses.map((r) => r.json());
  assert.equal(new Set(orders.map((o) => o.prepared.nonce)).size, 3);
  assert.equal(new Set(orders.map((o) => o.prepared.cloid)).size, 3);
  assert.deepEqual(orders.map((o) => o.prepared.nonce).sort(), [
    s.now(),
    s.now() + 1,
    s.now() + 2,
  ]);
  const key = randomUUID();
  const first = await s.postPerp(perp, key);
  const retry = await s.postPerp(perp, key);
  assert.deepEqual(
    retry.json(),
    first.json(),
    "an idempotent retry must retain the original signing payload",
  );
});

test("security: nonce sequence survives restart, EVM case changes and a modest clock rollback", () => {
  const dir = mkdtempSync(join(tmpdir(), "orbit-security-"));
  const path = join(dir, "nonces.sqlite");
  let store = new Store(path);
  try {
    const time = Date.now();
    assert.equal(store.nextNonce(eth, time), time);
    store.close();
    store = new Store(path);
    assert.equal(
      store.nextNonce("0x" + eth.slice(2).toUpperCase(), time),
      time + 1,
    );
    assert.equal(store.nextNonce(eth, time - 500), time + 2);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("security: order reads, mutation, reconciliation, audit and quotes are isolated by user", async (t) => {
  const s = await setup(t);
  const order = (await s.postPerp()).json();
  const q = (await s.quote()).json();
  for (const url of [`/v1/orders/${order.id}`, `/v1/orders/${randomUUID()}`]) {
    const response = await s.app.inject({ url, headers: bobHeaders });
    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.json(), {
      error: "not_found",
      message: "Order not found.",
    });
  }
  assert.equal(
    (await s.submit(order.id, { signature }, bobHeaders)).statusCode,
    404,
  );
  assert.equal((await s.reconcile(order.id, bobHeaders)).statusCode, 404);
  assert.equal((await s.cancel(order.id, bobHeaders)).statusCode, 404);
  const foreignQuote = await s.app.inject({
    method: "POST",
    url: "/v1/orders/spot",
    headers: { ...bobHeaders, "idempotency-key": randomUUID() },
    payload: { quoteId: q.id },
  });
  assert.equal(foreignQuote.statusCode, 404);
  assert.deepEqual(
    (await s.app.inject({ url: "/v1/orders", headers: bobHeaders })).json()
      .orders,
    [],
  );
  assert.deepEqual(
    (await s.app.inject({ url: "/v1/audit", headers: bobHeaders })).json()
      .events,
    [],
  );
  assert.equal(s.dispatches(), 0);
});

test("security: unlinking a wallet invalidates dispatch and reconciliation authorization", async (t) => {
  const s = await setup(t);
  const first = (await s.postPerp()).json();
  const second = (await s.postPerp()).json();
  await s.submit(second.id);
  s.setWallets([{ address: sol, chain: "solana" }]);
  assert.equal((await s.submit(first.id)).statusCode, 403);
  assert.equal((await s.reconcile(second.id)).statusCode, 403);
  assert.equal(
    (
      await s.app.inject({
        url: `/v1/portfolio?walletAddress=${eth}&chain=ethereum`,
        headers,
      })
    ).statusCode,
    403,
  );
  assert.equal(s.dispatches(), 1);
});

test("security: policy changed while prepare is awaiting a provider is rechecked atomically", async (t) => {
  const s = await setup(t);
  const started = deferred<void>();
  const release = deferred<void>();
  const prepare = s.venues.preparePerp;
  s.venues.preparePerp = async (...args) => {
    started.resolve();
    await release.promise;
    return prepare(...args);
  };
  const pending = s.postPerp();
  const result = pending.then((value) => value);
  await started.promise;
  assert.equal((await s.risk({ killed: true })).statusCode, 200);
  release.resolve();
  assert.equal((await result).statusCode, 403);
  assert.equal(s.store.orders(alice).length, 0);
});

test("security: tighter per-order and daily policy blocks an already-prepared intent at claim", async (t) => {
  const s = await setup(t);
  const order = (await s.postPerp()).json();
  assert.equal(
    (await s.risk({ maxOrderCents: 1000, dailyLimitCents: 1000 })).statusCode,
    200,
  );
  const response = await s.submit(order.id);
  assert.equal(response.statusCode, 403);
  assert.equal(s.dispatches(), 0);
  assert.equal(s.store.order(alice, order.id).status, "prepared");
});

test("security: unknown dispatch keeps its reservation and never retries or invents a fill", async (t) => {
  const s = await setup(t);
  await s.risk({ maxOrderCents: 5000, dailyLimitCents: 5000 });
  let attempts = 0;
  s.venues.submitPerp = async () => {
    attempts++;
    throw Error("simulated transport loss");
  };
  const order = (await s.postPerp()).json();
  assert.equal((await s.submit(order.id)).statusCode, 502);
  assert.equal((await s.reconcile(order.id)).json().status, "unknown");
  assert.equal((await s.postPerp()).statusCode, 403);
  assert.equal((await s.submit(order.id)).json().status, "unknown");
  assert.equal(
    (await s.submit(order.id, { signature: "0x" + "2".repeat(130) }))
      .statusCode,
    409,
  );
  assert.equal(attempts, 1);
});

test("security: VenueError exposes statusCode, so local signature rejection cannot be reconciled into a fill", async (t) => {
  const s = await setup(t);
  const error = new VenueError(
    400,
    "WRONG_SIGNER",
    "Signature belongs to another wallet",
  );
  assert.equal(error.status, 400);
  assert.equal(error.statusCode, 400);
  s.venues.submitSpot = async () => {
    throw error;
  };
  let statusReads = 0;
  s.venues.spotStatus = async (reference) => {
    statusReads++;
    return { reference, status: "confirmed" };
  };
  const order = (await s.prepareSpot((await s.quote()).json().id)).json();
  assert.equal(
    (await s.submit(order.id, { signedTransactionBase64: signed })).statusCode,
    400,
  );
  assert.equal(s.store.order(alice, order.id).status, "failed");
  assert.equal((await s.reconcile(order.id)).json().status, "failed");
  assert.equal(
    statusReads,
    0,
    "a rejected signed payload must never become a confirmation lookup key",
  );
});

test("security: Solana reconciliation records network confirmation, not economic fill", async (t) => {
  const s = await setup(t);
  const fetcher: typeof fetch = async (_url, init) => {
    assert.equal(JSON.parse(String(init?.body)).method, "getSignatureStatuses");
    return Response.json({
      jsonrpc: "2.0",
      id: 1,
      result: { value: [{ err: null, confirmationStatus: "finalized" }] },
    });
  };
  s.venues.spotStatus = createVenueGateway(
    { solanaRpcUrl: "https://mock.invalid", hyperliquidTestnet: true },
    fetcher,
  ).spotStatus;
  const order = (await s.prepareSpot((await s.quote()).json().id)).json();
  assert.equal(
    (await s.submit(order.id, { signedTransactionBase64: signed })).json()
      .status,
    "submitted",
  );
  assert.equal((await s.reconcile(order.id)).json().status, "confirmed");
});

test("security: cancel only releases an unsubmitted intent; dispatched reservations cannot be canceled locally", async (t) => {
  const s = await setup(t);
  await s.risk({ maxOrderCents: 5000, dailyLimitCents: 5000 });
  const first = (await s.postPerp()).json();
  assert.equal((await s.postPerp()).statusCode, 403);
  assert.equal((await s.cancel(first.id)).json().status, "canceled");
  assert.equal((await s.submit(first.id)).statusCode, 409);
  assert.equal((await s.reconcile(first.id)).json().status, "canceled");
  const replacement = await s.postPerp();
  assert.equal(replacement.statusCode, 201);
  assert.equal((await s.submit(replacement.json().id)).statusCode, 200);
  assert.equal((await s.cancel(replacement.json().id)).statusCode, 409);
  assert.equal((await s.postPerp()).statusCode, 403);
  assert.equal(s.dispatches(), 1);
});

test("security: expiration frees only prepared reservations, never dispatched or ambiguous ones", async (t) => {
  const s = await setup(t);
  await s.risk({ maxOrderCents: 5000, dailyLimitCents: 5000 });
  const first = (await s.postPerp()).json();
  s.setTime(first.expiresAt + 1);
  const replacement = await s.postPerp();
  assert.equal(replacement.statusCode, 201);
  assert.equal(s.store.order(alice, first.id).status, "expired");
  assert.equal((await s.submit(replacement.json().id)).statusCode, 200);
  s.setTime(s.now() + 120_000);
  assert.equal((await s.postPerp()).statusCode, 403);
});

test("security: quote expiring during asynchronous preparation cannot acquire a reservation", async (t) => {
  const s = await setup(t);
  const q = (await s.quote()).json();
  s.venues.prepareSpot = async () => {
    s.setTime(q.expiresAt);
    return { transactionBase64: unsigned, lastValidBlockHeight: 100 };
  };
  assert.equal((await s.prepareSpot(q.id)).statusCode, 409);
  assert.equal(s.store.orders(alice).length, 0);
});

test("security: an internal authenticator failure is generic and never echoes bearer tokens", async (t) => {
  const s = await setup(t);
  s.auth.verify = async (token) => {
    throw Error(`provider diagnostic token=${token}, secret=test-secret`);
  };
  const response = await s.app.inject({ url: "/v1/me", headers });
  assert.equal(response.statusCode, 502);
  assert.doesNotMatch(response.body, /alice|test-secret|provider diagnostic/);
});

test("security: Solana agent wallet scope is case-sensitive even when both addresses are linked", async (t) => {
  const s = await setup(t);
  let variant: string | undefined;
  for (let i = 5; i < sol.length - 3; i++) {
    const c = sol[i];
    if (!/[a-km-zA-HJ-NP-Z]/.test(c) || c.toUpperCase() === c.toLowerCase())
      continue;
    const candidate =
      sol.slice(0, i) +
      (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()) +
      sol.slice(i + 1);
    try {
      if (new PublicKey(candidate).toBase58() === candidate) {
        variant = candidate;
        break;
      }
    } catch {
      /* try another base58 letter */
    }
  }
  assert.ok(variant);
  s.setWallets([
    { address: sol, chain: "solana" },
    { address: variant, chain: "solana" },
  ]);
  const agent = await s.app.inject({
    method: "POST",
    url: "/v1/agents",
    headers,
    payload: {
      name: "Scoped",
      walletAddress: variant,
      venue: "solana",
      budgetCents: 5000,
      maxOrderCents: 5000,
    },
  });
  assert.equal(agent.statusCode, 201);
  await s.app.inject({
    method: "PATCH",
    url: `/v1/agents/${agent.json().id}`,
    headers,
    payload: { enabled: true },
  });
  const q = (await s.quote()).json();
  assert.equal((await s.prepareSpot(q.id, agent.json().id)).statusCode, 403);
});

// Regression cases below assert the safe outcome. Leave them failing until the
// corresponding server/store/gateway fix lands; never weaken them to fit a bug.
test("security regression: lowering maxSlippageBps after preparation blocks spot dispatch", async (t) => {
  const s = await setup(t);
  const order = (await s.prepareSpot((await s.quote()).json().id)).json();
  assert.equal((await s.risk({ maxSlippageBps: 1 })).statusCode, 200);
  assert.equal(
    (await s.submit(order.id, { signedTransactionBase64: signed })).statusCode,
    403,
  );
  assert.equal(s.dispatches(), 0);
});

test("security regression: spot risk valuation is refreshed when reserving a previously quoted volatile input", async (t) => {
  const s = await setup(t);
  await s.risk({ maxOrderCents: 5000, dailyLimitCents: 5000 });
  let valuation = 10;
  s.venues.spotNotionalUsd = async () => valuation;
  const q = (await s.quote()).json();
  valuation = 500;
  s.setTime(s.now() + 20_000);
  assert.equal(
    (await s.prepareSpot(q.id)).statusCode,
    403,
    "a cached $10 quote must not reserve $10 against a now-$500 input",
  );
  assert.equal(s.store.orders(alice).length, 0);
});

test("security regression: lowering slippage during asynchronous spot preparation is rechecked before reserve", async (t) => {
  const s = await setup(t);
  const q = (await s.quote()).json();
  const prepare = s.venues.prepareSpot;
  s.venues.prepareSpot = async (...args) => {
    await s.risk({ maxSlippageBps: 1 });
    return prepare(...args);
  };
  assert.equal((await s.prepareSpot(q.id)).statusCode, 403);
  assert.equal(s.store.orders(alice).length, 0);
});

test("security regression: volatile spot risk is refreshed again before dispatch, not only at preparation", async (t) => {
  const s = await setup(t);
  await s.risk({ maxOrderCents: 5000, dailyLimitCents: 5000 });
  let valuation = 10;
  s.venues.spotNotionalUsd = async () => valuation;
  const order = (await s.prepareSpot((await s.quote()).json().id)).json();
  valuation = 500;
  s.setTime(s.now() + 20_000);
  assert.equal(
    (await s.submit(order.id, { signedTransactionBase64: signed })).statusCode,
    403,
  );
  assert.equal(s.dispatches(), 0);
});

test("security regression: refreshed spot reservations compose against the daily cap atomically", async (t) => {
  const s = await setup(t);
  await s.risk({ maxOrderCents: 5000, dailyLimitCents: 5000 });
  let valuation = 10;
  s.venues.spotNotionalUsd = async () => valuation;
  const first = (await s.prepareSpot((await s.quote()).json().id)).json();
  const second = (await s.prepareSpot((await s.quote()).json().id)).json();
  valuation = 35;
  assert.equal(
    (await s.submit(first.id, { signedTransactionBase64: signed })).statusCode,
    200,
  );
  assert.equal(
    (await s.submit(second.id, { signedTransactionBase64: signed })).statusCode,
    403,
    "two original $10 reservations must not permit $70 of dispatch under a $50 daily cap",
  );
  assert.equal(s.dispatches(), 1);
});

test("security regression: a stale reconciliation cannot overwrite a newer terminal fill", async (t) => {
  const s = await setup(t);
  const order = (await s.postPerp()).json();
  await s.submit(order.id);
  const started = deferred<void>();
  const older = deferred<SubmitResult>();
  let reads = 0;
  s.venues.perpStatus = async (_wallet, cloid) => {
    reads++;
    if (reads === 1) {
      started.resolve();
      return older.promise;
    }
    return { reference: cloid, status: "filled" };
  };
  const pending = s.reconcile(order.id).then((value) => value);
  await started.promise;
  assert.equal((await s.reconcile(order.id)).json().status, "filled");
  older.resolve({ reference: order.prepared.cloid, status: "resting" });
  await pending;
  assert.equal(s.store.order(alice, order.id).status, "filled");
});

test("security regression: a late submit transport error cannot overwrite a reconciled fill", async (t) => {
  const s = await setup(t);
  const order = (await s.postPerp()).json();
  const started = deferred<void>();
  const dispatch = deferred<SubmitResult>();
  s.venues.submitPerp = async () => {
    started.resolve();
    return dispatch.promise;
  };
  s.venues.perpStatus = async (_wallet, cloid) => ({
    reference: cloid,
    status: "filled",
  });
  const pending = s.submit(order.id).then((value) => value);
  await started.promise;
  assert.equal((await s.reconcile(order.id)).json().status, "filled");
  dispatch.reject(Error("response lost after exchange filled the order"));
  await pending;
  assert.equal(s.store.order(alice, order.id).status, "filled");
});

test("security regression: a partially filled then canceled Hyperliquid order retains executed-notional reservation", async (t) => {
  const s = await setup(t);
  await s.risk({ maxOrderCents: 5000, dailyLimitCents: 5000 });
  const order = (await s.postPerp()).json();
  await s.submit(order.id);
  const fetcher: typeof fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    assert.equal(request.type, "orderStatus");
    assert.equal(request.oid, order.prepared.cloid);
    return Response.json({
      status: "order",
      order: {
        status: "canceled",
        statusTimestamp: s.now(),
        order: {
          coin: "BTC",
          side: "B",
          limitPx: "50000",
          origSz: "0.001",
          sz: "0.0005",
          cloid: order.prepared.cloid,
          oid: 123,
          timestamp: s.now(),
        },
      },
    });
  };
  s.venues.perpStatus = createVenueGateway(
    { solanaRpcUrl: "https://mock.invalid", hyperliquidTestnet: true },
    fetcher,
  ).perpStatus;
  await s.reconcile(order.id);
  assert.equal(
    (await s.postPerp()).statusCode,
    403,
    "canceling an unfilled remainder must not erase the notional that already traded",
  );
});

test("security regression: malformed signed Solana bytes are a client rejection, not an upstream failure", async (t) => {
  const s = await setup(t);
  const order = (await s.prepareSpot((await s.quote()).json().id)).json();
  const response = await s.submit(order.id, {
    signedTransactionBase64: "not-base64-transaction".repeat(4),
  });
  assert.equal(response.statusCode, 400);
  assert.equal(s.dispatches(), 0);
  assert.equal(s.store.order(alice, order.id).status, "prepared");
});
