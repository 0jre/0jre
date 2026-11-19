import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { WalletPanel } from "./src/auth/WalletPanel";
import { LiveTradingPanel } from "./src/trading/LiveTradingPanel";
import Svg, { Circle, Line, Path, Rect } from "react-native-svg";
import {
  Account,
  Market,
  accountEquity,
  closePosition,
  createAccount,
  executeOrder,
  markets as initialMarkets,
  runAgent,
  setAgentActive,
  setKillSwitch,
} from "./src/domain";
import { fetchPublicQuotes } from "./src/services/marketData";
import { ThemeProvider, useTheme } from "./src/ui/theme";
import { TuffAction, TuffPill } from "./src/ui/tuff";

type Palette = ReturnType<typeof useTheme>["colors"];
function useAppStyles() {
  const { colors } = useTheme();
  return useMemo(() => createStyles(colors), [colors]);
}
const money = (v: number) =>
  v.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  });
const price = (v: number) =>
  "$" + v.toLocaleString("en-US", { maximumFractionDigits: v < 1 ? 7 : 2 });
const KEY = "orbit.paper.v1";
let saves = Promise.resolve();
type Page = "portfolio" | "market" | "agents" | "orders" | "settings";
type Glyph =
  | "wallet"
  | "market"
  | "agents"
  | "orders"
  | "search"
  | "arrow"
  | "close"
  | "back"
  | "swap"
  | "plus"
  | "shield"
  | "sliders"
  | "chevron"
  | "eye"
  | "pause"
  | "play"
  | "check";
const paths: Record<Glyph, string> = {
  wallet: "M3 6h17v14H3z M3 6V3h14v3 M15 11h6v5h-6z",
  market: "M4 19V11 M10 19V5 M16 19v-8 M22 19V2",
  agents: "M8 5h8l4 4v9l-4 3H8l-4-3V9z M9 12v2 M15 12v2 M12 2v3",
  orders: "M6 3h12v19l-3-2-3 2-3-2-3 2z M9 8h6 M9 12h6 M9 16h3",
  search: "M20 20l-5-5 M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0",
  arrow: "M5 12h14 M13 6l6 6-6 6",
  close: "M6 6l12 12 M18 6 6 18",
  back: "M15 5l-7 7 7 7",
  swap: "M3 7h17 M15 2l5 5-5 5 M21 17H4 M9 12l-5 5 5 5",
  plus: "M12 4v16 M4 12h16",
  shield: "m12 2 8 4v6c0 5-8 10-8 10S4 17 4 12V6z M12 7v6 M12 16v1",
  sliders: "M4 7h16 M4 17h16 M8 4v6 M16 14v6",
  chevron: "m9 5 7 7-7 7",
  eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12 M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0",
  pause: "M8 4v16 M16 4v16",
  play: "m7 4 13 8-13 8z",
  check: "m5 12 4 4 10-10",
};
function Icon({
  name,
  size = 22,
  color,
}: {
  name: Glyph;
  size?: number;
  color?: string;
}) {
  const { colors: c } = useTheme();
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d={paths[name]}
        stroke={color ?? c.ink}
        strokeWidth={1.7}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}
function Tap({
  label,
  onPress,
  children,
  style,
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  children: React.ReactNode;
  style?: object;
  disabled?: boolean;
}) {
  return (
    <TuffAction
      label={label}
      onPress={onPress}
      disabled={disabled}
      style={style}
    >
      {children}
    </TuffAction>
  );
}
function Muted({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: object;
}) {
  const s = useAppStyles();
  return <Text style={[s.muted, style]}>{children}</Text>;
}
function Pill({ text, bright = false }: { text: string; bright?: boolean }) {
  return <TuffPill text={text} bright={bright} />;
}
function Token({ m, size = 38 }: { m: Market; size?: number }) {
  const sol = m.symbol === "SOL";
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: m.color + "24",
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      {sol ? (
        <Svg width={size * 0.65} height={size * 0.65} viewBox="0 0 30 30">
          <Path
            d="M7 5h21l-5 5H2z M2 13h21l5 5H7z M7 21h21l-5 5H2z"
            fill={m.color}
          />
        </Svg>
      ) : m.symbol === "BTC" ? (
        <Svg width={size * 0.65} height={size * 0.65} viewBox="0 0 30 30">
          <Path
            d="M8 7h9a4 4 0 0 1 0 8H8m3-8v16m-3 0h10a4 4 0 0 0 0-8M13 3v4m5-4v4m-5 16v4m5-4v4"
            fill="none"
            stroke={m.color}
            strokeWidth={2.3}
          />
        </Svg>
      ) : m.symbol === "ETH" ? (
        <Svg width={size * 0.65} height={size * 0.65} viewBox="0 0 30 30">
          <Path
            d="M15 1 5 16 15 22 25 16Z M5 18 15 29 25 18 15 24Z"
            fill={m.color}
          />
        </Svg>
      ) : (
        <Text
          style={{ fontSize: size * 0.51, color: m.color, fontWeight: "700" }}
        >
          {m.symbol.slice(0, 1)}
        </Text>
      )}
    </View>
  );
}
function Candles({ m }: { m: Market }) {
  const { colors: c } = useTheme();
  const s = useAppStyles();
  const values = m.history;
  const low = Math.min(...values) * 0.995;
  const range = Math.max(...values) * 1.005 - low;
  const y = (v: number) => 195 - ((v - low) / range) * 170;
  return (
    <View style={{ height: 252, marginTop: 16 }}>
      <Svg
        width="100%"
        height={224}
        viewBox="0 0 360 224"
        preserveAspectRatio="none"
      >
        {[20, 70, 120, 170, 220].map((v) => (
          <Line
            key={v}
            x1={0}
            x2={360}
            y1={v}
            y2={v}
            stroke={c.line}
            strokeWidth={0.7}
          />
        ))}
        {values.slice(1).map((v, i) => {
          const open = values[i],
            rise = v >= open,
            x = 8 + i * (340 / (values.length - 1));
          const wick = range * (0.035 + (i % 3) * 0.015);
          return (
            <React.Fragment key={i}>
              <Line
                x1={x}
                x2={x}
                y1={y(Math.max(v, open) + wick)}
                y2={y(Math.min(v, open) - wick)}
                stroke={rise ? c.green : c.red}
              />
              <Rect
                x={x - 2.6}
                y={Math.min(y(v), y(open))}
                width={5.2}
                height={Math.max(2, Math.abs(y(v) - y(open)))}
                fill={rise ? c.green : c.red}
              />
            </React.Fragment>
          );
        })}
        <Line
          x1={0}
          x2={360}
          y1={y(values[values.length - 1])}
          y2={y(values[values.length - 1])}
          stroke={c.muted}
          strokeDasharray="3 4"
        />
      </Svg>
      <View style={[s.row, { justifyContent: "space-between", paddingTop: 8 }]}>
        <Muted style={{ fontSize: 10 }}>12:00</Muted>
        <Muted style={{ fontSize: 10 }}>14:00</Muted>
        <Muted style={{ fontSize: 10 }}>16:00</Muted>
        <Muted style={{ fontSize: 10 }}>18:00</Muted>
      </View>
    </View>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <TradingApp />
    </ThemeProvider>
  );
}

