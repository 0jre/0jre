# Orbit — mobile agent trading sandbox

Aplicativo Expo / React Native com suporte web, Android e iOS a partir da mesma base TypeScript. Esta é uma primeira base funcional **paper trading**, não uma plataforma completa de execução real.

## Executar

Na raiz do repositório, Node 22:

```bash
npm ci --ignore-scripts
npm start             # Metro / Expo Go, Android ou iOS em ambiente apropriado
npm run web           # Expo web em :8081
npm run typecheck
npm test
npm run build:web     # saída apps/mobile/dist
```

Não há variáveis secretas, conexão de carteira ou transações. Não informe seed phrase ou chave privada. Builds nativos e testes em aparelhos não foram realizados neste ambiente Linux; o export web é o alvo verificado.

## Funcionalidades desta versão

- Interface adaptativa em português: visão geral, busca e filtros de mercados, terminal, agentes, portfólio e transparência de conexões.
- US$ 10.000 fictícios; compras spot e long/short perp com margem isolada de 1–10×, fechamento e PnL marcado às cotações da sessão.
- Três estratégias determinísticas, uma ordem por clique. Orçamento cumulativo por agente, teto por ordem, limite de alavancagem e pausa individual.
- Parada de emergência bloqueia novas entradas manuais e de agentes; encerramentos permanecem disponíveis.
- Persistência local da conta via AsyncStorage, sem sincronização ou backend.
- Comandos locais `status`, `risco` e `sol`; o copiloto não usa um LLM.

## Dados e cobertura real

Os oito mercados iniciais têm preços e históricos **ilustrativos**. O botão de atualização consulta apenas os endpoints públicos abaixo, sem chave:

- Hyperliquid: `POST https://api.hyperliquid.xyz/info`, `{"type":"allMids"}` para BTC, ETH e SOL.
- DexScreener: `GET https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112`, escolhendo o par válido SOL/Solana de maior liquidez.

Falhas preservam os preços anteriores e mostram erro. A atualização é um snapshot manual, não um feed WebSocket. O preço atualizado não torna as variações, volumes e gráficos ao vivo; eles continuam demo. Cotações ao vivo não são persistidas, apenas a conta. Ao reabrir, posições são reavaliadas pelos preços demo até nova atualização, portanto o PnL pode mudar. O histórico é o registro de entradas; fechamentos removem a posição e creditam caixa, sem diário de fechamento separado.

Solana, Pump.fun, Meteora, Raydium e Jupiter são referências de mercados demonstrativos, não integrações de execução. Hyperliquid é leitura de preços, não envio de ordens. GMGN não está integrado; **não há paridade de cobertura de todas as redes, tokens ou pools**.

## Modelo de risco e limites

`amount` é margem USD; exposição = margem × alavancagem. Spot só admite long 1×. Agentes consomem orçamento por notional de entrada, sem reembolso no fechamento. Perdas simuladas de cada posição são limitadas à margem. Não existe liquidação contínua, taxas, funding, spread, slippage, MEV, RPC, oráculos, custódia, autenticação ou reconciliação on-chain. Não utilizar resultados do simulador como previsão de execução real.

Antes de oferecer execução real: backend autenticado, políticas de autorização e limites do lado servidor, carteira não custodial e aprovação de assinatura, integração oficial de cada venue, indexação verificável, simulação de transação, proteção MEV, auditoria e reconciliação, feeds e funding/liquidação, testes em testnet e revisão de segurança. IA autônoma e suporte multichain são trabalho futuro, não funcionalidades entregues.

## Segurança de dependências

A auditoria inicial revelou 14 advisories. Foi aplicado override PostCSS compatível; restam 13 (1 high, 11 moderate, 1 low) na cadeia de ferramentas Expo/Metro: image-size, glob/minimatch e deepmerge. `npm audit` ainda falha. Não foram forçadas versões major incompatíveis. Não processe assets/configurações de fontes não confiáveis; revisar atualização do SDK e advisories antes de distribuição em produção.
