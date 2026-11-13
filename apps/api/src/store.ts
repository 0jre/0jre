import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";

export class ApiError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export type OrderStatus =
  | "prepared"
  | "submitting"
  | "submitted"
  | "confirmed"
  | "filled"
  | "partially_filled"
  | "resting"
  | "failed"
  | "unknown"
  | "canceled"
  | "expired";
export interface RiskPolicy {
  killed: boolean;
  maxOrderCents: number;
  dailyLimitCents: number;
  maxSlippageBps: number;
}
export interface AgentRecord {
  id: string;
  userId: string;
  name: string;
  walletAddress: string;
  venue: "solana" | "hyperliquid";
  enabled: boolean;
  budgetCents: number;
  maxOrderCents: number;
  createdAt: number;
}
export interface QuoteRecord {
  id: string;
  userId: string;
  walletAddress: string;
  input: unknown;
  data: unknown;
  notionalCents: number;
  createdAt: number;
  expiresAt: number;
}
export interface OrderRecord {
  id: string;
  userId: string;
  walletAddress: string;
  venue: "solana" | "hyperliquid";
  agentId?: string;
  quoteId?: string;
  reduceOnly: boolean;
  notionalCents: number;
  prepared: unknown;
  idempotencyKey: string;
  fingerprint: string;
  createdAt: number;
  expiresAt: number;
  status: OrderStatus;
  reference?: string;
  signedHash?: string;
  error?: string;
  result?: unknown;
}
const RESERVED =
  "'prepared','submitting','submitted','confirmed','filled','partially_filled','resting','unknown'";
