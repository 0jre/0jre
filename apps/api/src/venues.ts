import { createPublicKey, verify as verifySignature } from "node:crypto";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import {
  recoverTypedDataAddress,
  parseSignature,
  isAddress,
  type Hex,
} from "viem";
import { signL1Action } from "@nktkas/hyperliquid/signing";
import type {
  VenueGateway,
  PreparedSpot,
  PreparedPerp,
  SpotQuote,
  SubmitResult,
} from "./contracts.js";

export class VenueError extends Error {
  readonly statusCode: number;
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "VenueError";
    this.statusCode = status;
  }
}
const fail = (status: number, code: string, message: string): never => {
  throw new VenueError(status, code, message);
};
const object = (value: unknown): Record<string, any> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : fail(502, "INVALID_PROVIDER_RESPONSE", "Invalid provider response");
const validSolana = (address: string) => {
  try {
    return new PublicKey(address);
  } catch {
    return fail(400, "INVALID_WALLET", "Invalid Solana address");
  }
};
const validEvm = (address: string) => {
  if (!isAddress(address))
    fail(400, "INVALID_WALLET", "Invalid Ethereum address");
};
const integer = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;
const atomic = (value: unknown, positive = true): value is string =>
  typeof value === "string" &&
  /^(0|[1-9]\d*)$/.test(value) &&
  BigInt(value) <= 18446744073709551615n &&
  (!positive || BigInt(value) > 0n);
function decodeTransaction(base64: string): VersionedTransaction {
  try {
    if (
      typeof base64 !== "string" ||
      base64.length > 20000 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)
    )
      throw Error();
    const bytes = Buffer.from(base64, "base64");
    if (bytes.toString("base64") !== base64) throw Error();
    return VersionedTransaction.deserialize(bytes);
  } catch {
    return fail(
      400,
      "INVALID_TRANSACTION",
      "Invalid serialized Solana transaction",
    );
  }
}
function verifyTransaction(tx: VersionedTransaction, walletAddress: string) {
  const wallet = validSolana(walletAddress);
  const required = tx.message.header.numRequiredSignatures;
  if (required < 1 || !tx.message.staticAccountKeys[0]?.equals(wallet))
    fail(
      400,
      "WRONG_SIGNER",
      "The linked wallet must be the transaction fee payer",
    );
  const message = Buffer.from(tx.message.serialize());
  for (let i = 0; i < required; i++) {
    const signature = tx.signatures[i];
    const key = tx.message.staticAccountKeys[i];
    if (
      !signature ||
      signature.length !== 64 ||
      signature.every((byte) => byte === 0)
    )
      fail(
        400,
        "INVALID_SIGNATURE",
        "Transaction is missing a required signature",
      );
    const publicKey = createPublicKey({
      key: Buffer.concat([
        Buffer.from("302a300506032b6570032100", "hex"),
        key.toBuffer(),
      ]),
      format: "der",
      type: "spki",
    });
    if (!verifySignature(null, message, publicKey, signature))
      fail(
        400,
        "INVALID_SIGNATURE",
        "Transaction signature verification failed",
      );
  }
}
// Decimal strings are parsed exactly into atoms, never rounded through floating point.
function decimal(value: string, decimals: number, field: string): string {
  if (
    typeof value !== "string" ||
    value.length > 50 ||
    !/^(0|[1-9]\d*)(\.\d+)?$/.test(value)
  )
    fail(
      400,
      "INVALID_PRECISION",
      `${field} must be a positive decimal string`,
    );
  const normalized = value.includes(".")
    ? value.replace(/0+$/, "").replace(/\.$/, "")
    : value;
  const [whole, fraction = ""] = normalized.split(".");
  if (fraction.length > decimals)
    fail(400, "INVALID_PRECISION", `${field} exceeds venue precision`);
  const units = BigInt(whole + fraction.padEnd(decimals, "0"));
  if (units <= 0n || units > BigInt(Number.MAX_SAFE_INTEGER))
    fail(
      400,
      "INVALID_AMOUNT",
      `${field} atoms are outside the safe supported range`,
    );
  return normalized;
}

