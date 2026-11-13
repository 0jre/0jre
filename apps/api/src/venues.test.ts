import test from "node:test";
import assert from "node:assert/strict";
import {
  Keypair,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { privateKeyToAccount } from "viem/accounts";
import { signL1Action } from "@nktkas/hyperliquid/signing";
import { serializeSignature } from "viem";
import { createVenueGateway, VenueError } from "./venues.js";
import type { PreparedSpot, SpotQuote } from "./contracts.js";

const key = Keypair.generate();
const other = Keypair.generate();
const wallet = key.publicKey.toBase58();
const usdc = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const mint = "So11111111111111111111111111111111111111112";
const config = {
  solanaRpcUrl: "https://rpc.example.invalid",
  hyperliquidTestnet: true,
  jupiterApiKey: "test-key",
};
const account = privateKeyToAccount(("0x" + "11".repeat(32)) as `0x${string}`);
const cloid = "0x" + "ab".repeat(16);
const signatureReference = "3".repeat(88);
const response = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const rejectCode = (code: string) => (error: unknown) =>
  error instanceof VenueError && error.code === code;
function fixture(lamports = 1) {
  const tx = new VersionedTransaction(
    new TransactionMessage({
      payerKey: key.publicKey,
      recentBlockhash: other.publicKey.toBase58(),
      instructions: [
        SystemProgram.transfer({
          fromPubkey: key.publicKey,
          toPubkey: other.publicKey,
          lamports,
        }),
      ],
    }).compileToV0Message(),
  );
  const prepared: PreparedSpot = {
    transactionBase64: Buffer.from(tx.serialize()).toString("base64"),
    lastValidBlockHeight: 100,
  };
  tx.sign([key]);
  return {
    tx,
    prepared,
    signed: Buffer.from(tx.serialize()).toString("base64"),
  };
}
function rpcMock(
  options: {
    height?: number;
    simulationError?: unknown;
    rpcError?: boolean;
    status?: unknown;
  } = {},
) {
  const calls: { method: string; params: any[] }[] = [];
  const fetcher = (async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    calls.push(body);
    if (options.rpcError) return response({ error: { code: -1 } });
    const values: Record<string, unknown> = {
      getBlockHeight: options.height ?? 50,
      simulateTransaction: { value: { err: options.simulationError ?? null } },
      sendTransaction: signatureReference,
      getSignatureStatuses: { value: [options.status ?? null] },
    };
    return response({ jsonrpc: "2.0", result: values[body.method] });
  }) as typeof fetch;
  return { calls, gateway: createVenueGateway(config, fetcher) };
}
const quote = (overrides = {}): SpotQuote => ({
  inputMint: mint,
  outputMint: usdc,
  inAmount: "1000000000",
  outAmount: "100000000",
  minOutAmount: "99000000",
  slippageBps: 100,
  priceImpactPct: 0.01,
  routeLabels: ["AMM"],
  raw: {},
  ...overrides,
});
const orderInput = (overrides = {}) => ({
  symbol: "BTC",
  side: "buy" as const,
  size: "0.01",
  limitPrice: "60000",
  reduceOnly: false,
  walletAddress: account.address,
  ...overrides,
});
function hlMock(
  exchange: unknown = {
    status: "ok",
    response: { data: { statuses: [{ resting: { oid: 5 } }] } },
  },
) {
  const calls: { url: string; body: any }[] = [];
  const gateway = createVenueGateway(config, (async (url, init) => {
    const body = JSON.parse(String(init?.body));
    calls.push({ url: String(url), body });
    if (String(url).endsWith("/exchange")) return response(exchange);
    if (body.type === "meta")
      return response({ universe: [{ name: "BTC", szDecimals: 5 }] });
    if (body.type === "allMids") return response({ BTC: "61000" });
    if (body.type === "orderStatus")
      return response({ status: "order", order: { status: "filled" } });
    return response({});
  }) as typeof fetch);
  return { gateway, calls };
}

