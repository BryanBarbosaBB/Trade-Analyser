# Analisador de Mercado (web)

Uma única página web, sem servidor e sem instalação. Você abre no navegador (PC ou celular) e clica em
**Varrer todos**. A página baixa as cotações, calcula a análise e mostra um painel com os ativos
ordenados pelo score. Tocando num ativo, abre o gráfico com zonas, suportes e resistências, entrada,
SL e TP, e o botão **Analisar com IA**.

> Ferramenta de estudo e apoio à decisão. **Não é recomendação de investimento.**

## Como funciona
| Parte | O que faz |
|---|---|
| `js/data.js` | Cotações do **Twelve Data** (plano grátis). Busca M15, H1 e D1 e monta o H4 a partir do H1, ou seja, 3 requisições por ativo. Respeita o limite de 8 por minuto e guarda cache no navegador. |
| `js/indicators.js` | EMA 50/200, RSI(14), MACD, ATR(14) e ADX, com suavização de Wilder, como no TradingView e no MT5 |
| `js/analysis.js` | Topos e fundos, tendência por timeframe, S/R agrupados, zonas de oferta e demanda, máx./mín. do dia e da semana anteriores, sessões, divergência de RSI |
| `js/setups.js` | Setups **Pullback na tendência** e **Rompimento com reteste**, score de 0 a 100 e status ENTRADA / OBSERVAR / SEM SETUP |
| `js/risk.js` | SL além da invalidação mais 0,2 ATR, limitado entre 0,8 e 2,5 ATR. TP1 = 1R, TP2 = próximo nível com R:R ≥ 1,5, TP3 = 3R ou nível do H4/D1. Também calcula o lote. |
| `js/ai.js` | **Google Gemini** (grátis). Recebe só os números calculados e devolve resumo, qualidade de 1 a 5, riscos e se confirma o setup. Também faz o ranking entre ativos. Nunca cria preços. |

**Composição do score:** alinhamento D1/H4 vale 30, qualidade da zona 20, momento (RSI/MACD) 15, R:R até o nível contrário 15, volatilidade 10 e sessão 10.

## Chaves gratuitas (só precisa de e-mail)
1. **Twelve Data:** https://twelvedata.com/pricing → plano *Basic* (grátis) → copie a API key.
2. **Gemini:** https://aistudio.google.com/app/apikey → *Create API key*.
3. Na página, abra **Configurações**, cole as duas chaves e clique em **Salvar**. As chaves ficam só no seu navegador.

**Limites do plano grátis do Twelve Data:** 8 requisições por minuto e 800 por dia.
- Varrer os 12 ativos usa 36 requisições e leva uns 5 minutos por causa do limite por minuto.
- Abrir um único ativo é rápido.
- **NAS100/US30:** os índices (`NDX`/`DJI`) não estão no plano grátis. Por isso a página usa os ETFs **QQQ/DIA**, que acompanham os mesmos índices. Servem para ler tendência e estrutura, mas o preço é diferente do índice e o lote não é calculado.
- **Gemini:** quando o modelo principal está sobrecarregado ou não responde em 25 s, a página tenta de novo e depois troca sozinha para `gemini-flash-lite-latest`.

## Login e chaves salvas no site (cofre)
As chaves podem ficar gravadas no site, **criptografadas** (AES-256-GCM, chave derivada de usuário e senha com PBKDF2, 600 mil iterações). Com o cofre criado:
- Na primeira vez em cada aparelho, clique em **Entrar** e informe usuário e senha. Com **Lembrar neste aparelho** marcado, o painel passa a abrir direto, já com as chaves.
- **Configurações** sempre pedem login de novo a cada sessão.
- **Sair e esquecer chaves deste aparelho** apaga as chaves do navegador.

Criar ou trocar o cofre (rode no seu terminal):
```
cd C:\CLAUDE\analisador-web
node scripts/make-vault.js
git add js/vault.js
git commit -m "Atualiza cofre"
git push
```
O arquivo do cofre é público, então qualquer um pode testar senhas nele sem limite. Use uma senha forte, com 12 caracteres ou mais; o script recusa senhas curtas.

## Usar no PC agora
Os arquivos funcionam abrindo o `index.html` direto. Se o navegador bloquear, sirva a pasta:
```
cd C:\CLAUDE\analisador-web
python -m http.server 8765
```
e abra http://127.0.0.1:8765

## Publicar grátis para abrir no celular (GitHub Pages)
1. Crie uma conta em https://github.com e um repositório novo, por exemplo `analisador`.
2. Na página do repositório: **Add file → Upload files** → arraste o **conteúdo** da pasta `analisador-web` (index.html, css/, js/) → **Commit**.
3. **Settings → Pages → Branch: main / (root) → Save**.
4. Em cerca de 1 minuto o site fica em `https://SEU-USUARIO.github.io/analisador/`. Abra no celular e configure as chaves; cada navegador guarda as suas.

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
node --test tests/engine.test.js        # 19 testes do motor (indicadores, níveis, zonas, setups, SL/TP, lote)
node scripts/smoke.js SUA_CHAVE XAUUSD  # análise com dados reais no terminal
```
