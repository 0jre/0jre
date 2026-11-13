import assert from "node:assert/strict";
import test from "node:test";
import {
  accountEquity,
  closePosition,
  createAccount,
  executeOrder,
  markets,
  runAgent,
  setAgentActive,
  setKillSwitch,
} from "./domain";
import type { Account, Market } from "./domain";

const spot = markets.find((market) => market.id === "sol-spot")!;
const perp: Market = {
  ...markets.find((market) => market.id === "btc-perp")!,
  price: 100,
};
const mark = (price: number): Market => ({ ...perp, price });
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    Object.values(value).forEach(freeze);
  }
  return value;
}

test("fresh accounts have independent demo agents and empty paper holdings", () => {
  const first = createAccount();
  assert.equal(first.cash, 10_000);
  assert.equal(first.agents.length, 3);
  assert.deepEqual(first.positions, []);
  assert.deepEqual(first.trades, []);
  assert.equal(first.killed, false);
  first.agents[0].spent = 12;
  assert.equal(createAccount().agents[0].spent, 0);
  assert.equal(markets.length, 8);
  assert.deepEqual(
    new Set(markets.filter((m) => m.kind === "spot").map((m) => m.symbol)),
    new Set(["SOL", "BONK", "WIF", "POPCAT", "PUMP"]),
  );
});

test("amount is margin; only margin is deducted, not leveraged notional", () => {
  const account = executeOrder(createAccount(), perp, "long", 100, 3);
  assert.equal(account.cash, 9_900);
  assert.equal(account.positions[0].quantity, 3);
  assert.equal(account.positions[0].margin, 100);
  assert.equal(account.trades[0].notional, 300);
  assert.equal(accountEquity(account, [perp]), 10_000);
});

test("insufficient cash is rejected without affecting the account", () => {
  const account = createAccount();
  assert.throws(
    () => executeOrder(account, perp, "long", 10_001),
    /Insufficient/,
  );
  assert.equal(account.cash, 10_000);
  assert.equal(account.positions.length, 0);
});

test("non-finite, zero, negative, and overflow inputs are rejected", () => {
  for (const amount of [NaN, Infinity, -Infinity, 0, -1]) {
    assert.throws(
      () => executeOrder(createAccount(), perp, "long", amount),
      /Margin/,
    );
  }
  for (const price of [NaN, Infinity, 0, -1]) {
    assert.throws(
      () => executeOrder(createAccount(), mark(price), "long", 100),
      /Market price/,
    );
  }
  assert.throws(
    () => executeOrder({ ...createAccount(), cash: NaN }, perp, "long", 1),
    /Account cash/,
  );
  assert.throws(
    () =>
      executeOrder(
        { ...createAccount(), cash: Number.MAX_VALUE },
        perp,
        "long",
        Number.MAX_VALUE,
        10,
      ),
    /Notional/,
  );
  assert.throws(
    () => executeOrder(createAccount(), mark(Number.MIN_VALUE), "long", 100),
    /Quantity/,
  );
});

test("leverage must be a finite integer 1..10, spot is long-only and unlevered", () => {
  for (const leverage of [NaN, Infinity, 0, -1, 1.5, 11]) {
    assert.throws(
      () => executeOrder(createAccount(), perp, "long", 100, leverage),
      /Leverage/,
    );
  }
  assert.throws(
    () => executeOrder(createAccount(), spot, "short", 100),
    /Spot orders/,
  );
  assert.throws(
    () => executeOrder(createAccount(), spot, "long", 100, 2),
    /Spot orders/,
  );
  assert.equal(
    executeOrder(createAccount(), perp, "short", 100, 10).positions[0].leverage,
    10,
  );
});

test("long and short closes return margin plus correctly signed PnL", () => {
  for (const [side, exit, expected] of [
    ["long", 110, 10_020],
    ["long", 90, 9_980],
    ["short", 90, 10_020],
    ["short", 110, 9_980],
  ] as const) {
    const opened = executeOrder(createAccount(), perp, side, 100, 2);
    assert.equal(accountEquity(opened, [mark(exit)]), expected);
    const closed = closePosition(opened, opened.positions[0].id, mark(exit));
    assert.equal(closed.cash, expected);
    assert.equal(closed.positions.length, 0);
    assert.equal(closed.trades.length, 2);
    assert.equal(closed.trades[1].side, side === "long" ? "short" : "long");
  }
});

