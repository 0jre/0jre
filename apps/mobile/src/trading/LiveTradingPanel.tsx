import React, { useMemo, useRef, useState } from "react";
import {
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useWalletSession } from "../auth/WalletProvider";
import { useTheme } from "../ui/theme";
import { TuffAction } from "../ui/tuff";
import { TradingApi, type ConnectedOrder } from "./api";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOL = "So11111111111111111111111111111111111111112";
function Action({
  label,
  run,
  disabled = false,
  danger = false,
}: {
  label: string;
  run: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  const { colors: c } = useTheme();
  const styles = createStyles(c);
  return (
    <TuffAction
      label={label}
      onPress={run}
      disabled={disabled}
      style={[styles.button, danger && { backgroundColor: c.negativeTint }]}
    >
      <Text
        style={{
          color: danger ? c.red : c.onBrand,
          fontSize: 13,
          fontWeight: "600",
        }}
      >
        {label}
      </Text>
    </TuffAction>
  );
}
function Field({
  label,
  value,
  set,
}: {
  label: string;
  value: string;
  set: (v: string) => void;
}) {
  const { colors: c } = useTheme();
  const styles = createStyles(c);
  return (
    <View style={{ gap: 7 }}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={set}
        autoCapitalize="none"
        autoCorrect={false}
        style={styles.input}
      />
    </View>
  );
}
export function LiveTradingPanel() {
  const { colors: c } = useTheme();
  const styles = createStyles(c);
  const session = useWalletSession();
  const api = useMemo(
    () => new TradingApi(session.getAccessToken),
    [session.getAccessToken],
  );
  const [venue, setVenue] = useState<"solana" | "hyperliquid">("solana");
  const [inputMint, setInputMint] = useState(USDC);
  const [outputMint, setOutputMint] = useState(SOL);
  const [amount, setAmount] = useState("1000000");
  const [symbol, setSymbol] = useState("BTC");
  const [size, setSize] = useState("0.0001");
  const [limitPrice, setLimitPrice] = useState("");
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [reduce, setReduce] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [order, setOrder] = useState<ConnectedOrder | null>(null);
  const [history, setHistory] = useState<ConnectedOrder[]>([]);
  const [portfolio, setPortfolio] = useState("");
  const [risk, setRisk] = useState<{
    killed: boolean;
    maxOrderCents: number;
    dailyLimitCents: number;
  } | null>(null);
  const [quote, setQuote] = useState<{
    id: string;
    quote: {
      inAmount: string;
      outAmount: string;
      minOutAmount: string;
      routeLabels: string[];
    };
    expiresAt: number;
    notionalCents: number;
  } | null>(null);
  const [health, setHealth] = useState<{ executionEnabled: boolean } | null>(
    null,
  );
  const key = useRef<string | null>(null);
  const currentWallet = session.wallets.find(
    (w) => w.chain === (venue === "solana" ? "solana" : "ethereum"),
  );
  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      if (Platform.OS !== "web" && !process.env.EXPO_PUBLIC_API_URL)
        throw Error(
          "Configure o endereço HTTPS do backend para o aplicativo nativo.",
        );
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha de comunicação.");
    } finally {
      setBusy(false);
    }
  };
  const load = () =>
    run(async () => {
      const [orders, policy] = await Promise.all([
        api.request<{ orders: ConnectedOrder[] }>("/v1/orders"),
        api.request<NonNullable<typeof risk>>("/v1/risk"),
      ]);
      setHistory(orders.orders);
      setRisk(policy);
      try {
        const r = await fetch(
          (process.env.EXPO_PUBLIC_API_URL ?? "") + "/health",
        );
        if (r.ok) setHealth(await r.json());
      } catch {
        /* Private actions still require server authorization. */
      }
    });
  const quoteSpot = () =>
    run(async () => {
      if (!currentWallet)
        throw Error("Crie ou vincule uma carteira Solana no Privy.");
      const q = await api.request<NonNullable<typeof quote>>(
        "/v1/quotes/spot",
        "POST",
        {
          walletAddress: currentWallet.address,
          inputMint,
          outputMint,
          amount,
          slippageBps: 50,
        },
      );
      setQuote(q);
      key.current = null;
    });
  const prepare = () =>
    run(async () => {
      if (!currentWallet) throw Error("Nenhuma carteira compatível conectada.");
      if (!key.current) key.current = globalThis.crypto.randomUUID();
      let prepared: ConnectedOrder;
      if (venue === "solana") {
        if (!quote) throw Error("Solicite uma cotação primeiro.");
        prepared = await api.request(
          "/v1/orders/spot",
          "POST",
          { quoteId: quote.id },
          key.current,
        );
      } else {
        prepared = await api.request(
          "/v1/orders/perp",
          "POST",
          {
            walletAddress: currentWallet.address,
            symbol,
            side,
            size,
            limitPrice,
            reduceOnly: reduce,
          },
          key.current,
        );
      }
      setOrder(prepared);
    });
  const sign = () =>
    run(async () => {
      if (!order) throw Error("Prepare uma ordem primeiro.");
      if (order.expiresAt <= Date.now())
        throw Error("Ordem expirada. Consulte o histórico e prepare outra.");
      let payload: object;
      if (order.venue === "solana") {
        if (!order.prepared.transactionBase64)
          throw Error("Transação não retornada pelo backend.");
        payload = {
          signedTransactionBase64: await session.signSolanaTransaction(
            order.prepared.transactionBase64,
          ),
        };
      } else {
        if (!order.prepared.typedData)
          throw Error("Payload de assinatura ausente.");
        payload = {
          signature: await session.signTypedData(order.prepared.typedData),
        };
      }
      const updated = await api.request<ConnectedOrder>(
        `/v1/orders/${order.id}/submit`,
        "POST",
        payload,
      );
      setOrder(updated);
    });
  const reconcile = () =>
    run(async () => {
      if (!order) return;
      setOrder(
        await api.request(`/v1/orders/${order.id}/reconcile`, "POST", {}),
      );
    });
  const reset = () => {
    setOrder(null);
    setQuote(null);
    key.current = null;
    setError("");
  };
  if (!session.configured || !session.userId)
    return (
      <View style={styles.panel}>
        <Text style={styles.title}>Trading conectado</Text>
        <Text style={styles.description}>
          Entre com Privy para acessar saldos e operações do backend. A carteira
          paper e seus US$ 10.000 fictícios não financiam operações reais.
        </Text>
      </View>
    );
  return (
    <View style={styles.panel}>
      <Text style={styles.title}>Trading conectado</Text>
      <Text style={styles.description}>
        Fluxo separado do simulador. Ordens assinadas podem movimentar fundos
        reais. Não há assinatura automática ao entrar.
      </Text>
      <View style={styles.row}>
        <Action
          label="Solana / spot"
          disabled={busy || !!order}
          run={() => {
            setVenue("solana");
            reset();
          }}
        />
        <Action
          label="Hyperliquid"
          disabled={busy || !!order}
          run={() => {
            setVenue("hyperliquid");
            reset();
          }}
        />
      </View>
      <Text style={styles.label}>
        {currentWallet
          ? `${currentWallet.address.slice(0, 8)}…${currentWallet.address.slice(-6)}`
          : "Crie uma carteira compatível no painel Privy."}
      </Text>
      <Action label="Carregar backend e histórico" run={load} disabled={busy} />
      {health && (
        <Text style={styles.label}>
          Envio no servidor:{" "}
          {health.executionEnabled ? "HABILITADO" : "DESABILITADO"} ·
          Hyperliquid usa a rede configurada no servidor.
        </Text>
      )}
      {risk && (
        <>
          <Text style={styles.description}>
            Limite por ordem: ${(risk.maxOrderCents / 100).toFixed(2)} · diário
            ${(risk.dailyLimitCents / 100).toFixed(2)}.{" "}
            {risk.killed
              ? "Entradas pausadas."
              : "Entradas autorizadas pela política."}
          </Text>
          <Action
            label={
              risk.killed
                ? "Retomar entradas no backend"
                : "Pausar entradas no backend"
            }
            danger
            run={() =>
              run(async () =>
                setRisk(
                  await api.request("/v1/risk", "PATCH", {
                    killed: !risk.killed,
                  }),
                ),
              )
            }
            disabled={busy}
          />
        </>
      )}
      <Action
        label="Consultar saldo on-chain"
        disabled={busy || !currentWallet}
        run={() =>
          run(async () => {
            if (!currentWallet) return;
            const data = await api.request<unknown>(
              `/v1/portfolio?chain=${currentWallet.chain}&walletAddress=${encodeURIComponent(currentWallet.address)}`,
            );
            setPortfolio(JSON.stringify(data, null, 2));
          })
        }
      />
      {!!portfolio && (
        <Text selectable style={styles.code}>
          {portfolio.slice(0, 5000)}
        </Text>
      )}
      {!order ? (
        <>
          {venue === "solana" ? (
            <>
              <Field
                label="Mint de entrada (endereço Solana)"
                value={inputMint}
                set={(v) => {
                  setInputMint(v);
                  setQuote(null);
                  key.current = null;
                }}
              />
              <Field
                label="Mint de saída (endereço Solana)"
                value={outputMint}
                set={(v) => {
                  setOutputMint(v);
                  setQuote(null);
                  key.current = null;
                }}
              />
              <Field
                label="Quantidade de entrada em unidades atômicas"
                value={amount}
                set={(v) => {
                  setAmount(v);
                  setQuote(null);
                  key.current = null;
                }}
              />
              <Text style={styles.label}>
                USDC: 1.000.000 unidades = 1 USDC; SOL: 1.000.000.000 = 1 SOL.
                Slippage máximo solicitado: 0,50%.
              </Text>
              <Action
                label="Obter cotação Jupiter"
                disabled={busy || !currentWallet}
                run={quoteSpot}
              />
              {quote && (
                <View style={styles.review}>
                  <Text style={styles.description}>
                    Entrada: {quote.quote.inAmount} unidades{"\n"}Saída
                    estimada: {quote.quote.outAmount} unidades{"\n"}Mínimo:{" "}
                    {quote.quote.minOutAmount} unidades{"\n"}Valor para risco: $
                    {(quote.notionalCents / 100).toFixed(2)}
                    {"\n"}Rota: {quote.quote.routeLabels.join(" → ")}
                    {"\n"}Válida até{" "}
                    {new Date(quote.expiresAt).toLocaleTimeString()}
                  </Text>
                  <Action
                    label="Preparar transação spot"
                    disabled={busy}
                    run={prepare}
                  />
                </View>
              )}
            </>
          ) : (
            <>
              <Field label="Símbolo perp" value={symbol} set={setSymbol} />
              <Field
                label="Tamanho na unidade do ativo"
                value={size}
                set={setSize}
              />
              <Field
                label="Preço limite em USD"
                value={limitPrice}
                set={setLimitPrice}
              />
              <View style={styles.row}>
                <Action
                  label={
                    side === "buy" ? "Compra selecionada" : "Selecionar compra"
                  }
                  disabled={busy}
                  run={() => {
                    setSide("buy");
                    key.current = null;
                  }}
                />
                <Action
                  label={
                    side === "sell" ? "Venda selecionada" : "Selecionar venda"
                  }
                  disabled={busy}
                  run={() => {
                    setSide("sell");
                    key.current = null;
                  }}
                />
              </View>
              <Action
                label={reduce ? "Somente redução: SIM" : "Somente redução: NÃO"}
                disabled={busy}
                run={() => {
                  setReduce(!reduce);
                  key.current = null;
                }}
              />
              <Text style={styles.label}>
                Ordem limite GTC; não altera a alavancagem configurada na
                exchange. Redução de posição exige a opção reduce-only.
              </Text>
              <Action
                label="Preparar ordem perp"
                disabled={busy || !currentWallet || !limitPrice}
                run={prepare}
              />
            </>
          )}
        </>
      ) : (
        <View style={styles.review}>
          <Text style={styles.title}>Revisar antes de assinar</Text>
          <Text selectable style={styles.description}>
            ID: {order.id}
            {"\n"}Venue: {order.venue}
            {"\n"}Carteira: {order.walletAddress}
            {"\n"}Exposição para risco: $
            {(order.notionalCents / 100).toFixed(2)}
            {"\n"}Status: {order.status}
            {order.reference ? "\nReferência: " + order.reference : ""}
          </Text>
          {order.status === "prepared" && (
            <>
              <Action
                label="Assinar e enviar operação real"
                danger
                disabled={busy || health?.executionEnabled === false}
                run={sign}
              />
              <Action
                label="Cancelar intenção sem envio"
                disabled={busy}
                run={() =>
                  run(async () =>
                    setOrder(
                      await api.request(
                        `/v1/orders/${order.id}/cancel`,
                        "POST",
                        {},
                      ),
                    ),
                  )
                }
              />
            </>
          )}
          <Action
            label="Reconciliar status da ordem"
            disabled={busy}
            run={reconcile}
          />
          {["canceled", "expired", "failed", "confirmed", "filled"].includes(
            order.status,
          ) && <Action label="Nova operação" disabled={busy} run={reset} />}
          <Text style={styles.label}>
            Se a rede falhar, não crie outra operação antes de reconciliar. Uma
            ordem resting ainda está aberta na exchange; cancelar intenção não
            cancela uma ordem já enviada.
          </Text>
        </View>
      )}
      {!!error && (
        <Text
          accessibilityLiveRegion="polite"
          style={{ fontSize: 12, color: c.red, lineHeight: 19 }}
        >
          {error}
        </Text>
      )}
      {busy && <Text style={styles.label}>Aguardando resposta…</Text>}
      {history.length > 0 && (
        <View style={{ gap: 12 }}>
          <Text style={styles.title}>Ordens persistidas</Text>
          {history.slice(0, 20).map((o) => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Inspecionar ordem ${o.id}`}
              key={o.id}
              onPress={() => setOrder(o)}
              style={styles.history}
            >
              <Text style={styles.description}>
                {o.venue} · {o.status} · ${(o.notionalCents / 100).toFixed(2)}
              </Text>
              <Text style={styles.label}>{o.id}</Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}
const createStyles = (c: ReturnType<typeof useTheme>["colors"]) => StyleSheet.create({
  panel: {
    padding: 17,
    gap: 16,
    borderWidth: 1,
    borderColor: c.line,
    borderRadius: 18,
    backgroundColor: c.card,
    marginVertical: 14,
  },
  title: { fontSize: 17, fontWeight: "600", color: c.ink },
  description: { fontSize: 12, lineHeight: 20, color: c.muted },
  label: { fontSize: 10, lineHeight: 17, color: c.muted },
  button: {
    backgroundColor: c.brand,
    padding: 12,
    borderRadius: 12,
    alignItems: "center",
    flexShrink: 1,
  },
  row: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
  input: {
    borderWidth: 1,
    borderColor: c.line,
    borderRadius: 8,
    padding: 11,
    color: c.ink,
    fontSize: 12,
    minWidth: 0,
    backgroundColor: c.bg,
  },
  review: {
    padding: 14,
    gap: 15,
    borderRadius: 12,
    backgroundColor: c.raised,
  },
  code: {
    fontSize: 9,
    lineHeight: 14,
    color: c.muted,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
  },
  history: {
    paddingVertical: 9,
    borderBottomWidth: 1,
    borderBottomColor: c.line,
  },
});