test("missing Jupiter key fails closed with 503 and no fetch", async () => {
  let calls = 0;
  const gateway = createVenueGateway(
    { ...config, jupiterApiKey: undefined },
    (async () => {
      calls++;
      return response({});
    }) as typeof fetch,
  );
  await assert.rejects(
    gateway.quoteSpot({
      inputMint: mint,
      outputMint: usdc,
      amount: "1",
      slippageBps: 50,
      walletAddress: wallet,
    }),
    (err: any) => err.status === 503,
  );
  assert.equal(calls, 0);
});
test("Jupiter v2 quote binds taker and prepares exact returned transaction", async () => {
  const { prepared } = fixture();
  let seenUrl = "";
  let seenHeader: any;
  const gateway = createVenueGateway(config, (async (url, init) => {
    seenUrl = String(url);
    seenHeader = init?.headers;
    return response({
      inputMint: mint,
      outputMint: usdc,
      inAmount: "1000000000",
      outAmount: "100000000",
      otherAmountThreshold: "99000000",
      slippageBps: 100,
      swapMode: "ExactIn",
      priceImpactPct: "0.01",
      routePlan: [{ swapInfo: { label: "AMM" } }],
      taker: wallet,
      router: "metis",
      transaction: prepared.transactionBase64,
      lastValidBlockHeight: "100",
    });
  }) as typeof fetch);
  const result = await gateway.quoteSpot({
    inputMint: mint,
    outputMint: usdc,
    amount: "1000000000",
    slippageBps: 100,
    walletAddress: wallet,
  });
  assert.match(seenUrl, /swap\/v2\/order/);
  assert.equal(new URL(seenUrl).searchParams.get("taker"), wallet);
  assert.equal(seenHeader["x-api-key"], "test-key");
  assert.deepEqual(await gateway.prepareSpot(result, wallet), prepared);
  assert.equal(await gateway.spotNotionalUsd(result), 100);
});
test("quote rejects numeric or unsafe uint64 input without fetch", async () => {
  const gateway = createVenueGateway(config, (async () => {
    throw Error("must not fetch");
  }) as typeof fetch);
  for (const amount of [
    "1e9",
    "-1",
    "18446744073709551616",
    "0",
    1 as unknown as string,
  ])
    await assert.rejects(
      gateway.quoteSpot({
        inputMint: mint,
        outputMint: usdc,
        amount,
        slippageBps: 50,
        walletAddress: wallet,
      }),
      rejectCode("INVALID_QUOTE"),
    );
});
test("trusted USDC valuation ignores client USD and uses independent atomic quote", async () => {
  let query: URL | undefined;
  const gateway = createVenueGateway(config, (async (url) => {
    query = new URL(String(url));
    return response({
      inputMint: mint,
      outputMint: usdc,
      inAmount: "1000000000",
      outAmount: "2000000",
    });
  }) as typeof fetch);
  assert.equal(
    await gateway.spotNotionalUsd(
      quote({
        outputMint: other.publicKey.toBase58(),
        raw: { inUsdValue: 999999 },
      }),
    ),
    2,
  );
  assert.equal(query?.searchParams.get("outputMint"), usdc);
});
test("valuation fails closed on missing or unsafe USDC output", async () => {
  const gateway = createVenueGateway(config, (async () =>
    response({})) as typeof fetch);
  await assert.rejects(
    gateway.spotNotionalUsd(quote({ outputMint: mint })),
    rejectCode("VALUATION_UNAVAILABLE"),
  );
  await assert.rejects(
    gateway.spotNotionalUsd(
      quote({ inputMint: usdc, inAmount: "9007199254740992" }),
    ),
    rejectCode("VALUATION_UNAVAILABLE"),
  );
});
test("secure Solana submit verifies offline signed exact message then simulates sigVerify before sending", async () => {
  const { prepared, signed } = fixture();
  const { gateway, calls } = rpcMock();
  assert.deepEqual(await gateway.submitSpot(prepared, signed, wallet), {
    reference: signatureReference,
    status: "submitted",
  });
  assert.deepEqual(
    calls.map((call) => call.method),
    ["getBlockHeight", "simulateTransaction", "sendTransaction"],
  );
  assert.equal(calls[1].params[1].sigVerify, true);
  assert.equal(calls[2].params[1].skipPreflight, false);
});
test("Solana altered message is rejected before any RPC", async () => {
  const { gateway, calls } = rpcMock();
  await assert.rejects(
    gateway.submitSpot(fixture().prepared, fixture(2).signed, wallet),
    rejectCode("TRANSACTION_CHANGED"),
  );
  assert.equal(calls.length, 0);
});
test("Solana zero, corrupted, and wrong-wallet signatures are rejected before RPC", async () => {
  const { gateway, calls } = rpcMock();
  const { prepared, tx, signed } = fixture();
  await assert.rejects(
    gateway.submitSpot(prepared, prepared.transactionBase64, wallet),
    rejectCode("INVALID_SIGNATURE"),
  );
  tx.signatures[0][0] ^= 1;
  await assert.rejects(
    gateway.submitSpot(
      prepared,
      Buffer.from(tx.serialize()).toString("base64"),
      wallet,
    ),
    rejectCode("INVALID_SIGNATURE"),
  );
  await assert.rejects(
    gateway.submitSpot(prepared, signed, other.publicKey.toBase58()),
    rejectCode("WRONG_SIGNER"),
  );
  assert.equal(calls.length, 0);
});
test("Solana expiry prevents simulation and relay", async () => {
  const { prepared, signed } = fixture();
  const { gateway, calls } = rpcMock({ height: 101 });
  await assert.rejects(
    gateway.submitSpot(prepared, signed, wallet),
    rejectCode("TRANSACTION_EXPIRED"),
  );
  assert.equal(calls.length, 1);
});
test("Solana simulation failure prevents send", async () => {
  const { prepared, signed } = fixture();
  const { gateway, calls } = rpcMock({
    simulationError: { InstructionError: [0, "Custom"] },
  });
  await assert.rejects(
    gateway.submitSpot(prepared, signed, wallet),
    rejectCode("SIMULATION_FAILED"),
  );
  assert.equal(calls.length, 2);
});
test("Solana RPC error never produces fabricated success", async () => {
  const { prepared, signed } = fixture();
  const { gateway } = rpcMock({ rpcError: true });
  await assert.rejects(
    gateway.submitSpot(prepared, signed, wallet),
    rejectCode("SOLANA_RPC_ERROR"),
  );
});
test("network Solana confirmation is confirmed not filled", async () => {
  assert.equal(
    (
      await rpcMock({
        status: { err: null, confirmationStatus: "confirmed" },
      }).gateway.spotStatus(signatureReference)
    ).status,
    "confirmed",
  );
  assert.equal(
    (
      await rpcMock({
        status: { err: { failed: true }, confirmationStatus: "confirmed" },
      }).gateway.spotStatus(signatureReference)
    ).status,
    "failed",
  );
  assert.equal(
    (await rpcMock().gateway.spotStatus(signatureReference)).status,
    "unknown",
  );
});
test("Hyperliquid metadata controls asset index, precision and trusted current-mid notional", async () => {
  const { gateway } = hlMock();
  const prepared = await gateway.preparePerp(
    orderInput({ side: "sell", reduceOnly: true }),
    cloid,
    Date.now(),
  );
  assert.equal(prepared.notionalUsd, 610);
  const order = (prepared.action as any).orders[0];
  assert.deepEqual(order, {
    a: 0,
    b: false,
    p: "60000",
    s: "0.01",
    r: true,
    t: { limit: { tif: "Gtc" } },
    c: cloid,
  });
  assert.equal((prepared.typedData as any).domain.chainId, 1337);
  assert.equal((prepared.typedData as any).message.source, "b");
});
test("Hyperliquid rejects invalid size atoms, tick, market, nonce, and cloid", async () => {
  const { gateway } = hlMock();
  for (const fields of [
    { size: "0.000001" },
    { size: "1e-2" },
    { size: "9007199254740992" },
    { limitPrice: "12345.6" },
    { limitPrice: "1.23" },
    { symbol: "NOT_REAL" },
  ])
    await assert.rejects(
      gateway.preparePerp(orderInput(fields), cloid, Date.now()),
    );
  await assert.rejects(gateway.preparePerp(orderInput(), "bad", Date.now()));
  await assert.rejects(
    gateway.preparePerp(orderInput(), cloid, Date.now() - 120000),
  );
});
test("Hyperliquid external SDK signature submits only stored action and nonce", async () => {
  const { gateway, calls } = hlMock();
  const prepared = await gateway.preparePerp(orderInput(), cloid, Date.now());
  // Independently sign with SDK to prove captured typedData is SDK-compatible.
  const components = await signL1Action({
    wallet: account,
    action: prepared.action as Record<string, unknown>,
    nonce: prepared.nonce,
    expiresAfter: prepared.expiresAfter,
    isTestnet: true,
  });
  const signature = serializeSignature({
    r: components.r,
    s: components.s,
    v: BigInt(components.v),
  });
  assert.equal(
    (await gateway.submitPerp(prepared, signature, account.address)).status,
    "resting",
  );
  const sent = calls.find((call) => call.url.endsWith("/exchange"))?.body;
  assert.deepEqual(sent.action, prepared.action);
  assert.equal(sent.nonce, prepared.nonce);
  assert.equal(sent.expiresAfter, prepared.expiresAfter);
});
test("Hyperliquid HTTP200 per-order error fails rather than claiming submitted", async () => {
  const { gateway } = hlMock({
    status: "ok",
    response: { data: { statuses: [{ error: "Insufficient margin" }] } },
  });
  const prepared = await gateway.preparePerp(orderInput(), cloid, Date.now());
  const signature = await account.signTypedData(prepared.typedData as any);
  await assert.rejects(
    gateway.submitPerp(prepared, signature, account.address),
    rejectCode("ORDER_REJECTED"),
  );
});
test("Hyperliquid invalid signer, modified action, typedData, signature, or expiry never reaches exchange", async () => {
  const { gateway, calls } = hlMock();
  const prepared = await gateway.preparePerp(orderInput(), cloid, Date.now());
  const signature = await account.signTypedData(prepared.typedData as any);
  const another = privateKeyToAccount(
    ("0x" + "22".repeat(32)) as `0x${string}`,
  );
  await assert.rejects(
    gateway.submitPerp(prepared, signature, another.address),
    rejectCode("WRONG_SIGNER"),
  );
  await assert.rejects(
    gateway.submitPerp(
      {
        ...prepared,
        action: {
          ...(prepared.action as any),
          orders: [{ ...(prepared.action as any).orders[0], s: "1" }],
        },
      },
      signature,
      account.address,
    ),
    rejectCode("ORDER_CHANGED"),
  );
  await assert.rejects(
    gateway.submitPerp(
      { ...prepared, typedData: {} },
      signature,
      account.address,
    ),
    rejectCode("ORDER_CHANGED"),
  );
  await assert.rejects(
    gateway.submitPerp(prepared, "0x00", account.address),
    rejectCode("INVALID_SIGNATURE"),
  );
  await assert.rejects(
    gateway.submitPerp(
      { ...prepared, expiresAfter: Date.now() - 1 },
      signature,
      account.address,
    ),
    rejectCode("ORDER_EXPIRED"),
  );
  assert.equal(
    calls.filter((call) => call.url.endsWith("/exchange")).length,
    0,
  );
});
test("Hyperliquid status reconciliation queries exact cloid and linked wallet", async () => {
  const { gateway, calls } = hlMock();
  assert.equal(
    (await gateway.perpStatus(account.address, cloid)).status,
    "filled",
  );
  assert.deepEqual(calls[0].body, {
    type: "orderStatus",
    user: account.address,
    oid: cloid,
  });
});
test("preparation rejects unsupported sponsorship, router and provider construction failure", async () => {
  const { prepared } = fixture();
  const { gateway } = hlMock();
  const raw = {
    taker: wallet,
    router: "metis",
    transaction: prepared.transactionBase64,
    lastValidBlockHeight: "100",
  };
  for (const changed of [
    { errorCode: 1 },
    { router: "jupiterz" },
    { taker: other.publicKey.toBase58() },
    { transaction: "" },
    { lastValidBlockHeight: "not-a-height" },
  ])
    await assert.rejects(
      gateway.prepareSpot(quote({ raw: { ...raw, ...changed } }), wallet),
    );
  await assert.rejects(
    gateway.prepareSpot(quote({ raw }), other.publicKey.toBase58()),
  );
});
test("live Solana portfolio read includes SOL, SPL Token and Token-2022", async () => {
  const calls: any[] = [];
  const gateway = createVenueGateway(config, (async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    calls.push(body);
    return response({
      result: { value: body.method === "getBalance" ? 1000 : [] },
    });
  }) as typeof fetch);
  const portfolio: any = await gateway.portfolio({
    address: wallet,
    chain: "solana",
  });
  assert.equal(portfolio.native.value, 1000);
  assert.equal(calls.length, 3);
  assert.equal(
    calls.filter((call) => call.method === "getTokenAccountsByOwner").length,
    2,
  );
  assert.equal(calls[1].params[2].commitment, "confirmed");
});
test("Hyperliquid portfolio and markets return provider state not placeholders", async () => {
  const calls: any[] = [];
  const gateway = createVenueGateway(config, (async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    calls.push(body);
    if (body.type === "metaAndAssetCtxs")
      return response([
        { universe: [{ name: "BTC", szDecimals: 5 }] },
        [{ markPx: "60000", funding: "0.0001" }],
      ]);
    return response(
      body.type === "clearinghouseState"
        ? { marginSummary: { accountValue: "123.45" }, assetPositions: [] }
        : { balances: [{ coin: "USDC", total: "12" }] },
    );
  }) as typeof fetch);
  const portfolio: any = await gateway.portfolio({
    address: account.address,
    chain: "ethereum",
  });
  assert.equal(portfolio.perps.marginSummary.accountValue, "123.45");
  assert.equal(portfolio.spot.balances[0].total, "12");
  const markets: any = await gateway.markets();
  assert.equal(markets.markets[0].asset, 0);
  assert.equal(markets.markets[0].markPx, "60000");
  assert.deepEqual(
    calls.map((call) => call.type),
    ["clearinghouseState", "spotClearinghouseState", "metaAndAssetCtxs"],
  );
});
test("Hyperliquid filled response and unknown/rejected reconciliation preserve status semantics", async () => {
  const { gateway } = hlMock({
    status: "ok",
    response: {
      data: {
        statuses: [{ filled: { oid: 5, totalSz: "0.01", avgPx: "60000" } }],
      },
    },
  });
  const prepared = await gateway.preparePerp(orderInput(), cloid, Date.now());
  assert.equal(
    (
      await gateway.submitPerp(
        prepared,
        await account.signTypedData(prepared.typedData as any),
        account.address,
      )
    ).status,
    "filled",
  );
  for (const [raw, expected] of [
    [{ status: "unknownOid" }, "unknown"],
    [{ status: "order", order: { status: "reduceOnlyRejected" } }, "failed"],
    [
      {
        status: "order",
        order: { status: "canceled", order: { origSz: "1", sz: "1" } },
      },
      "failed",
    ],
    [{ status: "order", order: { status: "canceled" } }, "unknown"],
  ] as const) {
    const reader = createVenueGateway(config, (async () =>
      response(raw)) as typeof fetch);
    assert.equal(
      (await reader.perpStatus(account.address, cloid)).status,
      expected,
    );
  }
});
test("HTTP and network failures are explicit", async () => {
  const down = createVenueGateway(config, (async () =>
    response({}, 429)) as typeof fetch);
  await assert.rejects(down.markets(), (err: any) => err.status === 429);
  const broken = createVenueGateway(config, (async () => {
    throw Error("offline");
  }) as typeof fetch);
  await assert.rejects(broken.markets(), rejectCode("VENUE_UNAVAILABLE"));
});