test("isolated losses never draw on cash or produce negative position equity", () => {
  const opened = executeOrder(createAccount(), perp, "short", 100, 10);
  assert.equal(accountEquity(opened, [mark(1_000)]), 9_900);
  const closed = closePosition(opened, opened.positions[0].id, mark(1_000));
  assert.equal(closed.cash, 9_900);
});

test("wrong, missing, and invalid markets cannot close or value positions", () => {
  const opened = executeOrder(createAccount(), perp, "short", 100);
  assert.throws(
    () => closePosition(opened, opened.positions[0].id, spot),
    /does not match/,
  );
  assert.throws(
    () => closePosition(opened, "unknown", perp),
    /Position not found/,
  );
  assert.throws(
    () => closePosition(opened, opened.positions[0].id, mark(NaN)),
    /Market price/,
  );
  assert.throws(() => accountEquity(opened, []), /Missing market/);
});

test("kill switch blocks manual and agent entries, permits closes, and resumes without activating paused agents", () => {
  const account = executeOrder(createAccount(), perp, "long", 100);
  const killed = setKillSwitch(account, true);
  assert.throws(() => executeOrder(killed, perp, "long", 10), /Kill switch/);
  assert.throws(() => runAgent(killed, "momentum", perp), /Kill switch/);
  assert.equal(
    closePosition(killed, account.positions[0].id, perp).positions.length,
    0,
  );
  const resumed = setKillSwitch(killed, false);
  assert.equal(executeOrder(resumed, perp, "long", 10).positions.length, 2);
  assert.throws(() => runAgent(resumed, "dip", perp), /inactive/);
  assert.throws(
    () => executeOrder(resumed, perp, "long", 10, 1, "dip"),
    /inactive/,
  );
  const active = setAgentActive(resumed, "dip", true);
  assert.equal(runAgent(active, "dip", spot).trades.length, 2);
  assert.throws(() => setAgentActive(active, "missing", true), /not found/);
});

test("agent maximum order and budget use notional, not margin", () => {
  const account = createAccount();
  account.agents[0] = { ...account.agents[0], maxOrder: 300, budget: 500 };
  assert.throws(
    () => executeOrder(account, perp, "long", 151, 2, "momentum"),
    /maximum order/,
  );
  const once = executeOrder(account, perp, "long", 150, 2, "momentum");
  assert.equal(once.agents[0].spent, 300);
  assert.throws(
    () => executeOrder(once, perp, "long", 101, 2, "momentum"),
    /remaining agent budget/,
  );
  const twice = executeOrder(once, perp, "long", 100, 2, "momentum");
  assert.equal(twice.agents[0].spent, 500);
  assert.throws(
    () => runAgent(twice, "momentum", perp),
    /remaining agent budget/,
  );
  const closed = closePosition(twice, twice.positions[0].id, perp);
  assert.equal(closed.agents[0].spent, 500);
});

test("agent leverage, identity, and malformed risk values are validated", () => {
  const account = createAccount();
  assert.throws(
    () => executeOrder(account, perp, "long", 100, 3, "momentum"),
    /maximum leverage/,
  );
  assert.throws(
    () => executeOrder(account, perp, "long", 100, 1, "missing"),
    /not found/,
  );
  account.agents[0].budget = NaN;
  assert.throws(() => runAgent(account, "momentum", perp), /Agent budget/);
});

test("runAgent executes exactly one deterministic bounded order including short hedges", () => {
  const account = createAccount();
  assert.deepEqual(
    runAgent(account, "momentum", perp),
    runAgent(account, "momentum", perp),
  );
  const limited = setAgentActive(account, "hedge", true);
  limited.agents[2] = {
    ...limited.agents[2],
    maxOrder: 50,
    budget: 35,
    spent: 10,
  };
  const result = runAgent(limited, "hedge", perp);
  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].side, "short");
  assert.equal(result.trades[0].notional, 25);
  assert.equal(result.trades[0].agentId, "hedge");
  assert.equal(result.agents[2].spent, 35);
  assert.equal(result.cash, 10_000 - 12.5);
});

