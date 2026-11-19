export type Chain = "solana" | "ethereum";
export interface Wallet {
  address: string;
  chain: Chain;
  id?: string;
}
export interface Identity {
  userId: string;
  wallets: Wallet[];
}
export interface Authenticator {
  verify(token: string): Promise<Identity>;
}
export interface SpotRequest {
  inputMint: string;
  outputMint: string;
  amount: string;
  slippageBps: number;
  walletAddress: string;
}
export interface SpotQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  minOutAmount: string;
  slippageBps: number;
  priceImpactPct: number;
  routeLabels: string[];
  raw: unknown;
}
export interface PreparedSpot {
  transactionBase64: string;
  lastValidBlockHeight: number;
}
export interface PerpRequest {
  symbol: string;
  side: "buy" | "sell";
  size: string;
  limitPrice: string;
  reduceOnly: boolean;
  walletAddress: string;
}
export interface PreparedPerp {
  action: unknown;
  nonce: number;
  expiresAfter: number;
  typedData: unknown;
  cloid: string;
  notionalUsd: number;
}
export interface SubmitResult {
  reference: string;
  status:
    | "submitted"
    | "filled"
    | "partially_filled"
    | "resting"
    | "confirmed"
    | "failed"
    | "unknown";
  raw?: unknown;
}
export interface VenueGateway {
  quoteSpot(input: SpotRequest): Promise<SpotQuote>;
  spotNotionalUsd(quote: SpotQuote): Promise<number>;
  prepareSpot(quote: SpotQuote, walletAddress: string): Promise<PreparedSpot>;
  submitSpot(
    prepared: PreparedSpot,
    signedTransactionBase64: string,
    walletAddress: string,
  ): Promise<SubmitResult>;
  spotStatus(signature: string): Promise<SubmitResult>;
  perpNotionalUsd(prepared: PreparedPerp): Promise<number>;
  preparePerp(
    input: PerpRequest,
    cloid: string,
    nonce: number,
  ): Promise<PreparedPerp>;
  submitPerp(
    prepared: PreparedPerp,
    signature: string,
    walletAddress: string,
  ): Promise<SubmitResult>;
  perpStatus(walletAddress: string, cloid: string): Promise<SubmitResult>;
  portfolio(wallet: Wallet): Promise<unknown>;
  markets(): Promise<unknown>;
}
