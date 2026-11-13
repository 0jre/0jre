/** Paper trading only: no wallets, signing, deposits, or real transactions. */
export type Market = {
  id: string;
  symbol: string;
  name: string;
  venue: string;
  kind: 'spot' | 'perp';
  price: number;
  change: number;
  volume: number;
  liquidity: number;
  color: string;
  history: number[];
};
export type Agent = {
  id: string;
  name: string;
  strategy: string;
  active: boolean;
  budget: number;
  maxOrder: number;
  maxLeverage: number;
  /** Cumulative entry notional; closing does not replenish this risk budget. */
  spent: number;
};
export type Position = {
  id: string;
  marketId: string;
  side: 'long' | 'short';
  quantity: number;
  entry: number;
  leverage: number;
  margin: number;
};
export type Trade = {
  id: string;
  marketId: string;
  side: 'long' | 'short';
  notional: number;
  price: number;
  agentId?: string;
  timestamp: number;
};
export type Account = {
  cash: number;
  positions: Position[];
  trades: Trade[];
  agents: Agent[];
  killed: boolean;
};

// Real symbols, explicitly illustrative fixed prices, NOT executable/live quotes.
const seed = (
  id: string, symbol: string, name: string, venue: string, kind: Market['kind'],
  price: number, change: number, volume: number, liquidity: number, color: string,
): Market => ({
  id, symbol, name, venue, kind, price, change, volume, liquidity, color,
  history: [0.94, 0.97, 0.95, 1.01, 0.98, 1.04, 1.02, 1].map((scale) => price * scale),
});
export const markets: Market[] = [
  seed('sol-spot', 'SOL', 'Solana', 'Jupiter', 'spot', 148.5, 4.2, 482_000_000, 94_000_000, '#a58aff'),
  seed('bonk-spot', 'BONK', 'Bonk', 'Raydium', 'spot', 0.0000214, 8.6, 38_000_000, 9_400_000, '#ffb35c'),
  seed('wif-spot', 'WIF', 'dogwifhat', 'Jupiter', 'spot', 1.24, -2.3, 61_000_000, 12_000_000, '#d9b68c'),
  seed('popcat-spot', 'POPCAT', 'Popcat', 'Meteora', 'spot', 0.42, 12.8, 24_000_000, 6_100_000, '#f5a778'),
  seed('pump-spot', 'PUMP', 'Pump', 'Pump.fun', 'spot', 0.0032, 6.4, 45_000_000, 8_600_000, '#71e4b6'),
  seed('btc-perp', 'BTC', 'Bitcoin perpetual', 'Hyperliquid', 'perp', 97_250, 1.8, 1_920_000_000, 320_000_000, '#f6b84f'),
  seed('eth-perp', 'ETH', 'Ethereum perpetual', 'Hyperliquid', 'perp', 2_680, -0.7, 840_000_000, 180_000_000, '#8da8ff'),
  seed('sol-perp', 'SOL', 'Solana perpetual', 'Hyperliquid', 'perp', 148.7, 4.4, 360_000_000, 62_000_000, '#a58aff'),
];

export function createAccount(): Account {
  return {
    cash: 10_000, positions: [], trades: [], killed: false,
    agents: [
      { id: 'momentum', name: 'Momentum Scout', strategy: 'Momentum long', active: true, budget: 2_000, maxOrder: 500, maxLeverage: 2, spent: 0 },
      { id: 'dip', name: 'Dip Hunter', strategy: 'Buy the dip', active: false, budget: 1_500, maxOrder: 250, maxLeverage: 1, spent: 0 },
      { id: 'hedge', name: 'Perp Sentinel', strategy: 'Short hedge', active: false, budget: 2_500, maxOrder: 750, maxLeverage: 3, spent: 0 },
    ],
  };
}

function finite(value: number, label: string, positive = false): void {
  if (!Number.isFinite(value) || (positive ? value <= 0 : value < 0)) {
    throw new Error(`${label} must be a finite ${positive ? 'positive' : 'non-negative'} number.`);
  }
}
function validateMarket(market: Market): void {
  if (!market.id || !['spot', 'perp'].includes(market.kind)) throw new Error('Invalid market.');
  finite(market.price, 'Market price', true);
}
function findAgent(account: Account, id: string): Agent {
  const agent = account.agents.find((item) => item.id === id);
  if (!agent) throw new Error('Agent not found.');
  if (!agent.active) throw new Error('Agent is inactive.');
  finite(agent.budget, 'Agent budget');
  finite(agent.maxOrder, 'Agent maximum order', true);
  finite(agent.spent, 'Agent spent');
  if (!Number.isInteger(agent.maxLeverage) || agent.maxLeverage < 1 || agent.maxLeverage > 10) {
    throw new Error('Agent maximum leverage must be an integer from 1 to 10.');
  }
  return agent;
}
function copy(account: Account): Account {
  return {
    ...account,
    positions: account.positions.map((item) => ({ ...item })),
    trades: account.trades.map((item) => ({ ...item })),
    agents: account.agents.map((item) => ({ ...item })),
  };
}
// Simulated event time advances one minute per fill; identical inputs produce identical results.
function nextTrade(account: Account): Pick<Trade, 'id' | 'timestamp'> {
  return { id: `trade-${account.trades.length + 1}`, timestamp: Date.UTC(2025, 0, 1) + account.trades.length * 60_000 };
}

