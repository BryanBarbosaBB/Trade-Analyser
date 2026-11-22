# Analisador de Mercado (web)

Uma página web sem login. Uma **varredura automática** roda no GitHub a cada 30 minutos: baixa as cotações,
calcula a análise dos 12 ativos e salva o resultado. Quando aparece uma **ENTRADA**, chega uma notificação no
celular (app ntfy). O site (https://bryanbarbosabb.github.io/Trade-Analyser/) só mostra o que foi salvo, por isso
**PC e celular veem exatamente o mesmo resultado**. Tocando num ativo, abre o gráfico com zonas, suportes e
resistências, entrada, SL e TP. Embaixo do painel fica o **histórico de sinais de ENTRADA**.

> Ferramenta de estudo e apoio à decisão. **Não é recomendação de investimento.**

## Varredura automática (GitHub Actions)
| Item | Como é |
|---|---|
| Quando roda | A cada 30 min, de segunda a sexta, das 07:00 às 20:30 UTC (**04:00–17:30 em Brasília**), que é o horário de Londres/NY. Fora dele o motor nunca dá ENTRADA. |
| Arquivo | `.github/workflows/varredura.yml` → `node scripts/scan.js` |
| Onde salva | Ramo **`dados`** do repositório: `scan.json` (resumo, histórico e controle de alertas) e `velas/<ATIVO>.json`. Cada rodada substitui o commit anterior, então o ramo não cresce. |
| O site | Lê o commit mais novo do ramo `dados` e, ao abrir um ativo, refaz a análise com as velas salvas (mesmo resultado da varredura). Atualiza sozinho a cada 5 min. |
| Alertas | Um por ENTRADA. O mesmo ativo/setup/direção só avisa de novo depois de 4 h. A notificação abre o site direto no ativo. |
| Consultas | Só busca as velas que podem ter mudado (M15 a cada rodada, H1 a cada hora, D1 uma vez por dia): cerca de 540 por dia, abaixo do limite grátis de 800. |

### Configurar (uma vez)
No GitHub: **repositório → Settings → Secrets and variables → Actions → New repository secret**:
- `TD_KEY`: chave da Twelve Data (https://twelvedata.com/account/api-keys).
- `NTFY_TOPIC`: tópico do app ntfy (o mesmo assinado no celular).

Para testar na hora: **Actions → Varredura → Run workflow**.

Observações:
- O GitHub pode atrasar as rodadas agendadas alguns minutos quando está sobrecarregado.
- Em repositório público, o GitHub **desliga os agendamentos depois de 60 dias sem commits**. Se isso acontecer, ele avisa por e-mail; basta clicar em *Enable workflow* em **Actions**.
- Se a varredura falhar, o GitHub manda e-mail e o site continua mostrando a última varredura boa.
- Teste local do site com dados de uma pasta: `python -m http.server 8770` e abra `http://127.0.0.1:8770/?dados=pasta`.

## Como funciona
| Parte | O que faz |
|---|---|
| `scripts/scan.js` | Varredura automática: busca M15, H1 e D1 na **Twelve Data**, monta o H4 a partir do H1, roda o motor e salva no ramo `dados`. NAS100/US30 usam os ETFs **QQQ/DIA** (os índices não estão no plano grátis; o lote não é calculado). |
| `js/data.js` | Leitura e conversão das velas e montagem do H4 |
| `js/indicators.js` | EMA 50/200, RSI(14), MACD, ATR(14) e ADX, com suavização de Wilder, como no TradingView e no MT5 |
| `js/analysis.js` | Topos e fundos, tendência por timeframe, S/R agrupados, zonas de oferta e demanda, máx./mín. do dia e da semana anteriores, sessões, divergência de RSI |
| `js/setups.js` | Setups **Pullback na tendência** e **Rompimento com reteste**, score de 0 a 100 e status ENTRADA / OBSERVAR / SEM SETUP |
| `js/risk.js` | SL além da invalidação mais 0,2 ATR, limitado entre 0,8 e 2,5 ATR. TP1 = 1R, TP2 = próximo nível com R:R ≥ 1,5, TP3 = 3R ou nível do H4/D1. Também calcula o lote. |

**Composição do score:** alinhamento D1/H4 vale 30, qualidade da zona 20, momento (RSI/MACD) 15, R:R até o nível contrário 15, volatilidade 10 e sessão 10.

## Backtest
```
set TD_KEY=sua_chave_twelve_data
node scripts/backtest.js            (todos os ativos; ou: node scripts/backtest.js XAUUSD EURJPY)
```
O script reproduz o motor vela a vela, sem olhar o futuro. Para cada gatilho ele simula 5 saídas (0,5R, TP1, TP2, TP3 e parcial), desconta o spread e permite uma posição por ativo. Depois escolhe o melhor filtro nos primeiros 70% do período e mede nos 30% finais, que a escolha nunca viu.

Resultado de 13/11/2026 (forex e ouro: cerca de 46 dias; QQQ/DIA: cerca de 9 meses; 12 ativos):
| Regra | Trades | Acerto | Média | Total | Pior queda |
|---|---|---|---|---|---|
| Todos os gatilhos, sem filtro (saída parcial) | 1518 | 49% | −0,13R | −198R | 210R |
| Alvo curto de 0,5R (gatilhos sem filtro) | 2169 | 63% | −0,17R | −367R | 375R |
| **ENTRADA + D1/H4 alinhados, saída TP3 (regra atual)** | 26 | 38% | **+0,35R** | +9,1R | 5,6R |

Leitura: os gatilhos sozinhos perdem dinheiro; só os filtros tornam o resultado positivo. Acertar mais (alvo curto) dá prejuízo; o lucro veio de **deixar os ganhos correrem** (TP3). A amostra ainda é pequena, então a demo é a prova real.

### Backtest com 3,5 anos do MT5 (13/11/2026)
Para rodar: `python scripts/export_mt5.py 3` e depois `node scripts/backtest.js --mt5`. Os dados vêm da demo MetaQuotes, com horário de verão tratado e spread conservador.

| Regra | Trades | Acerto | Média | Total | Pior queda |
|---|---|---|---|---|---|
| Todos os gatilhos, sem filtro (TP3) | 19.351 | 28% | −0,08R | −1.500R | 1.558R |
| Alvo curto 0,5R (sem filtro) | 42.217 | 66% | −0,10R | −4.358R | 4.369R |
| Regra atual (ENTRADA), 12 ativos, TP3 | 565 | 30% | −0,01R | −4,9R | 46,5R |
| Regra atual só em XAUUSD, NAS100, US30, EURJPY, EURUSD: **teste 2025-26** (ativos escolhidos só com 2023-24) | 150 | 32% | **+0,16R** | +24,4R | 20,4R |

Leitura: no período longo, a regra nos 12 ativos fica no zero a zero. O resultado positivo dos 46 dias foi do momento. Escolhendo os ativos com dados antigos e testando no período novo sobra uma vantagem pequena (+0,16R), que ainda pode ser sorte estatística, com quedas de até 20R. O robô opera só esses 5 ativos.

## Testes
```
node --test tests/engine.test.js tests/scan.test.js   # motor + varredura automática (25 testes)
node scripts/smoke.js SUA_CHAVE XAUUSD  # análise com dados reais no terminal
```