function TradingApp() {
  const { colors: c, mode, setMode } = useTheme();
  const s = useAppStyles();
  const toggleTheme = () => setMode(mode === "dark" ? "light" : "dark");
  const { width } = useWindowDimensions();
  const [page, setPage] = useState<Page>("portfolio");
  const [account, setAccount] = useState<Account>(createAccount);
  const [loaded, setLoaded] = useState(false);
  const [markets, setMarkets] = useState(initialMarkets);
  const [detail, setDetail] = useState<Market | null>(null);
  const [ticket, setTicket] = useState<"long" | "short" | null>(null);
  const [amount, setAmount] = useState("100");
  const [leverage, setLeverage] = useState(1);
  const [review, setReview] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("Todos");
  const [notice, setNotice] = useState("");
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [quoteStatus, setQuoteStatus] = useState("Preços demonstrativos");
  const [command, setCommand] = useState("");
  const [reply, setReply] = useState(
    "Consulte status, risco ou sol. Comandos locais; nenhum modelo de IA conectado.",
  );
  useEffect(() => {
    AsyncStorage.getItem(KEY)
      .then((raw) => {
        if (!raw) return;
        const saved = JSON.parse(raw);
        if (
          saved.version !== 1 ||
          !Number.isFinite(saved.account?.cash) ||
          saved.account.cash < 0 ||
          !Array.isArray(saved.account.positions) ||
          !Array.isArray(saved.account.trades) ||
          !Array.isArray(saved.account.agents) ||
          typeof saved.account.killed !== "boolean"
        )
          throw Error("Invalid saved account");
        accountEquity(saved.account, initialMarkets);
        setAccount(saved.account);
      })
      .catch(() =>
        setNotice("Sessão local inválida. Uma nova conta demo foi criada."),
      )
      .finally(() => setLoaded(true));
  }, []);
  useEffect(() => {
    if (loaded) {
      const snapshot = JSON.stringify({ version: 1, account });
      saves = saves
        .then(() => AsyncStorage.setItem(KEY, snapshot))
        .catch(() => setNotice("Não foi possível salvar neste dispositivo."));
    }
  }, [loaded, account]);
  const act = (fn: () => Account, message: string) => {
    try {
      setAccount(fn());
      setNotice(message);
      return true;
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Não foi possível concluir.");
      return false;
    }
  };
  const open = (m: Market) => {
    setDetail(m);
    setLeverage(1);
    setReview(false);
  };
  const go = (p: Page) => {
    setPage(p);
    setDetail(null);
  };
  const equity = accountEquity(account, markets);
  const active = account.agents.filter((a) => a.active).length;
  const perps = markets.filter((m) => m.kind === "perp");
  const spot = markets.filter((m) => m.kind === "spot");
  const refresh = async () => {
    setBusy(true);
    try {
      const result = await fetchPublicQuotes();
      setMarkets((old) =>
        old.map((m) => {
          const q = result.quotes.find(
            (q) =>
              q.symbol === m.symbol &&
              q.venue === (m.kind === "perp" ? "Hyperliquid" : "Solana"),
          );
          return q ? { ...m, price: q.price } : m;
        }),
      );
      setQuoteStatus(
        result.quotes.length
          ? `Snapshot público · ${new Date().toLocaleTimeString("pt-BR")}`
          : "Atualização indisponível",
      );
      setNotice(
        result.errors.join(" | ") ||
          "Cotações atualizadas. Gráficos e métricas continuam ilustrativos.",
      );
    } catch {
      setNotice("Sem conexão. Cotações anteriores preservadas.");
    } finally {
      setBusy(false);
    }
  };
  const chooseTicket = (side: "long" | "short") => {
    setTicket(side);
    setAmount("100");
    setReview(false);
  };
  const confirm = () => {
    if (!detail || !ticket) return;
    if (
      act(
        () => executeOrder(account, detail, ticket, Number(amount), leverage),
        "Operação simulada. Nenhuma transação enviada.",
      )
    ) {
      setTicket(null);
      setReview(false);
    }
  };
  const keypad = (key: string) => {
    if (key === "⌫") {
      setAmount((a) => a.slice(0, -1));
      return;
    }
    setAmount((a) => {
      if (key === "." && a.includes(".")) return a;
      if (a.length >= 12) return a;
      return a === "0" && key !== "." ? key : a + key;
    });
  };
  const selected = detail ? markets.find((m) => m.id === detail.id)! : null;
  const tokenRows = (items: Market[]) =>
    items.map((m) => (
      <Tap
        key={m.id}
        label={`Abrir ${m.symbol} ${m.venue}`}
        onPress={() => open(m)}
        style={s.tokenRow}
      >
        <Token m={m} />
        <View style={{ flex: 1, gap: 5 }}>
          <Text style={s.tokenName}>
            {m.name} <Text style={s.symbol}>{m.symbol}</Text>
          </Text>
          <Muted style={{ fontSize: 11 }}>
            {m.venue}
            {m.kind === "perp" ? " · Perp" : ""}
          </Muted>
        </View>
        <View style={{ alignItems: "flex-end", gap: 5 }}>
          <Text style={s.tokenPrice}>{price(m.price)}</Text>
          <Text
            style={{ fontSize: 11, color: m.change >= 0 ? c.green : c.red }}
          >
            {m.change >= 0 ? "↗" : "↘"} {Math.abs(m.change).toFixed(2)}%{" "}
            <Text style={{ color: c.muted, fontSize: 9 }}>demo</Text>
          </Text>
        </View>
      </Tap>
    ));
  const positions = (
    <>
      {account.positions.length === 0 ? (
        <View style={s.empty}>
          <Icon name="wallet" size={32} color={c.muted} />
          <Text style={s.h3}>Nenhuma posição aberta</Text>
          <Muted style={{ textAlign: "center", lineHeight: 20 }}>
            Encontre um ativo e experimente sua primeira operação simulada.
          </Muted>
          <Tap
            label="Explorar mercados"
            onPress={() => go("market")}
            style={s.smallAction}
          >
            <Text style={s.smallActionText}>Explorar mercados</Text>
            <Icon name="arrow" size={17} color={c.brand} />
          </Tap>
        </View>
      ) : (
        account.positions.map((p) => {
          const m = markets.find((m) => m.id === p.marketId)!;
          const pnl =
            (m.price - p.entry) * p.quantity * (p.side === "long" ? 1 : -1);
          return (
            <View style={s.position} key={p.id}>
              <View style={s.row}>
                <Token m={m} size={32} />
                <View style={{ flex: 1 }}>
                  <Text style={s.tokenName}>
                    {m.symbol}{" "}
                    <Text
                      style={{
                        fontSize: 11,
                        color: p.side === "long" ? c.green : c.red,
                      }}
                    >
                      {p.side.toUpperCase()} {p.leverage}×
                    </Text>
                  </Text>
                  <Muted style={{ fontSize: 11, marginTop: 5 }}>
                    Margem {money(p.margin)}
                  </Muted>
                </View>
                <Text
                  style={{ color: pnl >= 0 ? c.green : c.red, fontSize: 14 }}
                >
                  {money(Math.max(-p.margin, pnl))}
                </Text>
              </View>
              <Tap
                label={`Encerrar ${m.symbol} ${p.id}`}
                onPress={() =>
                  act(
                    () => closePosition(account, p.id, m),
                    "Posição encerrada no simulador.",
                  )
                }
                style={s.closePosition}
              >
                <Text style={{ fontSize: 12, color: c.ink }}>
                  Encerrar posição
                </Text>
              </Tap>
            </View>
          );
        })
      )}
    </>
  );
  const nav: { id: Page; label: string; icon: Glyph }[] = [
    { id: "portfolio", label: "Portfólio", icon: "wallet" },
    { id: "market", label: "Mercado", icon: "market" },
    { id: "agents", label: "Agentes", icon: "agents" },
    { id: "orders", label: "Ordens", icon: "orders" },
    { id: "settings", label: "Ajustes", icon: "sliders" },
  ];
  if (!loaded)
    return (
      <View
        style={[s.stage, { justifyContent: "center", alignItems: "center" }]}
      >
        <ActivityIndicator color={c.brand} />
      </View>
    );
  return (
    <View style={s.stage}>
      <StatusBar style={mode === "dark" ? "light" : "dark"} />
      <View style={[s.phone, width > 520 && s.desktopPhone]}>
        <View style={s.topbar}>
          {selected ? (
            <>
              <Tap
                label="Voltar"
                onPress={() => setDetail(null)}
                style={s.iconButton}
              >
                <Icon name="back" />
              </Tap>
              <View style={[s.row, { flex: 1, justifyContent: "center" }]}>
                <Token m={selected} size={27} />
                <Text style={s.h3}>{selected.symbol}</Text>
                {selected.kind === "perp" && <Pill text="PERP" />}
              </View>
              <Tap
                label="Buscar mercados"
                onPress={() => go("market")}
                style={s.iconButton}
              >
                <Icon name="search" />
              </Tap>
            </>
          ) : (
            <>
              <Tap
                label="Ajustes da conta"
                onPress={() => go("settings")}
                style={s.walletButton}
              >
                <View style={s.avatar}>
                  <Text
                    style={{ color: c.ink, fontWeight: "600", fontSize: 11 }}
                  >
                    JR
                  </Text>
                </View>
                <Text style={{ color: c.ink, fontSize: 13, fontWeight: "600" }}>
                  Conta principal
                </Text>
                <Icon name="chevron" size={13} color={c.muted} />
              </Tap>
              <View style={{ flex: 1 }} />
              <Pill text="DEMO" bright />
              <Tap
                label="Buscar mercados"
                onPress={() => go("market")}
                style={s.iconButton}
              >
                <Icon name="search" size={23} />
              </Tap>
            </>
          )}
          <Tap
            label={mode === "dark" ? "Ativar tema claro" : "Ativar tema escuro"}
            onPress={toggleTheme}
            style={s.themeButton}
          >
            <Text style={s.themeButtonText}>
              {mode === "dark" ? "Claro" : "Escuro"}
            </Text>
          </Tap>
        </View>
        {account.killed && (
          <Tap
            label="Retomar simulação"
            onPress={() =>
              act(() => setKillSwitch(account, false), "Simulação retomada.")
            }
            style={s.killBanner}
          >
            <Icon name="shield" size={15} color={c.red} />
            <Text style={{ color: c.red, fontSize: 11, flex: 1 }}>
              Entradas pausadas · toque para retomar
            </Text>
            <Icon name="chevron" size={14} color={c.red} />
          </Tap>
        )}
        {!!notice && (
          <Tap
            label="Dispensar aviso"
            onPress={() => setNotice("")}
            style={s.toast}
          >
            <Text
              accessibilityLiveRegion="polite"
              style={{ color: c.ink, fontSize: 11, lineHeight: 17, flex: 1 }}
            >
              {notice}
            </Text>
            <Icon name="close" size={15} color={c.muted} />
          </Tap>
        )}
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 24 }}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {selected ? (
            <>
              <View style={{ paddingTop: 12 }}>
                <Text style={s.detailPrice}>{price(selected.price)}</Text>
                <Text
                  style={{
                    color: selected.change >= 0 ? c.green : c.red,
                    fontSize: 17,
                    marginTop: 8,
                  }}
                >
                  {selected.change >= 0 ? "↗" : "↘"}{" "}
                  {Math.abs(selected.change).toFixed(2)}%{" "}
                  <Text style={{ color: c.muted, fontSize: 11 }}>
                    ilustrativo
                  </Text>
                </Text>
              </View>
              <Candles m={selected} />
              <View style={s.chartCaption}>
                <Pill text="GRÁFICO DEMONSTRATIVO" />
                <Muted style={{ fontSize: 10 }}>Sem feed ao vivo</Muted>
              </View>
              <View style={s.section}>
                <Text style={s.h2}>Estatísticas de mercado</Text>
                <Icon name="sliders" size={17} color={c.muted} />
              </View>
              <View style={s.statGrid}>
                {[
                  { label: "Volume 24h · demo", value: money(selected.volume) },
                  {
                    label: "Liquidez · demo",
                    value: money(selected.liquidity),
                  },
                  { label: "Protocolo", value: selected.venue },
                  { label: "Execução", value: "Simulada" },
                ].map((x) => (
                  <View key={x.label} style={s.statTile}>
                    <Muted style={{ fontSize: 12 }}>{x.label}</Muted>
                    <Text
                      style={{
                        color: c.ink,
                        fontSize: 17,
                        fontWeight: "600",
                        marginTop: 12,
                      }}
                    >
                      {x.value}
                    </Text>
                  </View>
                ))}
              </View>
              <View style={s.section}>
                <Text style={s.h2}>Sobre o mercado</Text>
              </View>
              <Muted style={{ lineHeight: 21 }}>
                Mercado{" "}
                {selected.kind === "perp"
                  ? "perpétuo com margem isolada simulada"
                  : "spot demonstrativo"}
                . {selected.venue} não está conectado para execução. Não há
                carteira, assinatura, funding ou liquidação contínua.
              </Muted>
              <View style={{ marginTop: 24 }}>
                <Muted style={{ fontSize: 10 }}>
                  {quoteStatus}. Variações e estatísticas são demo.
                </Muted>
              </View>
            </>
          ) : page === "portfolio" ? (
            <>
              <View style={s.balanceCard}>
                <View style={[s.row, { justifyContent: "space-between" }]}>
                  <Text style={s.darkLabel}>SALDO SIMULADO</Text>
                  <Tap
                    label={hidden ? "Mostrar saldo" : "Ocultar saldo"}
                    onPress={() => setHidden(!hidden)}
                  >
                    <Icon name="eye" color={c.muted} size={19} />
                  </Tap>
                </View>
                <Text style={s.balanceValue}>
                  {hidden ? "••••••" : money(equity)}
                </Text>
                <View style={s.row}>
                  <Text style={{ color: c.muted, fontSize: 12 }}>
                    Disponível {hidden ? "••••" : money(account.cash)}
                  </Text>
                </View>
                <View style={s.balanceBottom}>
                  <View style={[s.row, { gap: 6 }]}>
                    <View
                      style={{
                        width: 5,
                        height: 5,
                        borderRadius: 3,
                        backgroundColor: c.green,
                      }}
                    />
                    <Text
                      style={{
                        color: c.muted,
                        fontSize: 10,
                        fontWeight: "600",
                      }}
                    >
                      PAPER WALLET
                    </Text>
                  </View>
                  <Text style={{ color: c.muted, fontSize: 11 }}>USD</Text>
                </View>
                <View pointerEvents="none" style={s.orbital}>
                  <Svg width={145} height={145} viewBox="0 0 145 145">
                    {[35, 44, 53, 62, 71].map((r, i) => (
                      <Circle
                        key={r}
                        cx={73}
                        cy={73}
                        r={r}
                        stroke={c.muted}
                        strokeWidth={0.55}
                        fill="none"
                        opacity={0.15 + i * 0.06}
                      />
                    ))}
                    <Path
                      d="m35 90 44-57 25 45-41 34z"
                      fill={c.ink}
                      opacity={0.16}
                    />
                  </Svg>
                </View>
              </View>
              <View style={s.quickActions}>
                {[
                  {
                    label: "Operar",
                    icon: "swap" as Glyph,
                    target: "market" as Page,
                  },
                  {
                    label: "Agentes",
                    icon: "agents" as Glyph,
                    target: "agents" as Page,
                  },
                  {
                    label: "Posições",
                    icon: "wallet" as Glyph,
                    target: "orders" as Page,
                  },
                  {
                    label: "Histórico",
                    icon: "orders" as Glyph,
                    target: "orders" as Page,
                  },
                ].map((x) => (
                  <Tap
                    label={x.label}
                    key={x.label}
                    onPress={() => go(x.target)}
                    style={s.quickAction}
                  >
                    <View style={s.quickCircle}>
                      <Icon name={x.icon} size={21} />
                    </View>
                    <Text style={{ color: c.ink, fontSize: 11, marginTop: 9 }}>
                      {x.label}
                    </Text>
                  </Tap>
                ))}
              </View>
              <Tap
                label="Abrir controle de agentes"
                onPress={() => go("agents")}
                style={s.agentBanner}
              >
                <View style={s.agentMark}>
                  <Icon name="agents" color={c.brand} size={23} />
                </View>
                <View style={{ flex: 1, gap: 5 }}>
                  <Text
                    style={{ color: c.ink, fontSize: 13, fontWeight: "600" }}
                  >
                    Seu próximo movimento, com agentes.
                  </Text>
                  <Muted style={{ fontSize: 10 }}>
                    {active} habilitado{active !== 1 ? "s" : ""} · regras locais
                    · sem IA conectada
                  </Muted>
                </View>
                <Icon name="chevron" size={15} color={c.muted} />
              </Tap>
              <View style={s.section}>
                <View style={s.row}>
                  <Text style={s.h2}>Perps</Text>
                  <Icon name="chevron" size={15} />
                </View>
                <Tap
                  label="Ver perps"
                  onPress={() => {
                    go("market");
                    setFilter("Perps");
                  }}
                >
                  <Muted style={{ fontSize: 11 }}>Ver todos</Muted>
                </Tap>
              </View>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ gap: 12, paddingBottom: 4 }}
              >
                {perps.map((m) => (
                  <Tap
                    key={m.id}
                    label={`Abrir ${m.symbol} ${m.venue}`}
                    onPress={() => open(m)}
                    style={s.perpCard}
                  >
                    <View style={[s.row, { justifyContent: "space-between" }]}>
                      <Token m={m} size={32} />
                      <Pill text="ATÉ 10×" />
                    </View>
                    <Text
                      style={{
                        color: c.ink,
                        fontSize: 21,
                        fontWeight: "600",
                        marginTop: 20,
                      }}
                    >
                      {m.symbol}
                    </Text>
                    <Text
                      style={{ color: c.muted, fontSize: 12, marginTop: 5 }}
                    >
                      {price(m.price)}
                    </Text>
                    <Text
                      style={{
                        color: m.change >= 0 ? c.green : c.red,
                        fontSize: 11,
                        marginTop: 10,
                      }}
                    >
                      {m.change >= 0 ? "↗" : "↘"} {Math.abs(m.change)}% demo
                    </Text>
                  </Tap>
                ))}
              </ScrollView>
              <View style={s.section}>
                <Text style={s.h2}>No radar</Text>
                <Pill text="SOLANA · DEMO" />
              </View>
              {tokenRows(spot.slice(1, 4))}
              {account.positions.length > 0 && (
                <>
                  <View style={s.section}>
                    <Text style={s.h2}>Suas posições</Text>
                    <Pill text={`${account.positions.length} abertas`} />
                  </View>
                  {positions}
                </>
              )}
              <Muted style={s.disclaimer}>
                Capital fictício. Sem movimentação de fundos reais.
              </Muted>
            </>
          ) : page === "market" ? (
            <>
              <Text style={s.pageTitle}>Mercado</Text>
              <View style={s.searchBox}>
                <Icon name="search" size={18} color={c.muted} />
                <TextInput
                  accessibilityLabel="Buscar token ou protocolo"
                  value={query}
                  onChangeText={setQuery}
                  placeholder="Pesquisar token ou protocolo"
                  placeholderTextColor={c.muted}
                  style={s.searchInput}
                />
              </View>
              <View style={s.filters}>
                {["Todos", "Memecoins", "Spot", "Perps"].map((f) => (
                  <Tap
                    key={f}
                    label={`Filtrar ${f}`}
                    onPress={() => setFilter(f)}
                    style={[s.filter, filter === f && s.filterActive]}
                  >
                    <Text
                      style={{
                        color: filter === f ? c.ink : c.muted,
                        fontSize: 12,
                      }}
                    >
                      {f}
                    </Text>
                  </Tap>
                ))}
              </View>
              <View
                style={[
                  s.row,
                  { justifyContent: "space-between", paddingVertical: 15 },
                ]}
              >
                <Muted style={{ fontSize: 10, letterSpacing: 0.5 }}>
                  ATIVO / PROTOCOLO
                </Muted>
                <Muted style={{ fontSize: 10, letterSpacing: 0.5 }}>
                  PREÇO / 24H DEMO
                </Muted>
              </View>
              {tokenRows(
                markets.filter(
                  (m) =>
                    (filter === "Todos" ||
                      (filter === "Memecoins"
                        ? m.kind === "spot" && m.symbol !== "SOL"
                        : filter === "Perps"
                          ? m.kind === "perp"
                          : m.kind === "spot")) &&
                    `${m.name} ${m.symbol} ${m.venue}`
                      .toLowerCase()
                      .includes(query.toLowerCase()),
                ),
              )}
              <View style={s.dataPanel}>
                <View style={s.row}>
                  <View style={{ flex: 1, gap: 5 }}>
                    <Text style={s.h3}>Cotações públicas</Text>
                    <Muted style={{ fontSize: 11 }}>{quoteStatus}</Muted>
                  </View>
                  <Tap
                    label="Atualizar cotações públicas"
                    onPress={refresh}
                    disabled={busy}
                    style={s.refresh}
                  >
                    <Text style={{ color: c.brand, fontSize: 12 }}>
                      {busy ? "Lendo…" : "Atualizar"}
                    </Text>
                  </Tap>
                </View>
                <Muted style={{ fontSize: 11, lineHeight: 18, marginTop: 14 }}>
                  BTC, ETH e SOL via Hyperliquid; SOL spot via DexScreener.
                  Demais ativos, gráficos e métricas são demonstrativos.
                </Muted>
              </View>
            </>
          ) : page === "agents" ? (
            <>
              <View
                style={[
                  s.row,
                  { justifyContent: "space-between", marginTop: 10 },
                ]}
              >
                <Text style={s.pageTitle}>Agentes</Text>
                <Pill
                  text={`${active} HABILITADO${active !== 1 ? "S" : ""}`}
                  bright
                />
              </View>
              <Muted style={{ lineHeight: 21, marginBottom: 22 }}>
                Você define o ritmo. Uma ordem simulada por toque, com limites
                de risco.
              </Muted>
              {account.agents.map((a) => (
                <View key={a.id} style={s.agentCard}>
                  <View style={s.row}>
                    <View
                      style={[
                        s.agentMark,
                        {
                          backgroundColor: c.raised,
                        },
                      ]}
                    >
                      <Icon
                        name="agents"
                        color={c.brand}
                        size={25}
                      />
                    </View>
                    <View style={{ flex: 1, gap: 5 }}>
                      <Text style={s.h3}>{a.name}</Text>
                      <Muted style={{ fontSize: 11 }}>{a.strategy}</Muted>
                    </View>
                    <Tap
                      label={a.active ? `Pausar ${a.name}` : `Ativar ${a.name}`}
                      onPress={() =>
                        act(
                          () => setAgentActive(account, a.id, !a.active),
                          a.active ? "Agente pausado." : "Agente habilitado.",
                        )
                      }
                      style={[
                        s.toggle,
                        a.active && { backgroundColor: c.brand },
                      ]}
                    >
                      <View
                        style={[
                          s.toggleKnob,
                          a.active && {
                            alignSelf: "flex-end",
                            backgroundColor: c.onBrand,
                          },
                        ]}
                      />
                    </Tap>
                  </View>
                  <View style={{ marginTop: 23, gap: 9 }}>
                    <View style={[s.row, { justifyContent: "space-between" }]}>
                      <Muted style={{ fontSize: 11 }}>
                        Orçamento utilizado
                      </Muted>
                      <Text style={{ fontSize: 11, color: c.ink }}>
                        {money(a.spent)}{" "}
                        <Text style={{ color: c.muted }}>
                          / {money(a.budget)}
                        </Text>
                      </Text>
                    </View>
                    <View style={s.progress}>
                      <View
                        style={{
                          height: 3,
                          width: `${Math.min(100, (a.spent / a.budget) * 100)}%`,
                          backgroundColor: c.brand,
                          borderRadius: 2,
                        }}
                      />
                    </View>
                    <Muted style={{ fontSize: 10 }}>
                      Teto {money(a.maxOrder)} por ordem · até {a.maxLeverage}×
                    </Muted>
                  </View>
                  <Tap
                    label={`Simular ${a.name}`}
                    disabled={!a.active || account.killed}
                    onPress={() =>
                      act(
                        () => runAgent(account, a.id, perps[0]),
                        `${a.name}: uma operação simulada em BTC.`,
                      )
                    }
                    style={s.agentRun}
                  >
                    <Icon name="play" size={13} color={c.brand} />
                    <Text
                      style={{ color: c.brand, fontSize: 12, fontWeight: "600" }}
                    >
                      Simular uma operação · BTC
                    </Text>
                  </Tap>
                </View>
              ))}
              <Tap
                label={
                  account.killed
                    ? "Retomar entradas demo"
                    : "Parar todas as entradas"
                }
                onPress={() =>
                  act(
                    () => setKillSwitch(account, !account.killed),
                    account.killed
                      ? "Entradas liberadas."
                      : "Emergência ativada. Encerramentos continuam disponíveis.",
                  )
                }
                style={s.emergency}
              >
                <Icon name="shield" size={18} color={c.red} />
                <Text style={{ color: c.red, fontSize: 12, fontWeight: "600" }}>
                  {account.killed
                    ? "Retomar entradas demo"
                    : "Parar todas as entradas"}
                </Text>
              </Tap>
              <View style={s.section}>
                <Text style={s.h2}>Copiloto</Text>
                <Pill text="COMANDOS LOCAIS" />
              </View>
              <Muted style={{ lineHeight: 21 }}>{reply}</Muted>
              <View style={[s.searchBox, { marginTop: 16 }]}>
                <TextInput
                  accessibilityLabel="Comando do copiloto"
                  value={command}
                  onChangeText={setCommand}
                  placeholder="status, risco ou sol"
                  placeholderTextColor={c.muted}
                  style={s.searchInput}
                />
                <Tap
                  label="Consultar copiloto"
                  onPress={() => {
                    const q = command.trim().toLowerCase();
                    setReply(
                      q === "status"
                        ? `${active} agentes habilitados, ${account.positions.length} posições e ${money(account.cash)} disponíveis. Execução ${account.killed ? "pausada" : "simulada"}.`
                        : q === "risco"
                          ? "Margem limitada ao saldo; orçamento e teto por agente; perps até 10×. Emergência bloqueia entradas, não encerramentos."
                          : q === "sol"
                            ? "SOL spot e perp disponíveis para simulação. Sem RPC ou roteamento on-chain."
                            : "Use status, risco ou sol. Este copiloto não é um LLM.",
                    );
                    setCommand("");
                  }}
                >
                  <Icon name="arrow" color={c.brand} />
                </Tap>
              </View>
              <Muted style={s.disclaimer}>
                Estratégias determinísticas. Não são agentes de IA autônomos.
              </Muted>
            </>
          ) : page === "orders" ? (
            <>
              <Text style={s.pageTitle}>Suas operações</Text>
              <View
                style={[
                  s.row,
                  {
                    justifyContent: "space-between",
                    marginTop: 3,
                    marginBottom: 20,
                  },
                ]}
              >
                <Muted>Patrimônio paper</Muted>
                <Text style={{ fontSize: 17, color: c.ink }}>
                  {money(equity)}
                </Text>
              </View>
              <View style={s.section}>
                <Text style={s.h2}>Posições abertas</Text>
                <Pill text={`${account.positions.length}`} />
              </View>
              {positions}
              <View style={s.section}>
                <Text style={s.h2}>Histórico</Text>
                <Muted style={{ fontSize: 11 }}>
                  {account.trades.length} operações
                </Muted>
              </View>
              {account.trades.length === 0 ? (
                <Muted style={{ paddingVertical: 20 }}>
                  Nenhuma operação registrada.
                </Muted>
              ) : (
                account.trades
                  .slice()
                  .reverse()
                  .map((t) => {
                    const m = markets.find((m) => m.id === t.marketId)!;
                    return (
                      <View key={t.id} style={s.historyRow}>
                        <View
                          style={[
                            s.historyIcon,
                            {
                              backgroundColor:
                                t.action === "close" ? c.raised : c.positiveTint,
                            },
                          ]}
                        >
                          <Icon
                            name={t.action === "close" ? "check" : "swap"}
                            size={17}
                            color={t.action === "close" ? c.muted : c.green}
                          />
                        </View>
                        <View style={{ flex: 1, gap: 5 }}>
                          <Text style={s.tokenName}>
                            {t.action === "open"
                              ? "Abertura"
                              : t.action === "close"
                                ? "Encerramento"
                                : "Operação"}{" "}
                            · {m.symbol}
                          </Text>
                          <Muted style={{ fontSize: 10 }}>
                            {t.agentId ? "Agente" : "Manual"} ·{" "}
                            {t.side.toUpperCase()} · {t.id}
                          </Muted>
                        </View>
                        <Text style={{ color: c.ink, fontSize: 13 }}>
                          {money(t.notional)}
                        </Text>
                      </View>
                    );
                  })
              )}
              <Muted style={s.disclaimer}>
                Registro local neste dispositivo. Sem taxas, slippage ou
                funding.
              </Muted>
            </>
          ) : (
            <>
              <Text style={s.pageTitle}>Seu workspace</Text>
              <Tap
                label={mode === "dark" ? "Ativar tema claro" : "Ativar tema escuro"}
                onPress={toggleTheme}
                style={s.themeSetting}
              >
                <View style={{ flex: 1, gap: 5 }}>
                  <Text style={s.h3}>Aparência</Text>
                  <Muted style={{ fontSize: 12 }}>
                    Tema {mode === "dark" ? "escuro" : "claro"}
                  </Muted>
                </View>
                <Text style={s.themeButtonText}>
                  Usar {mode === "dark" ? "claro" : "escuro"}
                </Text>
                <Icon name="chevron" size={17} color={c.muted} />
              </Tap>
              <WalletPanel />
              <LiveTradingPanel />
              <View style={s.profileCard}>
                <View
                  style={[
                    s.avatar,
                    { width: 46, height: 46, borderRadius: 23 },
                  ]}
                >
                  <Text style={{ color: c.ink, fontSize: 16 }}>JR</Text>
                </View>
                <View style={{ flex: 1, gap: 5 }}>
                  <Text style={s.h3}>Conta principal</Text>
                  <Muted style={{ fontSize: 11 }}>
                    Paper wallet · armazenamento local
                  </Muted>
                </View>
                <Pill text="DEMO" bright />
              </View>
              <View style={s.section}>
                <Text style={s.h2}>Conexões & cobertura</Text>
              </View>
              {[
                {
                  name: "Hyperliquid",
                  tag: "Adapter de perp no backend",
                  body: "Preços públicos e ordens limite assinadas no painel conectado. Testnet por padrão; execução depende da configuração do servidor.",
                },
                {
                  name: "Solana / DexScreener",
                  tag: "Leitura de preços",
                  body: "Preço SOL pelo par válido de maior liquidez. Não é indexação de toda a rede.",
                },
                {
                  name: "Jupiter · Raydium · Meteora · Pump.fun",
                  tag: "Roteamento Jupiter no backend",
                  body: "Cotação, transação, simulação e envio após assinatura. Acesso a pools depende da rota; não há integração direta com todos os protocolos.",
                },
                {
                  name: "GMGN / multichain",
                  tag: "Não integrado",
                  body: "Sem paridade de cobertura com a GMGN. Não oferece todos os tokens, pools ou redes.",
                },
                {
                  name: "Carteira & IA",
                  tag: "Privy · assinatura pelo usuário",
                  body: "Login e carteiras no painel acima quando configurado. Não há executor LLM, custódia própria nem agentes autônomos.",
                },
              ].map((x) => (
                <View style={s.connection} key={x.name}>
                  <Text style={s.h3}>{x.name}</Text>
                  <Text
                    style={{
                      color: c.brand,
                      fontSize: 10,
                      marginTop: 7,
                      marginBottom: 11,
                    }}
                  >
                    {x.tag}
                  </Text>
                  <Muted style={{ lineHeight: 19, fontSize: 12 }}>
                    {x.body}
                  </Muted>
                </View>
              ))}
              <Muted style={s.disclaimer}>
                ORBIT / 0.1 · EXPERIMENTAL{"\n"}Simulação e operações conectadas
                separadas. Execução exige configuração, políticas do backend e
                assinatura.
              </Muted>
            </>
          )}
        </ScrollView>
        {selected ? (
          <View style={s.tradeBar}>
            <Tap
              label={
                selected.kind === "spot" ? "Comprar · demo" : "Long · demo"
              }
              disabled={account.killed}
              onPress={() => chooseTicket("long")}
              style={[s.primary, { flex: 1 }]}
            >
              <Text style={s.primaryText}>
                {selected.kind === "spot" ? "Comprar" : "↑ Long"}
              </Text>
            </Tap>
            {selected.kind === "perp" && (
              <Tap
                label="Short · demo"
                disabled={account.killed}
                onPress={() => chooseTicket("short")}
                style={[s.primary, { backgroundColor: c.red, flex: 1 }]}
              >
                <Text style={s.primaryText}>↓ Short</Text>
              </Tap>
            )}
          </View>
        ) : (
          <View style={s.nav}>
            {nav.map((n) => (
              <Tap
                key={n.id}
                label={n.label}
                onPress={() => go(n.id)}
                style={[
                  s.navItem,
                  page === n.id && { backgroundColor: c.raised },
                ]}
              >
                <Icon
                  name={n.icon}
                  size={21}
                  color={page === n.id ? c.brand : c.muted}
                />
                <Text
                  style={{
                    fontSize: 10,
                    color: page === n.id ? c.brand : c.muted,
                    marginTop: 7,
                  }}
                >
                  {n.label}
                </Text>
              </Tap>
            ))}
          </View>
        )}
        <Modal
          visible={ticket !== null}
          transparent
          animationType="slide"
          onRequestClose={() => setTicket(null)}
        >
          <View style={s.modalStage}>
            <Tap
              label="Fechar ordem"
              onPress={() => setTicket(null)}
              style={{ flex: 1, width: "100%" }}
            >
              <View />
            </Tap>
            <View style={s.sheet}>
              <View style={s.handle} />
              <View
                style={[s.row, { paddingHorizontal: 22, paddingVertical: 14 }]}
              >
                <Tap
                  label="Cancelar ordem"
                  onPress={() => setTicket(null)}
                  style={s.iconButton}
                >
                  <Icon name="close" />
                </Tap>
                <View style={{ flex: 1, alignItems: "center" }}>
                  <Text style={s.h3}>
                    {review
                      ? "Revisar operação"
                      : ticket === "short"
                        ? "Abrir short"
                        : selected?.kind === "spot"
                          ? "Comprar"
                          : "Abrir long"}{" "}
                    · {selected?.symbol}
                  </Text>
                </View>
                <Pill text="DEMO" bright />
              </View>
              {review ? (
                <View style={{ padding: 24, gap: 22 }}>
                  <View style={{ alignItems: "center", paddingVertical: 14 }}>
                    <View style={s.successCircle}>
                      <Icon name="shield" color={c.green} size={30} />
                    </View>
                    <Text
                      style={[s.detailPrice, { fontSize: 36, marginTop: 18 }]}
                    >
                      {money(Number(amount) * leverage)}
                    </Text>
                    <Muted style={{ marginTop: 8 }}>
                      Exposição simulada · {leverage}×
                    </Muted>
                  </View>
                  <View style={s.reviewRow}>
                    <Muted>Margem USD</Muted>
                    <Text style={s.tokenPrice}>{money(Number(amount))}</Text>
                  </View>
                  <View style={s.reviewRow}>
                    <Muted>Preço da sessão</Muted>
                    <Text style={s.tokenPrice}>
                      {selected ? price(selected.price) : ""}
                    </Text>
                  </View>
                  <View style={s.reviewRow}>
                    <Muted>Tipo de execução</Muted>
                    <Text style={{ color: c.brand, fontSize: 13 }}>
                      Paper · sem transação
                    </Text>
                  </View>
                  <Muted style={{ lineHeight: 20, fontSize: 12 }}>
                    Sem taxas, funding, slippage ou liquidação contínua. Seus
                    fundos reais não serão movimentados.
                  </Muted>
                  <Tap
                    label="Confirmar simulação"
                    onPress={confirm}
                    disabled={account.killed}
                    style={s.primary}
                  >
                    <Text style={s.primaryText}>Confirmar simulação</Text>
                  </Tap>
                  <Tap
                    label="Editar ordem"
                    onPress={() => setReview(false)}
                    style={{ alignItems: "center", padding: 8 }}
                  >
                    <Muted>Editar valor</Muted>
                  </Tap>
                </View>
              ) : (
                <>
                  <View
                    style={{
                      paddingHorizontal: 24,
                      paddingTop: 25,
                      paddingBottom: 22,
                    }}
                  >
                    <Muted style={{ fontSize: 10, letterSpacing: 1.3 }}>
                      MARGEM SIMULADA
                    </Muted>
                    <View style={[s.row, { marginTop: 12 }]}>
                      <Text style={{ color: c.muted, fontSize: 34 }}>$</Text>
                      <TextInput
                        accessibilityLabel="Margem simulada em USD"
                        value={amount}
                        onChangeText={setAmount}
                        inputMode="decimal"
                        keyboardType="decimal-pad"
                        style={s.amountInput}
                      />
                      <Text style={{ color: c.muted, fontSize: 13 }}>USD</Text>
                    </View>
                    <Muted style={{ fontSize: 11, marginTop: 10 }}>
                      Disponível {money(account.cash)}
                    </Muted>
                  </View>
                  {selected?.kind === "perp" && (
                    <View style={s.leverageRow}>
                      <Muted>Alavancagem</Muted>
                      <View style={[s.row, { gap: 6 }]}>
                        {[1, 2, 5, 10].map((n) => (
                          <Tap
                            key={n}
                            label={`${n}×`}
                            onPress={() => setLeverage(n)}
                            style={[
                              s.leverage,
                              n === leverage && { backgroundColor: c.brand },
                            ]}
                          >
                            <Text
                              style={{
                                color: n === leverage ? c.onBrand : c.ink,
                                fontSize: 12,
                              }}
                            >
                              {n}×
                            </Text>
                          </Tap>
                        ))}
                      </View>
                    </View>
                  )}
                  <View style={{ paddingHorizontal: 20, paddingTop: 18 }}>
                    <View style={[s.row, { gap: 7 }]}>
                      {[25, 50, 75, 100].map((n) => (
                        <Tap
                          key={n}
                          label={`Usar ${n}% do saldo`}
                          onPress={() =>
                            setAmount(((account.cash * n) / 100).toFixed(2))
                          }
                          style={s.percent}
                        >
                          <Text style={{ color: c.ink, fontSize: 11 }}>
                            {n === 100 ? "Máx" : n + "%"}
                          </Text>
                        </Tap>
                      ))}
                    </View>
                    <View style={s.keypad}>
                      {[
                        "1",
                        "2",
                        "3",
                        "4",
                        "5",
                        "6",
                        "7",
                        "8",
                        "9",
                        ".",
                        "0",
                        "⌫",
                      ].map((k) => (
                        <Tap
                          key={k}
                          label={`Tecla ${k}`}
                          onPress={() => keypad(k)}
                          style={s.key}
                        >
                          <Text style={{ color: c.ink, fontSize: 21 }}>
                            {k}
                          </Text>
                        </Tap>
                      ))}
                    </View>
                    <Tap
                      label="Revisar simulação"
                      disabled={
                        !Number.isFinite(Number(amount)) ||
                        Number(amount) <= 0 ||
                        Number(amount) > account.cash ||
                        account.killed
                      }
                      onPress={() => setReview(true)}
                      style={[s.primary, { marginBottom: 24 }]}
                    >
                      <Text style={s.primaryText}>Revisar simulação</Text>
                    </Tap>
                  </View>
                </>
              )}
            </View>
          </View>
        </Modal>
      </View>
    </View>
  );
}