export class Store {
  readonly db: DatabaseSync;
  constructor(path = ":memory:") {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db
      .exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
   CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, policy TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS nonces(wallet TEXT PRIMARY KEY,value INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS agents(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),data TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS quotes(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires_at INTEGER NOT NULL,data TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),idempotency_key TEXT NOT NULL,quote_id TEXT,agent_id TEXT,status TEXT NOT NULL,notional_cents INTEGER NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,data TEXT NOT NULL,UNIQUE(user_id,idempotency_key));
   CREATE UNIQUE INDEX IF NOT EXISTS quote_once ON orders(quote_id) WHERE quote_id IS NOT NULL;
   CREATE INDEX IF NOT EXISTS user_orders ON orders(user_id,created_at);
   CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id TEXT NOT NULL,event TEXT NOT NULL,subject TEXT NOT NULL,created_at INTEGER NOT NULL);
   PRAGMA user_version=1;`);
    // A crash during dispatch is ambiguous, never an invitation to dispatch again.
    const interrupted = this.db
      .prepare("SELECT data FROM orders WHERE status='submitting'")
      .all() as { data: string }[];
    for (const row of interrupted) {
      const o = JSON.parse(row.data) as OrderRecord;
      o.status = "unknown";
      o.error = "Dispatch interrupted; reconcile before any further action.";
      this.saveOrder(o);
    }
  }
  close() {
    this.db.close();
  }
  nextNonce(wallet: string, now: number): number {
    return this.transaction(() => {
      const address = wallet.toLowerCase();
      const row = this.db
        .prepare("SELECT value FROM nonces WHERE wallet=?")
        .get(address) as { value: number } | undefined;
      const value = Math.max(now, (row?.value ?? 0) + 1);
      if (value > now + 1000)
        throw new ApiError(
          429,
          "nonce_limit",
          "Too many orders prepared for this wallet.",
        );
      this.db
        .prepare(
          "INSERT INTO nonces(wallet,value) VALUES(?,?) ON CONFLICT(wallet) DO UPDATE SET value=excluded.value",
        )
        .run(address, value);
      return value;
    });
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  ensureUser(id: string) {
    this.db.prepare("INSERT OR IGNORE INTO users(id,policy) VALUES(?,?)").run(
      id,
      JSON.stringify({
        killed: false,
        maxOrderCents: 10000,
        dailyLimitCents: 100000,
        maxSlippageBps: 100,
      }),
    );
  }
  policy(id: string): RiskPolicy {
    this.ensureUser(id);
    return JSON.parse(
      (
        this.db.prepare("SELECT policy FROM users WHERE id=?").get(id) as {
          policy: string;
        }
      ).policy,
    );
  }
  setPolicy(id: string, policy: RiskPolicy) {
    this.ensureUser(id);
    this.db
      .prepare("UPDATE users SET policy=? WHERE id=?")
      .run(JSON.stringify(policy), id);
    this.audit(id, "risk.updated", id);
    return policy;
  }
  audit(userId: string, event: string, subject: string) {
    this.db
      .prepare(
        "INSERT INTO audit(user_id,event,subject,created_at) VALUES(?,?,?,?)",
      )
      .run(userId, event, subject, Date.now());
  }
  auditLog(userId: string) {
    return this.db
      .prepare(
        "SELECT event,subject,created_at AS createdAt FROM audit WHERE user_id=? ORDER BY id DESC LIMIT 200",
      )
      .all(userId);
  }
  addQuote(q: Omit<QuoteRecord, "id">): QuoteRecord {
    const out = { ...q, id: randomUUID() };
    this.db
      .prepare("INSERT INTO quotes VALUES(?,?,?,?)")
      .run(out.id, out.userId, out.expiresAt, JSON.stringify(out));
    return out;
  }
  quote(userId: string, id: string): QuoteRecord {
    const row = this.db
      .prepare("SELECT data FROM quotes WHERE id=? AND user_id=?")
      .get(id, userId) as { data: string } | undefined;
    if (!row) throw new ApiError(404, "not_found", "Quote not found.");
    return JSON.parse(row.data);
  }
  agents(userId: string): AgentRecord[] {
    return (
      this.db
        .prepare("SELECT data FROM agents WHERE user_id=? ORDER BY rowid")
        .all(userId) as { data: string }[]
    ).map((x) => JSON.parse(x.data));
  }
  agent(userId: string, id: string): AgentRecord {
    const out = this.agents(userId).find((a) => a.id === id);
    if (!out) throw new ApiError(404, "not_found", "Agent not found.");
    return out;
  }
  saveAgent(a: AgentRecord) {
    this.db
      .prepare(
        "INSERT INTO agents(id,user_id,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(a.id, a.userId, JSON.stringify(a));
    return a;
  }
  expire(now: number) {
    const rows = this.db
      .prepare(
        "SELECT data FROM orders WHERE status='prepared' AND expires_at<=?",
      )
      .all(now) as { data: string }[];
    for (const row of rows) {
      const o = JSON.parse(row.data) as OrderRecord;
      this.saveOrder({ ...o, status: "expired" });
    }
  }
  order(userId: string, id: string): OrderRecord {
    const row = this.db
      .prepare("SELECT data FROM orders WHERE id=? AND user_id=?")
      .get(id, userId) as { data: string } | undefined;
    if (!row) throw new ApiError(404, "not_found", "Order not found.");
    return JSON.parse(row.data);
  }
  existing(
    userId: string,
    key: string,
    fingerprint: string,
  ): OrderRecord | undefined {
    const row = this.db
      .prepare("SELECT data FROM orders WHERE user_id=? AND idempotency_key=?")
      .get(userId, key) as { data: string } | undefined;
    if (!row) return;
    const o = JSON.parse(row.data) as OrderRecord;
    if (o.fingerprint !== fingerprint)
      throw new ApiError(
        409,
        "idempotency_conflict",
        "Idempotency key already used for a different request.",
      );
    return o;
  }
  orders(userId: string): OrderRecord[] {
    return (
      this.db
        .prepare(
          "SELECT data FROM orders WHERE user_id=? ORDER BY created_at DESC LIMIT 200",
        )
        .all(userId) as { data: string }[]
    ).map((x) => JSON.parse(x.data));
  }
  saveOrder(o: OrderRecord) {
    this.db
      .prepare(
        "UPDATE orders SET status=?,notional_cents=?,data=? WHERE id=? AND user_id=?",
      )
      .run(o.status, o.notionalCents, JSON.stringify(o), o.id, o.userId);
    return o;
  }
  applyOutcome(
    userId: string,
    id: string,
    patch: Pick<OrderRecord, "status"> &
      Partial<Pick<OrderRecord, "reference" | "result" | "error">>,
  ): OrderRecord {
    return this.transaction(() => {
      const current = this.order(userId, id);
      if (["filled", "confirmed"].includes(current.status)) return current;
      if (
        current.status === "partially_filled" &&
        !["filled", "confirmed"].includes(patch.status)
      )
        return current;
      if (
        current.status === "resting" &&
        ["unknown", "submitted", "submitting"].includes(patch.status)
      )
        return current;
      return this.saveOrder({ ...current, ...patch });
    });
  }
  reserve(o: OrderRecord, now: number): OrderRecord {
    return this.transaction(() => {
      const existing = this.existing(o.userId, o.idempotencyKey, o.fingerprint);
      if (existing) return existing;
      this.expire(now);
      this.checkRisk(o, now, true);
      if (
        o.quoteId &&
        this.db.prepare("SELECT id FROM orders WHERE quote_id=?").get(o.quoteId)
      )
        throw new ApiError(
          409,
          "quote_used",
          "This quote already has an order. Request a fresh quote.",
        );
      this.db
        .prepare("INSERT INTO orders VALUES(?,?,?,?,?,?,?,?,?,?)")
        .run(
          o.id,
          o.userId,
          o.idempotencyKey,
          o.quoteId ?? null,
          o.agentId ?? null,
          o.status,
          o.notionalCents,
          o.createdAt,
          o.expiresAt,
          JSON.stringify(o),
        );
      this.audit(o.userId, "order.prepared", o.id);
      return o;
    });
  }
  checkRisk(o: OrderRecord, now: number, newReservation: boolean) {
    const p = this.policy(o.userId);
    if (o.venue === "solana" && o.quoteId) {
      const quote = this.quote(o.userId, o.quoteId).data as {
        slippageBps: number;
      };
      if (quote.slippageBps > p.maxSlippageBps)
        throw new ApiError(
          403,
          "slippage_limit",
          "Quote exceeds current slippage policy.",
        );
    }
    if (p.killed && !o.reduceOnly)
      throw new ApiError(
        403,
        "kill_switch",
        "New exposure is paused. Reduce-only perpetual orders remain permitted.",
      );
    if (o.notionalCents > p.maxOrderCents && !o.reduceOnly)
      throw new ApiError(
        403,
        "order_limit",
        "Order exceeds per-order risk limit.",
      );
    const start = new Date(now);
    start.setUTCHours(0, 0, 0, 0);
    const spent = Number(
      (
        this.db
          .prepare(
            `SELECT COALESCE(SUM(notional_cents),0) AS spent FROM orders WHERE user_id=? AND status IN (${RESERVED}) AND created_at>=?`,
          )
          .get(o.userId, start.getTime()) as { spent: number }
      ).spent,
    );
    if (
      !o.reduceOnly &&
      spent + (newReservation ? o.notionalCents : 0) > p.dailyLimitCents
    )
      throw new ApiError(
        403,
        "daily_limit",
        "Daily notional limit exceeded, including reserved orders.",
      );
    if (o.agentId) {
      const a = this.agent(o.userId, o.agentId);
      if (
        !a.enabled ||
        (o.venue === "hyperliquid"
          ? a.walletAddress.toLowerCase() !== o.walletAddress.toLowerCase()
          : a.walletAddress !== o.walletAddress) ||
        a.venue !== o.venue
      )
        throw new ApiError(
          403,
          "agent_scope",
          "Agent is paused or outside wallet/venue scope.",
        );
      const sum = Number(
        (
          this.db
            .prepare(
              `SELECT COALESCE(SUM(notional_cents),0) AS spent FROM orders WHERE agent_id=? AND user_id=? AND status IN (${RESERVED})`,
            )
            .get(a.id, o.userId) as { spent: number }
        ).spent,
      );
      if (
        !o.reduceOnly &&
        (o.notionalCents > a.maxOrderCents ||
          sum + (newReservation ? o.notionalCents : 0) > a.budgetCents)
      )
        throw new ApiError(
          403,
          "agent_budget",
          "Agent budget or maximum order exceeded.",
        );
    }
  }
  claim(
    userId: string,
    id: string,
    signedHash: string,
    reference: string,
    now: number,
    refreshedCents?: number,
  ): { order: OrderRecord; dispatch: boolean } {
    return this.transaction(() => {
      this.expire(now);
      const o = this.order(userId, id);
      if (o.signedHash && o.signedHash !== signedHash)
        throw new ApiError(
          409,
          "signature_conflict",
          "This order already received another signed payload.",
        );
      if (o.status !== "prepared") return { order: o, dispatch: false };
      if (o.expiresAt <= now)
        throw new ApiError(409, "expired", "Order expired.");
      if (refreshedCents !== undefined) {
        if (!Number.isSafeInteger(refreshedCents) || refreshedCents <= 0)
          throw new ApiError(
            422,
            "invalid_valuation",
            "Invalid risk valuation.",
          );
        o.notionalCents = Math.max(o.notionalCents, refreshedCents);
        this.saveOrder(o);
      }
      this.checkRisk(o, now, false);
      const next = {
        ...o,
        status: "submitting" as const,
        signedHash,
        reference,
      };
      this.saveOrder(next);
      this.audit(userId, "order.dispatch", id);
      return { order: next, dispatch: true };
    });
  }
}