export function createVenueGateway(
  config: {
    jupiterApiKey?: string;
    solanaRpcUrl: string;
    hyperliquidTestnet: boolean;
  },
  fetcher: typeof fetch = fetch,
): VenueGateway {
  const hl = config.hyperliquidTestnet
    ? "https://api.hyperliquid-testnet.xyz"
    : "https://api.hyperliquid.xyz";
  async function request(url: string, init?: RequestInit): Promise<any> {
    let response: Response;
    try {
      response = await fetcher(url, {
        ...init,
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      return fail(
        502,
        "VENUE_UNAVAILABLE",
        "Venue request failed or timed out",
      );
    }
    if (!response.ok)
      fail(
        response.status === 429 ? 429 : 502,
        "VENUE_HTTP_ERROR",
        `Venue returned HTTP ${response.status}`,
      );
    let data: any;
    try {
      data = await response.json();
    } catch {
      return fail(
        502,
        "INVALID_PROVIDER_RESPONSE",
        "Venue returned invalid JSON",
      );
    }
    return data;
  }
  const post = (url: string, body: unknown, headers?: Record<string, string>) =>
    request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  async function rpc(method: string, params: unknown[]): Promise<any> {
    const result = object(
      await post(config.solanaRpcUrl, {
        jsonrpc: "2.0",
        id: 1,
        method,
        params,
      }),
    );
    if (result.error)
      fail(502, "SOLANA_RPC_ERROR", `Solana RPC rejected ${method}`);
    if (!("result" in result))
      fail(502, "INVALID_PROVIDER_RESPONSE", "Solana RPC result missing");
    return result.result;
  }
  const info = (body: unknown) => post(`${hl}/info`, body);
  function jupiterHeaders() {
    const apiKey = config.jupiterApiKey;
    if (!apiKey)
      return fail(
        503,
        "JUPITER_NOT_CONFIGURED",
        "Jupiter API key is not configured",
      );
    return { "x-api-key": apiKey };
  }
  async function perpTypedData(
    prepared: Pick<PreparedPerp, "action" | "nonce" | "expiresAfter">,
  ) {
    // Let the official SDK generate the complete phantom-agent signing payload.
    // The callback only captures it: no private key, dummy signature, or custom hash.
    let captured: any;
    const captureOnly = new Error("capture-only");
    try {
      await signL1Action({
        action: prepared.action as Record<string, unknown>,
        nonce: prepared.nonce,
        expiresAfter: prepared.expiresAfter,
        isTestnet: config.hyperliquidTestnet,
        wallet: {
          address: "0x0000000000000000000000000000000000000000",
          async signTypedData(data: any) {
            captured = data;
            throw captureOnly;
          },
        },
      });
    } catch (error) {
      if (!(error instanceof Error) || error.cause !== captureOnly) throw error;
    }
    if (!captured)
      fail(
        500,
        "SIGNING_PAYLOAD_FAILED",
        "SDK did not generate a signing payload",
      );
    return captured;
  }
  return {
    async quoteSpot(input) {
      const headers = jupiterHeaders();
      validSolana(input.inputMint);
      validSolana(input.outputMint);
      validSolana(input.walletAddress);
      if (
        input.inputMint === input.outputMint ||
        !atomic(input.amount) ||
        !integer(input.slippageBps) ||
        input.slippageBps > 5000
      )
        fail(400, "INVALID_QUOTE", "Invalid quote amount, mints, or slippage");
      const query = new URLSearchParams({
        inputMint: input.inputMint,
        outputMint: input.outputMint,
        amount: input.amount,
        slippageBps: String(input.slippageBps),
        swapMode: "ExactIn",
        taker: input.walletAddress,
        excludeRouters: "jupiterz,dflow,okx",
        maxSupportedTransactionVersion: "0",
      });
      const raw = object(
        await request(`https://api.jup.ag/swap/v2/order?${query}`, { headers }),
      );
      if (
        raw.error ||
        raw.inputMint !== input.inputMint ||
        raw.outputMint !== input.outputMint ||
        raw.inAmount !== input.amount ||
        raw.slippageBps !== input.slippageBps ||
        raw.swapMode !== "ExactIn" ||
        !atomic(raw.outAmount) ||
        !atomic(raw.otherAmountThreshold) ||
        BigInt(raw.otherAmountThreshold) > BigInt(raw.outAmount) ||
        !Array.isArray(raw.routePlan) ||
        !Number.isFinite(Number(raw.priceImpactPct))
      )
        fail(
          502,
          "INVALID_QUOTE_RESPONSE",
          "Jupiter returned an invalid quote",
        );
      return {
        inputMint: raw.inputMint,
        outputMint: raw.outputMint,
        inAmount: raw.inAmount,
        outAmount: raw.outAmount,
        minOutAmount: raw.otherAmountThreshold,
        slippageBps: raw.slippageBps,
        priceImpactPct: Number(raw.priceImpactPct),
        routeLabels: raw.routePlan
          .map((route: any) => route.swapInfo?.label)
          .filter((label: unknown) => typeof label === "string"),
        raw,
      };
    },
    async spotNotionalUsd(quote) {
      const usdc = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
      let units: unknown =
        quote.inputMint === usdc ? quote.inAmount : undefined;
      if (units === undefined) {
        const query = new URLSearchParams({
          inputMint: quote.inputMint,
          outputMint: usdc,
          amount: quote.inAmount,
          swapMode: "ExactIn",
          slippageBps: "50",
        });
        const valuation = object(
          await request(`https://api.jup.ag/swap/v2/order?${query}`, {
            headers: jupiterHeaders(),
          }),
        );
        if (
          valuation.error ||
          valuation.inputMint !== quote.inputMint ||
          valuation.outputMint !== usdc ||
          valuation.inAmount !== quote.inAmount
        )
          fail(
            502,
            "VALUATION_UNAVAILABLE",
            "Independent USDC valuation failed",
          );
        units = valuation.outAmount;
      }
      if (!atomic(units) || BigInt(units) > BigInt(Number.MAX_SAFE_INTEGER))
        fail(
          502,
          "VALUATION_UNAVAILABLE",
          "USDC valuation is outside the supported range",
        );
      return Number(units) / 1_000_000;
    },
    async prepareSpot(
      quote: SpotQuote,
      walletAddress: string,
    ): Promise<PreparedSpot> {
      const wallet = validSolana(walletAddress);
      const raw = object(quote.raw);
      const height =
        typeof raw.lastValidBlockHeight === "string" &&
        /^\d+$/.test(raw.lastValidBlockHeight)
          ? Number(raw.lastValidBlockHeight)
          : raw.lastValidBlockHeight;
      if (
        raw.error ||
        raw.errorCode ||
        raw.taker !== walletAddress ||
        raw.router !== "metis" ||
        typeof raw.transaction !== "string" ||
        !integer(height)
      )
        fail(
          502,
          "SWAP_PREPARATION_FAILED",
          "Jupiter failed to prepare a supported wallet-funded swap",
        );
      const tx = decodeTransaction(raw.transaction);
      if (!tx.message.staticAccountKeys[0]?.equals(wallet))
        fail(
          502,
          "WRONG_PREPARED_SIGNER",
          "Prepared swap does not belong to the linked wallet",
        );
      return {
        transactionBase64: raw.transaction,
        lastValidBlockHeight: height,
      };
    },
    async submitSpot(prepared, signedTransactionBase64, walletAddress) {
      const original = decodeTransaction(prepared.transactionBase64);
      const signed = decodeTransaction(signedTransactionBase64);
      if (
        !Buffer.from(original.message.serialize()).equals(
          Buffer.from(signed.message.serialize()),
        )
      )
        fail(
          400,
          "TRANSACTION_CHANGED",
          "Signed transaction does not match the prepared swap",
        );
      verifyTransaction(signed, walletAddress);
      if (!integer(prepared.lastValidBlockHeight))
        fail(400, "INVALID_EXPIRY", "Prepared transaction expiry is invalid");
      const height = await rpc("getBlockHeight", [{ commitment: "confirmed" }]);
      if (!integer(height))
        fail(502, "INVALID_PROVIDER_RESPONSE", "Invalid block height");
      if (height > prepared.lastValidBlockHeight)
        fail(
          409,
          "TRANSACTION_EXPIRED",
          "Prepared swap blockhash expired; prepare a new swap",
        );
      const simulation = object(
        await rpc("simulateTransaction", [
          signedTransactionBase64,
          {
            encoding: "base64",
            sigVerify: true,
            commitment: "confirmed",
            replaceRecentBlockhash: false,
          },
        ]),
      );
      if (!simulation.value || simulation.value.err !== null)
        fail(422, "SIMULATION_FAILED", "Solana transaction simulation failed");
      const reference = await rpc("sendTransaction", [
        signedTransactionBase64,
        {
          encoding: "base64",
          skipPreflight: false,
          preflightCommitment: "confirmed",
          maxRetries: 2,
        },
      ]);
      if (
        typeof reference !== "string" ||
        !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(reference)
      )
        fail(
          502,
          "INVALID_PROVIDER_RESPONSE",
          "Solana RPC returned an invalid signature",
        );
      return { reference, status: "submitted" };
    },
    async spotStatus(signature) {
      if (!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signature))
        fail(400, "INVALID_SIGNATURE", "Invalid Solana signature");
      const raw = object(
        await rpc("getSignatureStatuses", [
          [signature],
          { searchTransactionHistory: true },
        ]),
      );
      if (!Array.isArray(raw.value))
        fail(
          502,
          "INVALID_PROVIDER_RESPONSE",
          "Invalid Solana signature status",
        );
      const state = raw.value[0];
      return {
        reference: signature,
        status: !state
          ? "unknown"
          : state.err
            ? "failed"
            : ["confirmed", "finalized"].includes(state.confirmationStatus)
              ? "confirmed"
              : "submitted",
        raw: state,
      };
    },
    async preparePerp(input, cloid, nonce) {
      validEvm(input.walletAddress);
      if (
        !/^0x[0-9a-fA-F]{32}$/.test(cloid) ||
        !integer(nonce) ||
        Math.abs(Date.now() - nonce) > 60_000 ||
        !["buy", "sell"].includes(input.side) ||
        typeof input.reduceOnly !== "boolean"
      )
        fail(
          400,
          "INVALID_ORDER",
          "Invalid order nonce, client ID, side, or reduce-only flag",
        );
      const [metaValue, midsValue] = await Promise.all([
        info({ type: "meta" }),
        info({ type: "allMids" }),
      ]);
      const meta = object(metaValue);
      const mids = object(midsValue);
      if (!Array.isArray(meta.universe))
        fail(502, "INVALID_PROVIDER_RESPONSE", "Invalid Hyperliquid metadata");
      const asset = meta.universe.findIndex(
        (entry: any) => entry.name === input.symbol,
      );
      if (asset < 0 || meta.universe[asset].isDelisted)
        fail(400, "UNKNOWN_MARKET", "Perpetual market is not available");
      const szDecimals = meta.universe[asset].szDecimals;
      if (!integer(szDecimals) || szDecimals > 6)
        fail(502, "INVALID_PROVIDER_RESPONSE", "Invalid market precision");
      const size = decimal(input.size, szDecimals, "Size");
      const price = decimal(input.limitPrice, 6 - szDecimals, "Limit price");
      if (
        price.includes(".") &&
        price.replace(".", "").replace(/^0+/, "").length > 5
      )
        fail(
          400,
          "INVALID_TICK",
          "Limit price exceeds five significant figures",
        );
      const mid = Number(mids[input.symbol]);
      if (!Number.isFinite(mid) || mid <= 0)
        fail(502, "MISSING_MARKET_PRICE", "Current market mid is unavailable");
      // Reserve against both current market and execution price, not a user-supplied cheap limit.
      const notionalUsd = Number(size) * Math.max(mid, Number(price));
      if (
        !Number.isFinite(notionalUsd) ||
        notionalUsd <= 0 ||
        notionalUsd > Number.MAX_SAFE_INTEGER
      )
        fail(
          400,
          "INVALID_NOTIONAL",
          "Order notional is outside the supported range",
        );
      const action = {
        type: "order" as const,
        orders: [
          {
            a: asset,
            b: input.side === "buy",
            p: price,
            s: size,
            r: input.reduceOnly,
            t: { limit: { tif: "Gtc" as const } },
            c: cloid as Hex,
          },
        ],
        grouping: "na" as const,
      };
      const prepared = {
        action,
        nonce,
        expiresAfter: nonce + 60_000,
        cloid,
        notionalUsd,
      };
      return { ...prepared, typedData: await perpTypedData(prepared) };
    },
    async perpNotionalUsd(prepared) {
      const action = object(prepared.action);
      if (
        action.type !== "order" ||
        !Array.isArray(action.orders) ||
        action.orders.length !== 1
      )
        fail(400, "INVALID_PREPARED_ORDER", "Invalid stored order.");
      const order = object(action.orders[0]);
      const [metaValue, midsValue] = await Promise.all([
        info({ type: "meta" }),
        info({ type: "allMids" }),
      ]);
      const meta = object(metaValue),
        mids = object(midsValue);
      const asset =
        Array.isArray(meta.universe) && integer(order.a)
          ? meta.universe[order.a]
          : null;
      if (!asset || asset.isDelisted)
        fail(502, "MISSING_MARKET_PRICE", "Stored market is unavailable.");
      const mid = Number(mids[asset.name]);
      const limit = Number(order.p),
        size = Number(order.s);
      const value = Math.max(mid, limit) * size;
      if (
        !Number.isFinite(mid) ||
        mid <= 0 ||
        !Number.isFinite(limit) ||
        limit <= 0 ||
        !Number.isFinite(size) ||
        size <= 0 ||
        !Number.isFinite(value) ||
        value <= 0 ||
        value > Number.MAX_SAFE_INTEGER
      )
        fail(
          502,
          "MISSING_MARKET_PRICE",
          "A reliable current notional is unavailable.",
        );
      return value;
    },
    async submitPerp(prepared, signature, walletAddress) {
      validEvm(walletAddress);
      if (
        !integer(prepared.nonce) ||
        !integer(prepared.expiresAfter) ||
        prepared.expiresAfter <= Date.now() ||
        prepared.expiresAfter > prepared.nonce + 60_000 ||
        prepared.nonce > Date.now() + 30_000
      )
        fail(
          409,
          "ORDER_EXPIRED",
          "Prepared order expired or has an invalid nonce",
        );
      const action = object(prepared.action);
      if (
        action.type !== "order" ||
        action.grouping !== "na" ||
        !Array.isArray(action.orders) ||
        action.orders.length !== 1 ||
        action.orders[0].c !== prepared.cloid
      )
        fail(400, "INVALID_PREPARED_ORDER", "Stored order is invalid");
      const typedData = await perpTypedData(prepared);
      if (JSON.stringify(typedData) !== JSON.stringify(prepared.typedData))
        fail(
          400,
          "ORDER_CHANGED",
          "Stored signing payload does not match the prepared order",
        );
      let recovered: string;
      let parsed: ReturnType<typeof parseSignature>;
      try {
        recovered = await recoverTypedDataAddress({
          ...typedData,
          signature: signature as Hex,
        });
        parsed = parseSignature(signature as Hex);
      } catch {
        return fail(400, "INVALID_SIGNATURE", "Invalid order signature");
      }
      if (recovered.toLowerCase() !== walletAddress.toLowerCase())
        fail(
          400,
          "WRONG_SIGNER",
          "Order signature does not belong to the linked wallet",
        );
      const raw = object(
        await post(`${hl}/exchange`, {
          action: prepared.action,
          nonce: prepared.nonce,
          expiresAfter: prepared.expiresAfter,
          signature: {
            r: parsed.r,
            s: parsed.s,
            v: Number(parsed.v ?? BigInt((parsed.yParity ?? 0) + 27)),
          },
        }),
      );
      const statuses = raw.response?.data?.statuses;
      if (
        raw.status !== "ok" ||
        !Array.isArray(statuses) ||
        statuses.length !== 1 ||
        statuses.some((status: any) => status?.error)
      )
        fail(422, "ORDER_REJECTED", "Hyperliquid rejected the order");
      const state = statuses[0];
      if (state?.filled)
        return { reference: prepared.cloid, status: "filled", raw };
      if (state?.resting)
        return { reference: prepared.cloid, status: "resting", raw };
      return fail(
        502,
        "INVALID_PROVIDER_RESPONSE",
        "Hyperliquid returned no recognized order result",
      );
    },
    async perpStatus(walletAddress, cloid): Promise<SubmitResult> {
      validEvm(walletAddress);
      if (!/^0x[0-9a-fA-F]{32}$/.test(cloid))
        fail(400, "INVALID_ORDER_ID", "Invalid client order ID");
      const raw = object(
        await info({ type: "orderStatus", user: walletAddress, oid: cloid }),
      );
      const status = raw.status === "order" ? raw.order?.status : undefined;
      const details = raw.order?.order;
      const original = Number(details?.origSz),
        remaining = Number(details?.sz);
      const sizesValid =
        Number.isFinite(original) &&
        original > 0 &&
        Number.isFinite(remaining) &&
        remaining >= 0 &&
        remaining <= original;
      const canceled =
        typeof status === "string" && /canceled|cancel/i.test(status);
      // A canceled remainder never erases already executed exposure. Reserve the full
      // original intent conservatively; exact released notional needs a fill ledger.
      return {
        reference: cloid,
        status:
          status === "filled"
            ? "filled"
            : status === "open"
              ? "resting"
              : canceled
                ? sizesValid
                  ? remaining < original
                    ? "partially_filled"
                    : "failed"
                  : "unknown"
                : typeof status === "string" && /rejected/i.test(status)
                  ? "failed"
                  : "unknown",
        raw,
      };
    },
    async portfolio(wallet) {
      if (wallet.chain === "solana") {
        validSolana(wallet.address);
        const [native, tokens, token2022] = await Promise.all([
          rpc("getBalance", [wallet.address, { commitment: "confirmed" }]),
          rpc("getTokenAccountsByOwner", [
            wallet.address,
            { programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" },
            { encoding: "jsonParsed", commitment: "confirmed" },
          ]),
          rpc("getTokenAccountsByOwner", [
            wallet.address,
            { programId: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" },
            { encoding: "jsonParsed", commitment: "confirmed" },
          ]),
        ]);
        return {
          chain: "solana",
          walletAddress: wallet.address,
          native,
          tokens,
          token2022,
        };
      }
      validEvm(wallet.address);
      const [perps, spot] = await Promise.all([
        info({ type: "clearinghouseState", user: wallet.address }),
        info({ type: "spotClearinghouseState", user: wallet.address }),
      ]);
      return {
        chain: "ethereum",
        walletAddress: wallet.address,
        perps,
        spot,
        testnet: config.hyperliquidTestnet,
      };
    },
    async markets() {
      const raw = await info({ type: "metaAndAssetCtxs" });
      if (
        !Array.isArray(raw) ||
        !Array.isArray(raw[0]?.universe) ||
        !Array.isArray(raw[1])
      )
        fail(502, "INVALID_PROVIDER_RESPONSE", "Invalid Hyperliquid markets");
      return {
        venue: "hyperliquid",
        testnet: config.hyperliquidTestnet,
        markets: raw[0].universe.map((market: any, index: number) => ({
          ...market,
          asset: index,
          ...raw[1][index],
        })),
      };
    },
  };
}
