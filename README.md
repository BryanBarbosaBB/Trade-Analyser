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
| Quando roda | A cada 30 min, do domingo à noite até sexta, das **08:00 às 03:00** de Brasília (nada entre 03:00 e 08:00). Horários em `scripts/agenda.js`. |
| Como garante o horário | O cron do GitHub atrasa e pula horários. Por isso cada rodada, ao terminar, espera o próximo horário e dispara a seguinte (uma "corrente"). Um cron de hora em hora só religa a corrente se ela cair. Rodadas "Cancelled" na lista de Actions são normais: são reservas que não foram necessárias. |
| Ásia | Das 21:00 às 03:00 de Brasília, a sessão da Ásia também gera ENTRADA e notificação, marcada **"ÁSIA (não validado)"**: no backtest MT5 ela perdeu no treino (−0,20R/trade) e ganhou no teste (+0,15R). Ligado por `asiaSignals` (scripts/scan.js e js/app.js). |
| Arquivo | `.github/workflows/varredura.yml` → `node scripts/scan.js` |
| Onde salva | Ramo **`dados`** do repositório: `scan.json` (resumo, histórico e controle de alertas) e `velas/<ATIVO>.json`. Cada rodada substitui o commit anterior, então o ramo não cresce. |
| O site | Lê o commit mais novo do ramo `dados` e, ao abrir um ativo, refaz a análise com as velas salvas (mesmo resultado da varredura). Atualiza sozinho a cada 5 min. |
| Alertas | Um por ENTRADA. O mesmo ativo/setup/direção não repete enquanto o sinal continua ativo; se ele deixar de ser ENTRADA numa varredura e voltar depois, avisa de novo. A notificação abre o site direto no ativo. |
| Consultas | Só busca as velas que podem ter mudado (M15 a cada rodada, H1 a cada hora, D1 uma vez por dia); QQQ/DIA só no pregão americano. Cerca de 650 por dia (teste `orçamento` em `tests/scan.test.js`), abaixo do limite grátis de 800. Cada *Run workflow* manual gasta até 36 a mais. |

### Configurar (uma vez)
No GitHub: **repositório → Settings → Secrets and variables → Actions → New repository secret**:
- `TD_KEY`: chave da Twelve Data (https://twelvedata.com/account/api-keys).
- `GEMINI_KEY`: chave do Gemini, para os botões da IA (https://aistudio.google.com/apikey).
- `NTFY_TOPIC`: tópico do app ntfy (o mesmo assinado no celular).

Para testar na hora: **Actions → Varredura → Run workflow**. Para testar só a notificação no celular: **Actions → Teste de notificação → Run workflow**.

Observações:
- Em **Actions** sempre há uma rodada da Varredura "em andamento": é a corrente esperando o próximo horário. Não cancele.
- Em repositório público, o GitHub desliga o cron de reserva depois de 60 dias sem commits (a corrente continua). Se ele avisar por e-mail, clique em *Enable workflow* em **Actions**.
- Se a varredura falhar, o GitHub manda e-mail e o site continua mostrando a última varredura boa.
- Teste local do site com dados de uma pasta: `python -m http.server 8770` e abra `http://127.0.0.1:8770/?dados=pasta`.

## Botões manuais do site
Nenhuma chave fica no site. O botão publica um pedido num tópico do ntfy; a rodada do GitHub Actions que está sempre esperando o próximo horário executa com os secrets e salva no ramo `dados` (`scripts/comandos.js`). Funciona igual em qualquer aparelho.

| Botão | O que faz |
|---|---|
| **Varrer agora** | Varre os 12 ativos na hora, em qualquer horário. Vale para todos os aparelhos, entra no histórico e notifica ENTRADA. Só usa a cota que sobra da varredura automática (no máximo 790 consultas/dia no total; fim de semana fica livre). |
| **Ranking IA** / **Analisar com IA** | O Gemini comenta os números do motor (precisa do secret `GEMINI_KEY`). Não cria preço nem ENTRADA. Até 40 por dia. |

Se a nuvem estiver trocando de rodada, o pedido espera na fila até ~5 min. O tópico de pedidos é público: quem ler o código pode pedir uma varredura, mas só dentro desses limites e sem acesso a nada mais.

**Falta:** cada ativo que não é ENTRADA mostra o que ainda falta. O score mede a qualidade da área supondo a entrada nela; score alto sem gatilho não é sinal.

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

Leitura: no período longo, a regra nos 12 ativos fica no zero a zero. O resultado positivo dos 46 dias foi do momento. Escolhendo os ativos com dados antigos e testando no período novo sobra uma vantagem pequena (+0,16R), que ainda pode ser sorte estatística, com quedas de até 20R.

### Afrouxar a regra ajuda? (25/11/2026, `scripts/lab3.js`, mesmos dados, saída TP3)
| Regra (12 ativos) | Treino (até 06/2025) | Teste (07/2025–11/2026) |
|---|---|---|
| ENTRADA, checando a cada 30 min (atual) | −0,05R | +0,03R |
| ENTRADA, checando a cada 15 min | −0,07R | −0,13R |
| Score ≥ 75 sem gatilho, a mercado | −0,09R | −0,14R |
| Score ≥ 85 sem gatilho, a mercado | −0,05R | +0,07R |
| Score ≥ 75 sem gatilho, ordem limite na área | −0,03R | −0,07R |
| Gatilho bloqueado pelas travas | −0,08R | −0,13R |

Leitura: nenhuma alternativa deu lucro no treino e no teste ao mesmo tempo. A varredura de 30 min perde 29% dos episódios de ENTRADA, mas os sinais de :15/:45 não foram melhores. A regra ficou como estava.

## Testes
```
node --test tests/engine.test.js tests/scan.test.js   # motor + varredura automática (40 testes)
node scripts/smoke.js SUA_CHAVE XAUUSD  # análise com dados reais no terminal
```