/** amount is margin in USD; notional = amount * leverage. Throws on invalid/risky orders. */
export function executeOrder(
  account: Account, market: Market, side: Position['side'], amount: number,
  leverage = 1, agentId?: string,
): Account {
  if (account.killed) throw new Error('Kill switch is enabled. Resume trading before opening orders.');
  validateMarket(market);
  finite(account.cash, 'Account cash');
  finite(amount, 'Margin', true);
  if (side !== 'long' && side !== 'short') throw new Error('Invalid order side.');
  if (!Number.isInteger(leverage) || leverage < 1 || leverage > 10) {
    throw new Error('Leverage must be an integer from 1 to 10.');
  }
  if (market.kind === 'spot' && (side !== 'long' || leverage !== 1)) {
    throw new Error('Spot orders must be long with 1x leverage.');
  }
  const notional = amount * leverage;
  const quantity = notional / market.price;
  finite(notional, 'Notional', true);
  finite(quantity, 'Quantity', true);
  if (amount > account.cash) throw new Error('Insufficient paper funds.');
  if (agentId !== undefined) {
    const agent = findAgent(account, agentId);
    if (leverage > agent.maxLeverage) throw new Error('Order exceeds agent maximum leverage.');
    if (notional > agent.maxOrder) throw new Error('Order exceeds agent maximum order notional.');
    if (notional > agent.budget - agent.spent) throw new Error('Order exceeds remaining agent budget.');
  }
  const next = copy(account);
  const event = nextTrade(account);
  next.cash -= amount;
  next.positions.push({ id: `position-${account.trades.length + 1}`, marketId: market.id, side, quantity, entry: market.price, leverage, margin: amount });
  next.trades.push({ ...event, marketId: market.id, side, notional, price: market.price, ...(agentId === undefined ? {} : { agentId }) });
  if (agentId !== undefined) next.agents.find((agent) => agent.id === agentId)!.spent += notional;
  return next;
}

/** Isolated simulated positions: losses are capped at posted margin, without cross-margin debt. */
function positionEquity(position: Position, price: number): number {
  finite(position.quantity, 'Position quantity', true);
  finite(position.entry, 'Position entry', true);
  finite(position.margin, 'Position margin', true);
  const pnl = (price - position.entry) * position.quantity * (position.side === 'long' ? 1 : -1);
  if (!Number.isFinite(pnl)) throw new Error('Position PnL exceeds numeric limits.');
  return Math.max(0, position.margin + pnl);
}

/** Closing is allowed even when killed or an agent is paused, so risk can always be reduced. */
export function closePosition(account: Account, positionId: string, market: Market): Account {
  const position = account.positions.find((item) => item.id === positionId);
  if (!position) throw new Error('Position not found.');
  if (position.marketId !== market.id) throw new Error('Market does not match position.');
  validateMarket(market);
  finite(account.cash, 'Account cash');
  const proceeds = positionEquity(position, market.price);
  finite(account.cash + proceeds, 'Resulting cash');
  const notional = position.quantity * market.price;
  finite(notional, 'Closing notional', true);
  const next = copy(account);
  next.cash += proceeds;
  next.positions = next.positions.filter((item) => item.id !== positionId);
  next.trades.push({ ...nextTrade(account), marketId: market.id, side: position.side === 'long' ? 'short' : 'long', notional, price: market.price });
  return next;
}

export function setAgentActive(account: Account, agentId: string, active: boolean): Account {
  if (!account.agents.some((agent) => agent.id === agentId)) throw new Error('Agent not found.');
  if (typeof active !== 'boolean') throw new Error('Agent active must be boolean.');
  const next = copy(account);
  next.agents.find((agent) => agent.id === agentId)!.active = active;
  return next;
}
export function setKillSwitch(account: Account, killed: boolean): Account {
  if (typeof killed !== 'boolean') throw new Error('Kill switch must be boolean.');
  return { ...copy(account), killed };
}
export function accountEquity(account: Account, currentMarkets: Market[]): number {
  finite(account.cash, 'Account cash');
  const equity = account.positions.reduce((sum, position) => {
    const market = currentMarkets.find((item) => item.id === position.marketId);
    if (!market) throw new Error(`Missing market for position: ${position.marketId}`);
    validateMarket(market);
    return sum + positionEquity(position, market.price);
  }, account.cash);
  finite(equity, 'Account equity');
  return equity;
}

/** One explicit deterministic demo action; never runs on a timer or sends a real order. */
export function runAgent(account: Account, agentId: string, market: Market): Account {
  if (account.killed) throw new Error('Kill switch is enabled.');
  validateMarket(market);
  finite(account.cash, 'Account cash');
  const agent = findAgent(account, agentId);
  const leverage = market.kind === 'spot' ? 1 : Math.min(2, agent.maxLeverage);
  const side = market.kind === 'perp' && agent.strategy.toLowerCase().includes('short') ? 'short' : 'long';
  const amount = Math.min(125, account.cash, agent.maxOrder / leverage, (agent.budget - agent.spent) / leverage);
  if (amount <= 0) throw new Error('No available paper funds or remaining agent budget.');
  return executeOrder(account, market, side, amount, leverage, agentId);
}
