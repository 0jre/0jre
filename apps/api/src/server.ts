import Fastify, { FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { createHash, randomUUID } from "node:crypto";
import { z, ZodError } from "zod";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import type {
  Authenticator,
  Identity,
  PerpRequest,
  PreparedPerp,
  PreparedSpot,
  SpotQuote,
  VenueGateway,
  Wallet,
} from "./contracts.js";
import { ApiError, OrderRecord, Store } from "./store.js";

export interface ServerOptions {
  store: Store;
  auth: Authenticator;
  venues: VenueGateway;
  executionEnabled?: boolean;
  corsOrigins?: string[];
  maxOrderCents?: number;
  maxDailyCents?: number;
  now?: () => number;
  logger?: boolean;
}
const wallet = z.string().min(20).max(64);
const mint = z.string().refine((v) => {
  try {
    return new PublicKey(v).toBase58() === v;
  } catch {
    return false;
  }
}, "Invalid Solana mint.");
const atomic = z
  .string()
  .regex(/^[1-9][0-9]{0,19}$/)
  .refine(
    (v) => /^[0-9]+$/.test(v) && BigInt(v) <= 18446744073709551615n,
    "Amount exceeds u64.",
  );
const decimal = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,11})(\.[0-9]{1,12})?$/)
  .refine((v) => Number(v) > 0 && Number.isFinite(Number(v)));
const spotSchema = z
  .object({
    walletAddress: wallet,
    inputMint: mint,
    outputMint: mint,
    amount: atomic,
    slippageBps: z.number().int().min(1).max(500),
  })
  .strict()
  .refine(
    (v) => v.inputMint !== v.outputMint,
    "Input and output mint must differ.",
  );
const spotOrderSchema = z
  .object({ quoteId: z.uuid(), agentId: z.uuid().optional() })
  .strict();
const perpSchema = z
  .object({
    walletAddress: wallet,
    symbol: z.string().regex(/^[A-Z0-9]{1,15}$/),
    side: z.enum(["buy", "sell"]),
    size: decimal,
    limitPrice: decimal,
    reduceOnly: z.boolean().default(false),
    agentId: z.uuid().optional(),
  })
  .strict();
const hash = (data: unknown) =>
  createHash("sha256").update(JSON.stringify(data)).digest("hex");
