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
cd C:\CLAUDEnalisador-web
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

## Testes
```
node --test tests/engine.test.js        # 19 testes do motor (indicadores, níveis, zonas, setups, SL/TP, lote)
node scripts/smoke.js SUA_CHAVE XAUUSD  # análise com dados reais no terminal
```
