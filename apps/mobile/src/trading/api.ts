export interface ConnectedOrder {
  id: string;
  venue: "solana" | "hyperliquid";
  walletAddress: string;
  status: string;
  notionalCents: number;
  expiresAt: number;
  prepared: { transactionBase64?: string; typedData?: unknown };
  reference?: string;
  error?: string;
}
export class TradingApi {
  constructor(
    private getToken: () => Promise<string | null>,
    private base = process.env.EXPO_PUBLIC_API_URL ?? "",
    private fetcher: typeof fetch = fetch,
  ) {}
  async request<T>(
    path: string,
    method = "GET",
    body?: unknown,
    key?: string,
  ): Promise<T> {
    if (!path.startsWith("/v1/")) throw Error("Invalid API route.");
    const token = await this.getToken();
    if (!token) throw Error("Entre na sua conta Privy antes de continuar.");
    let response: Response;
    try {
      response = await this.fetcher(this.base.replace(/\/$/, "") + path, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...(key ? { "Idempotency-Key": key } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(20000),
      });
    } catch {
      throw Error(
        "Sem resposta do backend. Não repita uma operação: consulte o histórico antes de criar outra.",
      );
    }
    let data: any;
    try {
      data = await response.json();
    } catch {
      throw Error("Resposta inválida do backend.");
    }
    if (!response.ok)
      throw Error(
        typeof data.message === "string"
          ? data.message
          : "A operação foi recusada pelo backend.",
      );
    return data as T;
  }
}