test("all operations accept frozen inputs and do not mutate account or market", () => {
  const original = freeze(createAccount());
  const frozenMarket = freeze({ ...perp, history: [...perp.history] });
  const snapshot = JSON.stringify(original);
  const opened = freeze(
    executeOrder(original, frozenMarket, "long", 100, 2, "momentum"),
  );
  accountEquity(opened, [frozenMarket]);
  closePosition(opened, opened.positions[0].id, frozenMarket);
  setAgentActive(original, "dip", true);
  setKillSwitch(original, true);
  runAgent(original, "momentum", frozenMarket);
  assert.equal(JSON.stringify(original), snapshot);
  assert.equal(opened.positions.length, 1);
  assert.equal(opened.cash, 9_900);
});

test("decimal roundoff does not reject orders at cash and agent budget limits", () => {
  const account = createAccount();
  account.cash = 0.3;
  account.agents[0] = { ...account.agents[0], budget: 0.3, maxOrder: 0.2 };
  const once = executeOrder(account, spot, "long", 0.1, 1, "momentum");
  const twice = executeOrder(once, spot, "long", 0.2, 1, "momentum");
  assert.equal(twice.cash, 0);
  assert.equal(twice.agents[0].spent, 0.3);
  assert.ok(Math.abs(accountEquity(twice, [spot]) - 0.3) < Number.EPSILON);
  assert.throws(
    () => executeOrder(twice, spot, "long", 1e-20, 1, "momentum"),
    /Insufficient/,
  );

  const budgetOnly = { ...once, cash: 10 };
  assert.equal(
    executeOrder(budgetOnly, spot, "long", 0.2, 1, "momentum").agents[0].spent,
    0.3,
  );
  assert.throws(
    () => executeOrder(budgetOnly, spot, "long", 0.200001, 1, "momentum"),
    /maximum order/,
  );
});

test("spot agents obey remaining lifetime notional budgets", () => {
  const account = createAccount();
  account.agents[0] = { ...account.agents[0], budget: 175, maxOrder: 150 };
  const once = runAgent(account, "momentum", spot);
  const twice = runAgent(once, "momentum", spot);
  assert.equal(twice.trades[1].notional, 50);
  assert.equal(twice.agents[0].spent, 175);
  assert.throws(
    () => runAgent(twice, "momentum", spot),
    /remaining agent budget/,
  );
});

test("each isolated position is floored before summing account equity", () => {
  let account = executeOrder(createAccount(), perp, "long", 100, 10);
  account = executeOrder(account, perp, "short", 100, 10);
  // Long loses more than its margin; the short still keeps its own profit.
  assert.equal(accountEquity(account, [mark(1)]), 10_890);
  account = closePosition(account, account.positions[0].id, mark(1));
  assert.equal(accountEquity(account, [mark(1)]), 10_890);
  account = closePosition(account, account.positions[0].id, mark(1));
  assert.equal(account.cash, 10_890);
});

test("valuation and closes reject negative prices and numeric overflow", () => {
  const opened = executeOrder(createAccount(), perp, "long", 100, 10);
  assert.throws(() => accountEquity(opened, [mark(-1)]), /Market price/);
  assert.throws(
    () => closePosition(opened, opened.positions[0].id, mark(-1)),
    /Market price/,
  );
  assert.throws(
    () => accountEquity(opened, [mark(Number.MAX_VALUE)]),
    /numeric limits/,
  );
  assert.throws(
    () => closePosition(opened, opened.positions[0].id, mark(Number.MAX_VALUE)),
    /numeric limits/,
  );
  const rich = executeOrder(
    { ...createAccount(), cash: Number.MAX_VALUE },
    mark(1),
    "long",
    Number.MAX_VALUE / 2,
  );
  assert.throws(
    () => closePosition(rich, rich.positions[0].id, mark(4)),
    /numeric limits|Resulting cash/,
  );
});

test("position identifiers stay unique after closing and reopening", () => {
  let account: Account = executeOrder(createAccount(), perp, "long", 100);
  const firstId = account.positions[0].id;
  account = closePosition(account, firstId, perp);
  account = executeOrder(account, perp, "long", 100);
  assert.notEqual(account.positions[0].id, firstId);
  assert.equal(new Set(account.trades.map((trade) => trade.id)).size, 3);
  assert.ok(account.trades[2].timestamp > account.trades[1].timestamp);
});