const createStyles = (c: Palette) => StyleSheet.create({
  stage: { flex: 1, backgroundColor: c.bg, alignItems: "center" },
  phone: {
    flex: 1,
    width: "100%",
    maxWidth: 480,
    backgroundColor: c.bg,
    paddingTop: Platform.OS === "ios" ? 48 : Platform.OS === "android" ? 28 : 8,
  },
  desktopPhone: {
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderColor: c.line,
  },
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  muted: { color: c.muted, fontSize: 13 },
  topbar: {
    minHeight: 68,
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: c.bg,
    borderBottomWidth: 1,
    borderBottomColor: c.line,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  walletButton: { flexDirection: "row", alignItems: "center", gap: 8 },
  avatar: {
    width: 29,
    height: 29,
    borderRadius: 15,
    backgroundColor: c.raised,
    justifyContent: "center",
    alignItems: "center",
  },
  iconButton: { padding: 7 },
  themeButton: {
    paddingHorizontal: 10,
    paddingVertical: 9,
    borderWidth: 1,
    borderColor: c.line,
    backgroundColor: c.raised,
    borderRadius: 10,
  },
  themeButtonText: { color: c.ink, fontSize: 11, fontWeight: "600" },
  themeSetting: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 16,
    marginBottom: 18,
    borderWidth: 1,
    borderColor: c.line,
    borderRadius: 14,
    backgroundColor: c.card,
  },
  balanceCard: {
    backgroundColor: c.card,
    borderWidth: 1,
    borderColor: c.line,
    borderRadius: 20,
    padding: 23,
    marginTop: 9,
    overflow: "hidden",
  },
  darkLabel: {
    color: c.muted,
    fontSize: 10,
    letterSpacing: 1.5,
    fontWeight: "600",
  },
  balanceValue: {
    color: c.ink,
    fontSize: 47,
    fontWeight: "600",
    letterSpacing: -2.5,
    marginTop: 18,
    marginBottom: 10,
    zIndex: 1,
  },
  balanceBottom: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 29,
  },
  orbital: { position: "absolute", right: -36, top: 35 },
  quickActions: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingTop: 22,
    paddingBottom: 24,
    paddingHorizontal: 12,
  },
  quickAction: { alignItems: "center" },
  quickCircle: {
    width: 48,
    height: 48,
    backgroundColor: c.raised,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
  },
  agentBanner: {
    padding: 14,
    backgroundColor: c.card,
    borderRadius: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  agentMark: {
    width: 41,
    height: 41,
    borderRadius: 13,
    backgroundColor: c.raised,
    alignItems: "center",
    justifyContent: "center",
  },
  section: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 27,
    marginBottom: 16,
  },
  h2: { color: c.ink, fontSize: 19, fontWeight: "600", letterSpacing: -0.4 },
  h3: { color: c.ink, fontSize: 14, fontWeight: "600" },
  perpCard: {
    width: 160,
    backgroundColor: c.card,
    borderWidth: 1,
    borderColor: c.line,
    borderRadius: 17,
    padding: 16,
  },
  tokenRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 11,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: c.line,
  },
  tokenName: { color: c.ink, fontSize: 13, fontWeight: "500" },
  symbol: { fontSize: 10, color: c.muted, fontWeight: "400" },
  tokenPrice: { color: c.ink, fontSize: 13, fontWeight: "500" },
  disclaimer: {
    fontSize: 10,
    lineHeight: 18,
    textAlign: "center",
    marginTop: 26,
    marginBottom: 6,
  },
  nav: {
    flexDirection: "row",
    paddingHorizontal: 12,
    paddingTop: 9,
    paddingBottom: Platform.OS === "ios" ? 28 : 12,
    backgroundColor: c.bg,
    borderTopWidth: 1,
    borderTopColor: c.line,
  },
  navItem: {
    alignItems: "center",
    flex: 1,
    paddingVertical: 8,
    borderRadius: 20,
  },
  pageTitle: {
    color: c.ink,
    fontSize: 29,
    fontWeight: "600",
    letterSpacing: -1,
    marginTop: 14,
    marginBottom: 16,
  },
  searchBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    backgroundColor: c.card,
    borderRadius: 12,
    paddingHorizontal: 14,
    minHeight: 47,
  },
  searchInput: {
    flex: 1,
    color: c.ink,
    fontSize: 13,
    paddingVertical: 13,
    minWidth: 0,
  },
  filters: { flexDirection: "row", gap: 5, marginTop: 18, marginBottom: 3 },
  filter: { paddingHorizontal: 13, paddingVertical: 10, borderRadius: 18 },
  filterActive: { backgroundColor: c.raised },
  detailPrice: {
    color: c.ink,
    fontSize: 42,
    letterSpacing: -1.5,
    fontWeight: "600",
  },
  chartCaption: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 13,
  },
  statGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  statTile: {
    width: "48%",
    flexGrow: 1,
    backgroundColor: c.card,
    borderWidth: 1,
    borderColor: c.line,
    borderRadius: 15,
    padding: 16,
  },
  tradeBar: {
    flexDirection: "row",
    gap: 11,
    padding: 20,
    paddingBottom: Platform.OS === "ios" ? 32 : 20,
    backgroundColor: c.bg,
    borderTopWidth: 1,
    borderTopColor: c.line,
  },
  primary: {
    minHeight: 52,
    paddingHorizontal: 20,
    borderRadius: 28,
    backgroundColor: c.brand,
    justifyContent: "center",
    alignItems: "center",
  },
  primaryText: { color: c.onBrand, fontSize: 16, fontWeight: "700" },
  dataPanel: {
    padding: 18,
    backgroundColor: c.card,
    borderWidth: 1,
    borderColor: c.line,
    borderRadius: 16,
    marginTop: 25,
  },
  refresh: { padding: 8 },
  agentCard: {
    padding: 18,
    borderRadius: 16,
    backgroundColor: c.card,
    borderWidth: 1,
    borderColor: c.line,
    marginBottom: 13,
  },
  toggle: {
    width: 42,
    height: 25,
    borderRadius: 14,
    padding: 3,
    backgroundColor: c.line,
    justifyContent: "center",
  },
  toggleKnob: {
    width: 19,
    height: 19,
    borderRadius: 10,
    backgroundColor: c.muted,
  },
  progress: { height: 3, borderRadius: 2, backgroundColor: c.raised },
  agentRun: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingTop: 19,
    marginTop: 17,
    borderTopWidth: 1,
    borderTopColor: c.line,
  },
  emergency: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    padding: 17,
    borderWidth: 1,
    borderColor: c.red,
    borderRadius: 14,
    marginTop: 4,
  },
  killBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 10,
    paddingHorizontal: 20,
    backgroundColor: c.negativeTint,
  },
  toast: {
    marginHorizontal: 20,
    marginBottom: 10,
    padding: 12,
    borderWidth: 1,
    borderColor: c.line,
    backgroundColor: c.raised,
    borderRadius: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
  },
  empty: {
    alignItems: "center",
    paddingVertical: 28,
    paddingHorizontal: 25,
    gap: 14,
  },
  smallAction: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    padding: 10,
  },
  smallActionText: { color: c.brand, fontSize: 12 },
  position: {
    padding: 16,
    borderRadius: 15,
    backgroundColor: c.card,
    marginBottom: 11,
  },
  closePosition: {
    alignItems: "center",
    padding: 11,
    backgroundColor: c.raised,
    borderRadius: 8,
    marginTop: 16,
  },
  historyRow: {
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: c.line,
    flexDirection: "row",
    gap: 12,
    alignItems: "center",
  },
  historyIcon: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
  },
  profileCard: {
    flexDirection: "row",
    gap: 12,
    alignItems: "center",
    paddingVertical: 20,
  },
  connection: {
    paddingVertical: 20,
    borderBottomWidth: 1,
    borderBottomColor: c.line,
  },
  modalStage: {
    flex: 1,
    alignItems: "center",
    justifyContent: "flex-end",
    backgroundColor: c.overlay,
  },
  sheet: {
    width: "100%",
    maxWidth: 480,
    backgroundColor: c.card,
    borderTopLeftRadius: 27,
    borderTopRightRadius: 27,
    paddingBottom: Platform.OS === "ios" ? 20 : 0,
  },
  handle: {
    width: 34,
    height: 4,
    borderRadius: 2,
    backgroundColor: c.line,
    alignSelf: "center",
    marginTop: 10,
  },
  amountInput: {
    flex: 1,
    fontSize: 42,
    fontWeight: "500",
    color: c.ink,
    minWidth: 0,
    padding: 0,
  },
  leverageRow: {
    paddingVertical: 15,
    paddingHorizontal: 24,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: c.line,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 6,
  },
  leverage: { padding: 9, borderRadius: 8, backgroundColor: c.raised },
  percent: {
    flex: 1,
    padding: 9,
    alignItems: "center",
    borderRadius: 6,
    backgroundColor: c.raised,
  },
  keypad: {
    flexDirection: "row",
    flexWrap: "wrap",
    marginTop: 10,
    marginBottom: 12,
  },
  key: {
    width: "33.333%",
    height: 49,
    justifyContent: "center",
    alignItems: "center",
  },
  reviewRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  successCircle: {
    width: 64,
    height: 64,
    backgroundColor: c.raised,
    borderRadius: 32,
    justifyContent: "center",
    alignItems: "center",
  },
});