function cents(n: number) {
  const value = Math.ceil(n * 100);
  if (!Number.isFinite(n) || n <= 0 || !Number.isSafeInteger(value))
    throw new ApiError(
      422,
      "invalid_valuation",
      "A reliable positive USD valuation is required.",
    );
  return value;
}
function sameAddress(a: string, b: string, chain: Wallet["chain"]) {
  return chain === "ethereum" ? a.toLowerCase() === b.toLowerCase() : a === b;
}
function own(
  identity: Identity,
  address: string,
  chain: Wallet["chain"],
): Wallet {
  const w = identity.wallets.find(
    (w) => w.chain === chain && sameAddress(w.address, address, chain),
  );
  if (!w)
    throw new ApiError(
      403,
      "wallet_not_owned",
      "Wallet is not linked to this authenticated Privy user.",
    );
  return w;
}
function key(req: FastifyRequest) {
  const k = req.headers["idempotency-key"];
  if (typeof k !== "string" || !/^[a-zA-Z0-9_-]{16,128}$/.test(k))
    throw new ApiError(
      400,
      "idempotency_required",
      "Supply a 16–128 character Idempotency-Key header.",
    );
  return k;
}
function signatureReference(base64: string) {
  let tx: VersionedTransaction;
  try {
    tx = VersionedTransaction.deserialize(Buffer.from(base64, "base64"));
  } catch {
    throw new ApiError(
      400,
      "invalid_transaction",
      "Invalid serialized Solana transaction.",
    );
  }
  const bytes = tx.signatures[0];
  if (!bytes || bytes.every((x) => x === 0))
    throw new ApiError(400, "missing_signature", "Transaction is unsigned.");
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = BigInt("0x" + Buffer.from(bytes).toString("hex"));
  let out = "";
  while (n) {
    out = alphabet[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

export async function buildServer(options: ServerOptions) {
  const { store, auth, venues } = options;
  const now = options.now ?? Date.now;
  const app = Fastify({
    bodyLimit: 64 * 1024,
    trustProxy: false,
    genReqId: () => randomUUID(),
    logger: options.logger
      ? {
          redact: [
            "req.headers.authorization",
            "req.headers.cookie",
            'req.headers["x-api-key"]',
          ],
        }
      : false,
  });
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: options.corsOrigins ?? [],
    credentials: false,
    allowedHeaders: ["Authorization", "Content-Type", "Idempotency-Key"],
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  });
  await app.register(rateLimit, { max: 100, timeWindow: "1 minute" });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError)
      return reply.code(400).send({
        error: "validation_error",
        message: "Invalid request.",
        issues: error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
    const e = error as {
      statusCode?: number;
      status?: number;
      code?: string;
      message?: string;
      name?: string;
    };
    const status = e.statusCode ?? e.status;
    if (status && status >= 400 && status < 500)
      return reply.code(status).send({
        error: e.code ?? "request_failed",
        message: e.message ?? "Request rejected.",
      });
    if (status === 503)
      return reply.code(503).send({
        error: e.code ?? "service_unavailable",
        message: "Required provider configuration or service is unavailable.",
      });
    app.log.error({ err: { name: e.name, code: e.code } }, "Request failed");
    return reply.code(502).send({
      error: "upstream_error",
      message: "Provider request failed. No automatic order retry was made.",
    });
  });
  const identity = async (req: FastifyRequest) => {
    const header = req.headers.authorization;
    if (!header || !/^Bearer [^\s]+$/.test(header))
      throw new ApiError(
        401,
        "unauthorized",
        "A Privy access token is required.",
      );
    const id = await auth.verify(header.slice(7));
    if (!id.userId.startsWith("did:privy:"))
      throw new ApiError(401, "unauthorized", "Invalid authenticated user.");
    store.ensureUser(id.userId);
    return id;
  };
  const expired = (until: number) => {
    if (until <= now())
      throw new ApiError(
        409,
        "expired",
        "Quote or order has expired. Request a fresh quote.",
      );
  };
  app.get("/health", async () => ({
    status: "ok",
    executionEnabled: options.executionEnabled === true,
    version: "0.1.0",
  }));
  app.get("/v1/me", async (req) => {
    const user = await identity(req);
    return { ...user, risk: store.policy(user.userId) };
  });
  app.get("/v1/markets", async () => venues.markets());
  app.get("/v1/portfolio", async (req) => {
    const user = await identity(req);
    const input = z
      .object({ walletAddress: wallet, chain: z.enum(["solana", "ethereum"]) })
      .strict()
      .parse(req.query);
    return venues.portfolio(own(user, input.walletAddress, input.chain));
  });
  app.get("/v1/risk", async (req) => {
    const user = await identity(req);
    return store.policy(user.userId);
  });
  app.patch("/v1/risk", async (req) => {
    const user = await identity(req);
    const patch = z
      .object({
        killed: z.boolean().optional(),
        maxOrderCents: z
          .number()
          .int()
          .min(1)
          .max(options.maxOrderCents ?? 1000000)
          .optional(),
        dailyLimitCents: z
          .number()
          .int()
          .min(1)
          .max(options.maxDailyCents ?? 10000000)
          .optional(),
        maxSlippageBps: z.number().int().min(1).max(500).optional(),
      })
      .strict()
      .parse(req.body);
    const next = { ...store.policy(user.userId), ...patch };
    if (next.maxOrderCents > next.dailyLimitCents)
      throw new ApiError(
        400,
        "invalid_policy",
        "Per-order limit cannot exceed daily limit.",
      );
    return store.setPolicy(user.userId, next);
  });
  app.get("/v1/agents", async (req) => {
    const user = await identity(req);
    return { agents: store.agents(user.userId) };
  });
  app.post("/v1/agents", async (req, reply) => {
    const user = await identity(req);
    const body = z
      .object({
        name: z.string().trim().min(1).max(64),
        walletAddress: wallet,
        venue: z.enum(["solana", "hyperliquid"]),
        budgetCents: z
          .number()
          .int()
          .min(1)
          .max(options.maxDailyCents ?? 10000000),
        maxOrderCents: z
          .number()
          .int()
          .min(1)
          .max(options.maxOrderCents ?? 1000000),
      })
      .strict()
      .parse(req.body);
    if (body.maxOrderCents > body.budgetCents)
      throw new ApiError(
        400,
        "invalid_budget",
        "Maximum order exceeds agent budget.",
      );
    if (store.agents(user.userId).length >= 20)
      throw new ApiError(409, "agent_limit", "Maximum 20 agents per user.");
    const linked = own(
      user,
      body.walletAddress,
      body.venue === "solana" ? "solana" : "ethereum",
    );
    const agent = store.saveAgent({
      ...body,
      walletAddress: linked.address,
      id: randomUUID(),
      userId: user.userId,
      enabled: false,
      createdAt: now(),
    });
    store.audit(user.userId, "agent.created", agent.id);
    return reply.code(201).send(agent);
  });
  app.patch("/v1/agents/:id", async (req) => {
    const user = await identity(req);
    const id = z.uuid().parse((req.params as { id: string }).id);
    const patch = z
      .object({
        enabled: z.boolean().optional(),
        name: z.string().trim().min(1).max(64).optional(),
        budgetCents: z
          .number()
          .int()
          .min(1)
          .max(options.maxDailyCents ?? 10000000)
          .optional(),
        maxOrderCents: z
          .number()
          .int()
          .min(1)
          .max(options.maxOrderCents ?? 1000000)
          .optional(),
      })
      .strict()
      .parse(req.body);
    const agent = { ...store.agent(user.userId, id), ...patch };
    own(
      user,
      agent.walletAddress,
      agent.venue === "solana" ? "solana" : "ethereum",
    );
    if (agent.maxOrderCents > agent.budgetCents)
      throw new ApiError(
        400,
        "invalid_budget",
        "Maximum order exceeds agent budget.",
      );
    store.audit(user.userId, "agent.updated", id);
    return store.saveAgent(agent);
  });
  app.post("/v1/quotes/spot", async (req, reply) => {
    const user = await identity(req);
    const input = spotSchema.parse(req.body);
    input.walletAddress = own(user, input.walletAddress, "solana").address;
    const policy = store.policy(user.userId);
    if (policy.killed)
      throw new ApiError(403, "kill_switch", "New exposure is paused.");
    if (input.slippageBps > policy.maxSlippageBps)
      throw new ApiError(
        403,
        "slippage_limit",
        "Slippage exceeds your risk policy.",
      );
    const quote = await venues.quoteSpot(input);
    const notionalCents = cents(await venues.spotNotionalUsd(quote));
    if (notionalCents > policy.maxOrderCents)
      throw new ApiError(
        403,
        "order_limit",
        "Quote exceeds your per-order USD limit.",
      );
    const q = store.addQuote({
      userId: user.userId,
      walletAddress: input.walletAddress,
      input,
      data: quote,
      notionalCents,
      createdAt: now(),
      expiresAt: now() + 30000,
    });
    store.audit(user.userId, "quote.created", q.id);
    return reply.code(201).send({
      id: q.id,
      walletAddress: q.walletAddress,
      quote,
      notionalCents: q.notionalCents,
      expiresAt: q.expiresAt,
    });
  });
  app.post("/v1/orders/spot", async (req, reply) => {
    const user = await identity(req);
    const body = spotOrderSchema.parse(req.body);
    const idem = key(req),
      fingerprint = hash({ venue: "solana", ...body });
    const existing = store.existing(user.userId, idem, fingerprint);
    if (existing) return existing;
    const quote = store.quote(user.userId, body.quoteId);
    own(user, quote.walletAddress, "solana");
    expired(quote.expiresAt);
    const raw = quote.data as SpotQuote;
    if (raw.slippageBps > store.policy(user.userId).maxSlippageBps)
      throw new ApiError(
        403,
        "slippage_limit",
        "Quote exceeds current slippage policy.",
      );
    const currentNotionalCents = cents(await venues.spotNotionalUsd(raw));
    const prepared = await venues.prepareSpot(raw, quote.walletAddress);
    expired(quote.expiresAt);
    const order = store.reserve(
      {
        id: randomUUID(),
        userId: user.userId,
        walletAddress: quote.walletAddress,
        venue: "solana",
        quoteId: quote.id,
        agentId: body.agentId,
        reduceOnly: false,
        notionalCents: Math.max(quote.notionalCents, currentNotionalCents),
        prepared,
        idempotencyKey: idem,
        fingerprint,
        createdAt: now(),
        expiresAt: quote.expiresAt,
        status: "prepared",
      },
      now(),
    );
    return reply.code(201).send(order);
  });
  app.post("/v1/orders/perp", async (req, reply) => {
    const user = await identity(req);
    const parsed = perpSchema.parse(req.body);
    parsed.walletAddress = own(user, parsed.walletAddress, "ethereum").address;
    const idem = key(req),
      fingerprint = hash({ venue: "hyperliquid", ...parsed });
    const existing = store.existing(user.userId, idem, fingerprint);
    if (existing) return existing;
    const id = randomUUID(),
      cloid = "0x" + id.replaceAll("-", "");
    const { agentId, ...input } = parsed;
    const prepared = await venues.preparePerp(
      input as PerpRequest,
      cloid,
      store.nextNonce(input.walletAddress, now()),
    );
    if (
      !Number.isFinite(prepared.expiresAfter) ||
      prepared.expiresAfter <= now() ||
      prepared.expiresAfter > now() + 120000
    )
      throw new ApiError(
        502,
        "invalid_expiry",
        "Provider returned an invalid order expiry.",
      );
    const order = store.reserve(
      {
        id,
        userId: user.userId,
        walletAddress: input.walletAddress,
        venue: "hyperliquid",
        agentId,
        reduceOnly: input.reduceOnly,
        notionalCents: cents(prepared.notionalUsd),
        prepared,
        idempotencyKey: idem,
        fingerprint,
        createdAt: now(),
        expiresAt: prepared.expiresAfter,
        status: "prepared",
      },
      now(),
    );
    return reply.code(201).send(order);
  });
  app.get("/v1/orders", async (req) => {
    const user = await identity(req);
    store.expire(now());
    return { orders: store.orders(user.userId) };
  });
  app.get("/v1/orders/:id", async (req) => {
    const user = await identity(req);
    store.expire(now());
    return store.order(
      user.userId,
      z.uuid().parse((req.params as { id: string }).id),
    );
  });
  app.post("/v1/orders/:id/cancel", async (req) => {
    const user = await identity(req);
    const id = z.uuid().parse((req.params as { id: string }).id);
    return store.transaction(() => {
      const order = store.order(user.userId, id);
      if (order.status !== "prepared")
        throw new ApiError(
          409,
          "already_dispatched",
          "Only unsigned prepared intents can be canceled here. Exchange orders require exchange cancellation.",
        );
      store.audit(user.userId, "order.canceled", id);
      return store.saveOrder({ ...order, status: "canceled" });
    });
  });
  app.post("/v1/orders/:id/submit", async (req) => {
    const user = await identity(req);
    const id = z.uuid().parse((req.params as { id: string }).id);
    const body = z
      .object({
        signedTransactionBase64: z.string().min(40).max(16000).optional(),
        signature: z
          .string()
          .regex(/^0x[0-9a-fA-F]{130}$/)
          .optional(),
      })
      .strict()
      .parse(req.body);
    const existing = store.order(user.userId, id);
    own(
      user,
      existing.walletAddress,
      existing.venue === "solana" ? "solana" : "ethereum",
    );
    if (
      (existing.venue === "solana" &&
        (!body.signedTransactionBase64 || body.signature)) ||
      (existing.venue === "hyperliquid" &&
        (!body.signature || body.signedTransactionBase64))
    )
      throw new ApiError(
        400,
        "signature_required",
        "Supply only the signature format required by this order.",
      );
    const signed = body.signedTransactionBase64 ?? body.signature!;
    const signedHash = hash(signed);
    if (existing.status !== "prepared") {
      if (existing.signedHash && existing.signedHash !== signedHash)
        throw new ApiError(
          409,
          "signature_conflict",
          "Signed payload differs from original submission.",
        );
      if (existing.status === "canceled" || existing.status === "expired")
        throw new ApiError(
          409,
          existing.status,
          "This order cannot be submitted.",
        );
      return existing;
    }
    if (!options.executionEnabled)
      throw new ApiError(
        503,
        "execution_disabled",
        "Live dispatch is disabled on this server.",
      );
    const reference =
      existing.venue === "solana"
        ? signatureReference(signed)
        : (existing.prepared as PreparedPerp).cloid;
    const refreshedCents =
      existing.venue === "solana"
        ? cents(
            await venues.spotNotionalUsd(
              store.quote(user.userId, existing.quoteId!).data as SpotQuote,
            ),
          )
        : cents(
            await venues.perpNotionalUsd(existing.prepared as PreparedPerp),
          );
    const claim = store.claim(
      user.userId,
      id,
      signedHash,
      reference,
      now(),
      refreshedCents,
    );
    if (!claim.dispatch) return claim.order;
    try {
      const result =
        existing.venue === "solana"
          ? await venues.submitSpot(
              existing.prepared as PreparedSpot,
              signed,
              existing.walletAddress,
            )
          : await venues.submitPerp(
              existing.prepared as PreparedPerp,
              signed,
              existing.walletAddress,
            );
      const status =
        result.status === "submitted" ||
        result.status === "confirmed" ||
        result.status === "filled" ||
        result.status === "partially_filled" ||
        result.status === "resting" ||
        result.status === "failed"
          ? result.status
          : "unknown";
      store.audit(user.userId, `order.${status}`, id);
      return store.applyOutcome(user.userId, id, {
        status,
        reference: result.reference || reference,
        result,
      });
    } catch (e) {
      const err = e as { statusCode?: number; code?: string };
      const unambiguous =
        err.statusCode !== undefined &&
        err.statusCode >= 400 &&
        err.statusCode < 500;
      store.audit(
        user.userId,
        unambiguous ? "order.rejected" : "order.ambiguous",
        id,
      );
      const final = store.applyOutcome(user.userId, id, {
        status: unambiguous ? "failed" : "unknown",
        error: unambiguous
          ? "Signature or order rejected before dispatch."
          : "Dispatch outcome uncertain. Reconcile; do not create a replacement order.",
      });
      if (
        ["filled", "confirmed", "partially_filled", "resting"].includes(
          final.status,
        )
      )
        return final;
      if (unambiguous) throw e;
      throw new ApiError(
        502,
        "dispatch_uncertain",
        "Dispatch outcome uncertain. Query this order and reconcile; it will not be automatically resubmitted.",
      );
    }
  });
  app.post("/v1/orders/:id/reconcile", async (req) => {
    const user = await identity(req);
    const order = store.order(
      user.userId,
      z.uuid().parse((req.params as { id: string }).id),
    );
    own(
      user,
      order.walletAddress,
      order.venue === "solana" ? "solana" : "ethereum",
    );
    if (
      !["submitting", "submitted", "unknown", "resting"].includes(order.status)
    )
      return order;
    if (!order.reference)
      throw new ApiError(409, "no_reference", "No dispatch reference exists.");
    const result =
      order.venue === "solana"
        ? await venues.spotStatus(order.reference)
        : await venues.perpStatus(
            order.walletAddress,
            (order.prepared as PreparedPerp).cloid,
          );
    const next = store.applyOutcome(user.userId, order.id, {
      status: result.status === "submitted" ? "submitted" : result.status,
      result,
    });
    store.audit(user.userId, `order.reconciled.${next.status}`, order.id);
    return next;
  });
  app.get("/v1/audit", async (req) => {
    const user = await identity(req);
    return { events: store.auditLog(user.userId) };
  });
  app.addHook("onClose", async () => store.close());
  return app;
}
