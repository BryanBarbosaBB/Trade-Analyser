# Robô MT5 (alerta no celular + ordens na conta demo)

Roda no seu PC com Windows, ao lado do MetaTrader 5. A cada vela de 15 minutos ele analisa os ativos com o
mesmo motor do site. Quando aparece um sinal que passa no filtro, ele **avisa no celular** e, no modo `demo`,
**abre a ordem na conta demo** com SL e TP.

## 1. Instalar (uma vez)
1. **MetaTrader 5 da OANDA**: baixe pelo site da OANDA, instale e **faça login na sua conta demo** (você mesmo).
   - No MT5: *Ferramentas → Opções → Expert Advisors → marque "Permitir negociação algorítmica"*.
   - Botão **Algo Trading** na barra de cima deve ficar verde.
2. **Python** (já instalado) e **Node** (já instalado). No PowerShell:
   ```
   pip install MetaTrader5 requests
   ```
3. **App ntfy** no celular (Android/iPhone) → **+** → assine um tópico com nome difícil de adivinhar
   (ex.: `bryan-trade-8k2p`). Coloque o mesmo nome em `bot/config.json` → `"ntfy_topico"`.

## 2. Rodar
Com o MT5 aberto e logado:
```
cd C:\CLAUDE\analisador-web
python bot/mt5_bot.py
```
Deixe a janela aberta. O histórico fica em `bot/bot.log`. Para parar: **Ctrl+C**.

## 3. config.json
| Campo | O que faz |
|---|---|
| `modo` | `"alerta"` = só avisa · `"demo"` = avisa e abre ordem na conta demo |
| `permitir_conta_real` | `false` = em conta real ele só avisa, nunca opera |
| `risco_por_trade_pct` | % do saldo arriscado por operação (lote calculado com os dados reais da corretora) |
| `max_posicoes` | máximo de posições abertas ao mesmo tempo |
| `perda_maxima_dia_pct` | perdeu isso no dia → para de abrir ordens até o dia seguinte |
| `simbolos` | se o nome na corretora for diferente, ex.: `{"NAS100": "NAS100.sml"}` |
| `filtro` | regras que o sinal precisa cumprir (use o resultado do backtest) |
| `filtro.saida` | `parcial` (metade no TP1, stop na entrada, resto no TP2), `tp1`, `tp2`, `tp3` ou `tp05` |

Comece em `"modo": "alerta"` por alguns dias, compare os avisos com o gráfico e só depois troque para `"demo"`.
