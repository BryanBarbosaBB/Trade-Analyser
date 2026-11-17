"""
Robô do Analisador de Mercado para MetaTrader 5 (Windows).

O que faz, a cada vela de 15 minutos fechada:
  1. Lê as velas M15/H1/D1 de cada ativo direto do seu MT5 (preços da sua corretora).
  2. Roda o MESMO motor de análise do site (scripts/signal.js, via Node).
  3. Se houver sinal que passe no filtro do config.json:
       - modo "alerta": só manda notificação para o celular (ntfy);
       - modo "demo":  manda notificação E abre a ordem na conta DEMO, com SL e TP.
Gestão das posições (a cada 10 s): na saída "parcial", fecha metade no TP1 e move o stop para a entrada.

Travas de segurança:
  - Recusa operar conta REAL (só alerta), a não ser que config.json tenha "permitir_conta_real": true.
  - Uma posição por ativo, no máximo "max_posicoes" abertas.
  - Para de abrir ordens no dia se a perda do dia passar de "perda_maxima_dia_pct" da conta.

Uso:  python bot/mt5_bot.py            (com o MT5 aberto e logado na conta demo)
"""
from __future__ import annotations

import json
import logging
import math
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

try:
    import MetaTrader5 as mt5
except ImportError:
    sys.exit("Instale a biblioteca: pip install MetaTrader5 requests")

ROOT = Path(__file__).resolve().parent.parent
BOT = Path(__file__).resolve().parent
CFG = json.loads((BOT / "config.json").read_text(encoding="utf-8"))
STATE_FILE = BOT / "state.json"
MAGIC = 260611        # estratégia principal (motor do site)
MAGIC_RSI2 = 260612   # estratégia RSI(2) nos índices
MAGIC_IBS = 260613    # estratégia IBS (compra no dia seguinte a um fechamento fraco, sai no fim do dia)
MAGICS = (MAGIC, MAGIC_RSI2, MAGIC_IBS)
TF = {"M15": (mt5.TIMEFRAME_M15, 500), "H1": (mt5.TIMEFRAME_H1, 1200), "D1": (mt5.TIMEFRAME_D1, 400)}

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s",
    handlers=[logging.FileHandler(BOT / "bot.log", encoding="utf-8"), logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger("bot")


# ---------------------------------------------------------------- estado
def load_state() -> dict:
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {"alerted": {}, "partial_done": []}


def save_state(st: dict) -> None:
    STATE_FILE.write_text(json.dumps(st), encoding="utf-8")


# ---------------------------------------------------------------- notificação
def notify(title: str, msg: str, priority: int = 4) -> None:
    topic = CFG.get("ntfy_topico", "").strip()
    if not topic:
        return
    try:
        requests.post(CFG.get("ntfy_servidor", "https://ntfy.sh"), json={
            "topic": topic, "title": title, "message": msg, "priority": priority, "tags": ["chart_with_upwards_trend"],
        }, timeout=10)
    except Exception as e:
        log.warning("Falha ao notificar: %s", e)


# ---------------------------------------------------------------- MT5
def connect() -> None:
    if not mt5.initialize():
        sys.exit(f"Não conectou ao MT5 (abra o terminal e faça login): {mt5.last_error()}")
    acc = mt5.account_info()
    tipo = {0: "DEMO", 1: "CONCURSO", 2: "REAL"}.get(acc.trade_mode, "?")
    log.info("Conectado: conta %s (%s), servidor %s, saldo %.2f %s", acc.login, tipo, acc.server, acc.balance, acc.currency)


def is_demo() -> bool:
    return mt5.account_info().trade_mode == mt5.ACCOUNT_TRADE_MODE_DEMO


def server_offset() -> timedelta:
    """Diferença do relógio do servidor da corretora para UTC (as velas do MT5 vêm no horário do servidor)."""
    best = None
    for sym in ("EURUSD", "XAUUSD", "GBPUSD"):
        s = resolve(sym)
        tick = s and mt5.symbol_info_tick(s)
        if tick and (best is None or tick.time > best):
            best = tick.time
    if best is None:
        return timedelta(0)
    diff = best - time.time()
    return timedelta(hours=round(diff / 3600))


_symbols: dict[str, str | None] = {}


def resolve(name: str) -> str | None:
    """Nome do ativo na corretora (ex.: NAS100 pode ser 'NAS100', 'NAS100.sml', 'US100'...)."""
    if name in _symbols:
        return _symbols[name]
    wanted = CFG.get("simbolos", {}).get(name) or name
    found = None
    if mt5.symbol_info(wanted):
        found = wanted
    else:
        cands = mt5.symbols_get(f"*{wanted}*") or ()
        found = cands[0].name if cands else None
    if found:
        mt5.symbol_select(found, True)
    _symbols[name] = found
    return found


def candles(sym: str, tf: str, offset: timedelta) -> list[dict]:
    code, n = TF[tf]
    rates = mt5.copy_rates_from_pos(sym, code, 1, n)  # posição 1: ignora a vela ainda aberta
    if rates is None or len(rates) == 0:
        raise RuntimeError(f"sem velas {sym} {tf}: {mt5.last_error()}")
    off = int(offset.total_seconds())
    return [{"t": int(r["time"]) - off, "o": float(r["open"]), "h": float(r["high"]), "l": float(r["low"]), "c": float(r["close"])} for r in rates]


# ---------------------------------------------------------------- análise (motor do site)
def analyze(name: str, data: dict, now: float) -> dict:
    p = subprocess.run(["node", str(ROOT / "scripts" / "signal.js")], input=json.dumps({"asset": name, "data": data, "nowSec": now}),
                       capture_output=True, text=True, encoding="utf-8", timeout=60)
    return json.loads(p.stdout or '{"ok": false, "error": "sem resposta do node"}')


def passes(c: dict, res: dict) -> bool:
    f = CFG["filtro"]
    if not c or not c.get("triggered"):
        return False
    if f.get("exigir_status_entrada", True) and c["status"] != "ENTRADA":
        return False
    if c["score"] < f.get("score_minimo", 75):
        return False
    if f.get("so_londres_ny", True) and not res.get("sessionGood"):
        return False
    if c["rrNext"] < f.get("caminho_livre_minimo_R", 1.0):
        return False
    if c["align"] < f.get("alinhamento_minimo", 0):
        return False
    setups = f.get("setups")
    return not setups or c["name"] in setups


# ---------------------------------------------------------------- ordens
def my_positions(sym: str | None = None, magic: int = MAGIC):
    pos = mt5.positions_get(symbol=sym) if sym else mt5.positions_get()
    return [p for p in (pos or []) if p.magic == magic]


def day_pnl() -> float:
    start = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    deals = mt5.history_deals_get(start, datetime.now(timezone.utc) + timedelta(days=1)) or ()
    return sum(d.profit + d.commission + d.swap for d in deals if d.magic in MAGICS)


def loss_money(sym: str, entry: float, sl: float, lots: float) -> float:
    """Quanto se perde (US$) se o preço for da entrada até o stop com esse lote."""
    # usa o cálculo da própria corretora: o trade_tick_value do ouro na MetaQuotes vem 10x menor que o real
    loss = mt5.order_calc_profit(mt5.ORDER_TYPE_BUY, sym, lots, entry, entry - abs(entry - sl))
    if loss is None:
        info = mt5.symbol_info(sym)
        return abs(entry - sl) / info.trade_tick_size * info.trade_tick_value * lots
    return abs(loss)


def lot_size(sym: str, entry: float, sl: float, risk_pct: float | None = None, name: str | None = None) -> float:
    """Lote pelo risco % da conta, limitado pelo 'lote_maximo' do ativo no config.json."""
    info, acc = mt5.symbol_info(sym), mt5.account_info()
    risk_money = acc.balance * (risk_pct if risk_pct is not None else CFG.get("risco_por_trade_pct", 1.0)) / 100
    loss_per_lot = loss_money(sym, entry, sl, 1.0)
    if loss_per_lot <= 0:
        return 0.0
    step = info.volume_step
    lots = math.floor(risk_money / loss_per_lot / step + 1e-9) * step
    cap = (CFG.get("lote_maximo") or {}).get(name or sym)
    if cap:
        lots = min(lots, cap)
    return round(min(max(lots, 0), info.volume_max), 8) if lots >= info.volume_min - 1e-9 else 0.0


def risk_budget(new_risk: float) -> str | None:
    """Trava da perda diária: perda já realizada hoje + risco de todas as posições abertas até o stop
    + risco da nova ordem não pode passar de 'perda_maxima_dia_pct'. Retorna o motivo do bloqueio, ou None."""
    limit = mt5.account_info().balance * CFG.get("perda_maxima_dia_pct", 2) / 100
    realized = max(0.0, -day_pnl())
    open_risk = 0.0
    for p in (mt5.positions_get() or []):
        if p.magic not in MAGICS or not p.sl:
            continue
        buy = p.type == mt5.POSITION_TYPE_BUY
        if (buy and p.sl < p.price_open) or (not buy and p.sl > p.price_open):
            open_risk += loss_money(p.symbol, p.price_open, p.sl, p.volume)
    total = realized + open_risk + new_risk
    acc = mt5.account_info()
    piso = CFG.get("saldo_inicial", 10000) * (1 - CFG.get("perda_maxima_total_pct", 6) / 100)
    if acc.equity - open_risk - new_risk < piso:
        return (f"bloqueada pela trava total: patrimônio {acc.equity:.0f} - risco aberto {open_risk:.0f} - esta {new_risk:.0f} "
                f"ficaria abaixo do piso US$ {piso:.0f}")
    if total > limit:
        return (f"bloqueada pela trava diária: perdido hoje {realized:.0f} + risco aberto {open_risk:.0f} + esta {new_risk:.0f} "
                f"= US$ {total:.0f} > limite US$ {limit:.0f}")
    return None


def target_for(c: dict) -> float:
    saida = CFG["filtro"].get("saida", "parcial")
    return {"tp05": c["entry"] + (0.5 * c["R"] if c["dir"] == "compra" else -0.5 * c["R"]),
            "tp1": c["tp1"], "tp2": c["tp2"], "tp3": c["tp3"], "parcial": c["tp2"]}[saida]


def open_trade(name: str, sym: str, c: dict) -> str:
    info = mt5.symbol_info(sym)
    tick = mt5.symbol_info_tick(sym)
    buy = c["dir"] == "compra"
    price = tick.ask if buy else tick.bid
    # mantém a mesma distância de SL/TP do plano, a partir do preço real de execução
    shift = price - c["entry"]
    sl, tp = c["sl"] + shift, target_for(c) + shift
    lots = lot_size(sym, price, sl, name=name)
    if lots <= 0:
        return "lote calculado abaixo do mínimo da corretora"
    bloqueio = risk_budget(loss_money(sym, price, sl, lots))
    if bloqueio:
        return bloqueio
    req = {
        "action": mt5.TRADE_ACTION_DEAL, "symbol": sym, "volume": lots,
        "type": mt5.ORDER_TYPE_BUY if buy else mt5.ORDER_TYPE_SELL, "price": price,
        "sl": round(sl, info.digits), "tp": round(tp, info.digits), "deviation": 20, "magic": MAGIC,
        "comment": ("AM " + c["name"][:10])[:31], "type_time": mt5.ORDER_TIME_GTC, "type_filling": mt5.ORDER_FILLING_IOC,
    }
    r = mt5.order_send(req)
    if r is None or r.retcode != mt5.TRADE_RETCODE_DONE:
        req["type_filling"] = mt5.ORDER_FILLING_FOK
        r = mt5.order_send(req)
    if r is None or r.retcode != mt5.TRADE_RETCODE_DONE:
        return f"recusada: {getattr(r, 'comment', mt5.last_error())}"
    return f"executada {lots} lotes a {r.price} (SL {req['sl']}, TP {req['tp']})"


def manage(st: dict) -> None:
    """Saída parcial: metade no TP1 e stop na entrada."""
    if CFG["filtro"].get("saida", "parcial") != "parcial":
        return
    for p in my_positions():
        if p.ticket in st["partial_done"]:
            continue
        r = abs(p.price_open - p.sl) if p.sl else 0
        if r <= 0:
            continue
        buy = p.type == mt5.POSITION_TYPE_BUY
        tp1 = p.price_open + r if buy else p.price_open - r
        tick = mt5.symbol_info_tick(p.symbol)
        now = tick.bid if buy else tick.ask
        if (buy and now >= tp1) or (not buy and now <= tp1):
            info = mt5.symbol_info(p.symbol)
            half = math.floor(p.volume / 2 / info.volume_step) * info.volume_step
            if half >= info.volume_min:
                mt5.order_send({"action": mt5.TRADE_ACTION_DEAL, "symbol": p.symbol, "volume": round(half, 8), "position": p.ticket,
                                "type": mt5.ORDER_TYPE_SELL if buy else mt5.ORDER_TYPE_BUY, "price": now, "deviation": 20,
                                "magic": MAGIC, "type_filling": mt5.ORDER_FILLING_IOC})
            mt5.order_send({"action": mt5.TRADE_ACTION_SLTP, "symbol": p.symbol, "position": p.ticket,
                            "sl": round(p.price_open, info.digits), "tp": p.tp})
            st["partial_done"].append(p.ticket)
            save_state(st)
            log.info("%s: TP1 atingido, metade realizada e stop na entrada", p.symbol)
            notify(f"{p.symbol}: TP1 atingido", "Metade realizada e stop movido para a entrada.", 3)


# ---------------------------------------------------------------- estratégia 2: RSI(2) nos índices
# Compra NAS100/US30 quando o índice cai forte (RSI de 2 períodos abaixo do limite) estando acima da média de 200 dias.
# Sai quando o fechamento diário passa acima da média de 5 dias, no stop (N x ATR diário) ou após "max_dias".
# Backtest MT5 (treino até 06/2025, teste depois): acerto 65-90%, positivo nos dois períodos, mas opera pouco.
def _rsi(c: list[float], n: int) -> list[float]:
    out, g, l = [math.nan] * len(c), 0.0, 0.0
    for i in range(1, len(c)):
        d = c[i] - c[i - 1]
        up, dn = max(d, 0), max(-d, 0)
        if i <= n:
            g += up / n
            l += dn / n
        else:
            g = (g * (n - 1) + up) / n
            l = (l * (n - 1) + dn) / n
        if i >= n:
            out[i] = 100.0 if l == 0 else 100 - 100 / (1 + g / l)
    return out


def _atr(rates, n: int) -> float:
    a = 0.0
    for i in range(1, len(rates)):
        h, lo, pc = float(rates[i]["high"]), float(rates[i]["low"]), float(rates[i - 1]["close"])
        tr = max(h - lo, abs(h - pc), abs(lo - pc))
        a = a + tr / n if i <= n else (a * (n - 1) + tr) / n
    return a


def close_position(p, motivo: str, tag: str = "RSI2") -> None:
    buy = p.type == mt5.POSITION_TYPE_BUY
    tick = mt5.symbol_info_tick(p.symbol)
    req = {"action": mt5.TRADE_ACTION_DEAL, "symbol": p.symbol, "volume": p.volume, "position": p.ticket,
           "type": mt5.ORDER_TYPE_SELL if buy else mt5.ORDER_TYPE_BUY, "price": tick.bid if buy else tick.ask,
           "deviation": 30, "magic": p.magic, "type_filling": mt5.ORDER_FILLING_IOC}
    r = mt5.order_send(req)
    if r is None or r.retcode != mt5.TRADE_RETCODE_DONE:
        req["type_filling"] = mt5.ORDER_FILLING_FOK
        r = mt5.order_send(req)
    ok = r is not None and r.retcode == mt5.TRADE_RETCODE_DONE
    log.info("%s %s: fechar (%s) -> %s", tag, p.symbol, motivo, "ok" if ok else getattr(r, "comment", mt5.last_error()))
    if ok:
        notify(f"SAÍDA {p.symbol} ({tag})", f"{motivo}\nResultado: {p.profit + p.swap:+.2f}", 4)


def scan_rsi2(st: dict, pode_operar: bool) -> None:
    cfg = CFG.get("rsi2_indices") or {}
    if not cfg.get("ativo"):
        return
    for name in cfg.get("ativos", ["NAS100", "US30"]):
        sym = resolve(name)
        if not sym:
            continue
        rates = mt5.copy_rates_from_pos(sym, mt5.TIMEFRAME_D1, 1, 400)  # só dias fechados
        if rates is None or len(rates) < 210:
            log.warning("RSI2 %s: poucas velas diárias", name)
            continue
        c = [float(r["close"]) for r in rates]
        rsi2, sma200, sma5 = _rsi(c, 2), sum(c[-200:]) / 200, sum(c[-5:]) / 5
        day = int(rates[-1]["time"])
        # saída das posições abertas desta estratégia (o stop fica na corretora)
        for p in my_positions(sym, MAGIC_RSI2):
            dias = sum(1 for r in rates if int(r["time"]) >= p.time - 86400)
            if c[-1] > sma5:
                close_position(p, "fechou acima da média de 5 dias (alvo)")
            elif dias >= cfg.get("max_dias", 10):
                close_position(p, f"tempo máximo de {cfg.get('max_dias', 10)} dias")
        # entrada
        if not (c[-1] > sma200 and rsi2[-1] < cfg.get("rsi_limite", 10)):
            continue
        key = f"RSI2:{name}:{day}"
        if key in st["alerted"]:
            continue
        st["alerted"][key] = time.time()
        save_state(st)
        info, tick = mt5.symbol_info(sym), mt5.symbol_info_tick(sym)
        price = tick.ask
        sl = round(price - cfg.get("stop_atr", 3) * _atr(rates, 14), info.digits)
        resultado = "só alerta"
        if pode_operar:
            if my_positions(sym, MAGIC_RSI2):
                resultado = "já existe posição RSI2 neste ativo"
            elif day_pnl() <= -mt5.account_info().balance * CFG.get("perda_maxima_dia_pct", 3) / 100:
                resultado = "perda máxima do dia atingida"
            else:
                lots = lot_size(sym, price, sl, cfg.get("risco_pct", 1.0), name=name)
                # o lote mínimo dos índices (0,1) costuma arriscar mais que o %: aceita até 'risco_maximo_lote_minimo_usd'
                if lots <= 0 and loss_money(sym, price, sl, info.volume_min) <= cfg.get("risco_maximo_lote_minimo_usd", 0):
                    lots = info.volume_min
                bloqueio = risk_budget(loss_money(sym, price, sl, lots)) if lots > 0 else None
                if lots <= 0:
                    resultado = "lote abaixo do mínimo"
                elif bloqueio:
                    resultado = bloqueio
                else:
                    req = {"action": mt5.TRADE_ACTION_DEAL, "symbol": sym, "volume": lots, "type": mt5.ORDER_TYPE_BUY, "price": price,
                           "sl": sl, "deviation": 30, "magic": MAGIC_RSI2, "comment": "AM RSI2", "type_time": mt5.ORDER_TIME_GTC,
                           "type_filling": mt5.ORDER_FILLING_IOC}
                    r = mt5.order_send(req)
                    if r is None or r.retcode != mt5.TRADE_RETCODE_DONE:
                        req["type_filling"] = mt5.ORDER_FILLING_FOK
                        r = mt5.order_send(req)
                    resultado = (f"executada {lots} lotes a {r.price} (SL {sl})" if r is not None and r.retcode == mt5.TRADE_RETCODE_DONE
                                 else f"recusada: {getattr(r, 'comment', mt5.last_error())}")
        log.info("SINAL %s: RSI2 %.1f, preço %.5g > média 200 %.5g -> %s", key, rsi2[-1], c[-1], sma200, resultado)
        if resultado.startswith("recusada"):
            # ex.: mercado fechado (fim de semana / pausa diária): tenta de novo no próximo ciclo, sem notificar
            st["alerted"].pop(key, None)
            save_state(st)
            continue
        notify(f"ENTRADA COMPRA {name} (RSI2)", f"Queda forte em tendência de alta.\nRSI(2) {rsi2[-1]:.1f} · SL {sl}\n"
               f"Saída: quando fechar acima da média de 5 dias.\n\nOrdem: {resultado}", 5)


# ---------------------------------------------------------------- estratégia 3: IBS (Internal Bar Strength)
# Se o dia anterior fechou perto da mínima (IBS = (fech - mín) / (máx - mín) < 0,3), compra na abertura do dia
# e fecha no fim do MESMO dia (sem swap). Stop de 1,5x ATR diário. Lote mínimo fixo.
# Backtest MT5 (scripts/lab2.js, parâmetros do treino): teste 07/2025-11/2026 = 220 trades, acerto 56%,
# +0,08R/trade, PF 1,56, ~US$ 4,6/dia no lote mínimo, pior queda ~US$ 700. Positivo em NAS100, US30 e XAUUSD.
def server_now(sym: str) -> datetime | None:
    tick = mt5.symbol_info_tick(sym)
    return datetime.fromtimestamp(tick.time, timezone.utc) if tick and tick.time else None  # relógio do servidor


def _hhmm(s: str) -> tuple[int, int]:
    h, m = s.split(":")
    return int(h), int(m)


def ibs_close_time(cfg: dict, name: str) -> tuple[int, int]:
    return _hhmm((cfg.get("fechar_hora_servidor") or {}).get(name) or (cfg.get("fechar_hora_servidor") or {}).get("padrao", "23:40"))


def manage_ibs() -> None:
    """Fecha as posições IBS no fim do dia de entrada (ou já, se o fechamento foi perdido)."""
    cfg = CFG.get("ibs") or {}
    names = {resolve(n): n for n in cfg.get("ativos", [])}
    for p in my_positions(magic=MAGIC_IBS):
        now = server_now(p.symbol)
        if not now:
            continue
        aberta = datetime.fromtimestamp(p.time, timezone.utc)  # p.time também vem no relógio do servidor
        h, m = ibs_close_time(cfg, names.get(p.symbol, p.symbol))
        if now.date() > aberta.date() or (now.hour, now.minute) >= (h, m):
            close_position(p, "fim do dia (saída da IBS)", "IBS")


def scan_ibs(st: dict, pode_operar: bool) -> None:
    cfg = CFG.get("ibs") or {}
    if not cfg.get("ativo"):
        return
    for name in cfg.get("ativos", []):
        sym = resolve(name)
        if not sym:
            continue
        rates = mt5.copy_rates_from_pos(sym, mt5.TIMEFRAME_D1, 0, 30)  # inclui o dia atual (índice -1)
        now = server_now(sym)
        if rates is None or len(rates) < 20 or not now:
            continue
        hoje, ontem = rates[-1], rates[-2]
        if datetime.fromtimestamp(int(hoje["time"]), timezone.utc).date() != now.date():
            continue  # o dia de hoje ainda não abriu neste ativo
        rng = float(ontem["high"]) - float(ontem["low"])
        ibs = (float(ontem["close"]) - float(ontem["low"])) / rng if rng > 0 else 0.5
        if ibs >= cfg.get("ibs_limite", 0.3):
            continue
        key = f"IBS:{name}:{int(hoje['time'])}"
        if key in st["alerted"]:
            continue
        # entra só no começo do dia, como no backtest (a abertura); depois disso, perdeu o sinal de hoje
        abertura = datetime.fromtimestamp(int(hoje["time"]), timezone.utc)
        if now - abertura > timedelta(hours=cfg.get("janela_entrada_horas", 3)):
            continue
        ch, cm = ibs_close_time(cfg, name)
        if (now.hour, now.minute) >= (ch, cm):
            continue
        info, tick = mt5.symbol_info(sym), mt5.symbol_info_tick(sym)
        spread = tick.ask - tick.bid
        max_spread = (cfg.get("spread_maximo") or {}).get(name)
        if max_spread and spread > max_spread:
            log.info("IBS %s: spread %.5g acima de %.5g, aguardando", name, spread, max_spread)
            continue  # tenta no próximo ciclo
        price = tick.ask
        sl = round(price - cfg.get("stop_atr", 1.5) * _atr(rates[:-1], 14), info.digits)
        lots = (cfg.get("lote") or {}).get(name) or info.volume_min
        risco = loss_money(sym, price, sl, lots)
        resultado = "só alerta"
        if pode_operar:
            if my_positions(sym, MAGIC_IBS):
                resultado = "já existe posição IBS neste ativo"
            elif risco > cfg.get("risco_maximo_usd", 200):
                resultado = f"risco US$ {risco:.0f} acima do máximo US$ {cfg.get('risco_maximo_usd', 200)}"
            else:
                resultado = risk_budget(risco) or send_market(sym, lots, price, sl, MAGIC_IBS, "AM IBS")
        log.info("SINAL %s: IBS ontem %.2f, risco US$ %.0f -> %s", key, ibs, risco, resultado)
        if resultado.startswith("recusada"):
            continue  # ex.: mercado ainda fechado: tenta de novo no próximo ciclo
        st["alerted"][key] = time.time()
        save_state(st)
        notify(f"ENTRADA COMPRA {name} (IBS)", f"Ontem fechou perto da mínima (IBS {ibs:.2f}).\nSL {sl} · risco US$ {risco:.0f}\n"
               f"Saída: fim do dia ({ch:02d}:{cm:02d} servidor).\n\nOrdem: {resultado}", 4)


def send_market(sym: str, lots: float, price: float, sl: float, magic: int, comment: str) -> str:
    req = {"action": mt5.TRADE_ACTION_DEAL, "symbol": sym, "volume": lots, "type": mt5.ORDER_TYPE_BUY, "price": price,
           "sl": sl, "deviation": 30, "magic": magic, "comment": comment, "type_time": mt5.ORDER_TIME_GTC,
           "type_filling": mt5.ORDER_FILLING_IOC}
    r = mt5.order_send(req)
    if r is None or r.retcode != mt5.TRADE_RETCODE_DONE:
        req["type_filling"] = mt5.ORDER_FILLING_FOK
        r = mt5.order_send(req)
    if r is not None and r.retcode == mt5.TRADE_RETCODE_DONE:
        return f"executada {lots} lotes a {r.price} (SL {sl})"
    return f"recusada: {getattr(r, 'comment', mt5.last_error())}"


# ---------------------------------------------------------------- ciclo
def scan(st: dict) -> None:
    offset = server_offset()
    now = time.time()
    modo = CFG.get("modo", "alerta")
    pode_operar = modo == "demo" and (is_demo() or CFG.get("permitir_conta_real") is True)
    if modo == "demo" and not pode_operar:
        log.warning("Conta REAL detectada: robô em modo só alerta (permitir_conta_real = false).")
    if pode_operar and not mt5.terminal_info().trade_allowed:
        log.warning("Algo Trading DESLIGADO no MT5: as ordens serão recusadas.")
        if time.time() - st.get("aviso_algo", 0) > 3600:
            st["aviso_algo"] = time.time()
            save_state(st)
            notify("⚠ Algo Trading desligado no MT5", "O robô não consegue abrir ordens. Clique no botão 'Algo Trading' do MT5 (fica verde).", 5)
    for name in CFG["ativos"]:
        sym = resolve(name)
        if not sym:
            log.warning("%s: símbolo não encontrado na corretora (ajuste 'simbolos' no config.json)", name)
            continue
        try:
            data = {tf: candles(sym, tf, offset) for tf in TF}
        except Exception as e:
            log.warning("%s: %s", name, e)
            continue
        res = analyze(name, data, now)
        if not res.get("ok"):
            log.warning("%s: erro na análise: %s", name, res.get("error"))
            continue
        c = next((x for x in res["candidates"] if passes(x, res)), None)
        b = res.get("best") or {}
        log.info("%s %.5g | D1 %s H4 %s | %s %s score %s", name, res["price"], res["bias"]["D1"], res["bias"]["H4"],
                 b.get("status", "SEM SETUP"), b.get("dir", ""), b.get("score", 0))
        if not c:
            continue
        key = f"{name}:{c['name']}:{c['dir']}:{int(data['M15'][-1]['t'])}"
        if key in st["alerted"]:
            continue
        st["alerted"][key] = now
        st["alerted"] = {k: v for k, v in st["alerted"].items() if now - v < 3 * 86400}
        save_state(st)
        d = c["dir"].upper()
        texto = (f"{d} {name} @ {c['entry']:.5g}\nSL {c['sl']:.5g} | TP1 {c['tp1']:.5g} | TP2 {c['tp2']:.5g}\n"
                 f"Score {c['score']} · {c['name']}\n" + "\n".join("✓ " + x for x in c["confirmations"][:4]))
        resultado = "só alerta"
        if pode_operar:
            if my_positions(sym):
                resultado = "já existe posição neste ativo"
            elif len(my_positions()) >= CFG.get("max_posicoes", 3):
                resultado = "limite de posições abertas"
            elif day_pnl() <= -mt5.account_info().balance * CFG.get("perda_maxima_dia_pct", 3) / 100:
                resultado = "perda máxima do dia atingida — sem novas ordens hoje"
            else:
                resultado = open_trade(name, sym, c)
        log.info("SINAL %s: %s", key, resultado)
        notify(f"ENTRADA {d} {name} (score {c['score']})", texto + f"\n\nOrdem: {resultado}", 5)
    try:
        scan_rsi2(st, pode_operar)
    except Exception as e:
        log.exception("RSI2: %s", e)
    try:
        scan_ibs(st, pode_operar)
    except Exception as e:
        log.exception("IBS: %s", e)


def start_feed() -> None:
    """Liga a ponte de preços para o site (bot/mt5_feed.py). Se já estiver rodando, a nova cópia sai sozinha."""
    try:
        subprocess.Popen([sys.executable, str(BOT / "mt5_feed.py")], cwd=str(BOT), stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        log.info("Ponte de preços para o site: http://127.0.0.1:8765")
    except Exception as e:
        log.warning("Ponte de preços não iniciou: %s", e)


def main() -> None:
    connect()
    start_feed()
    st = load_state()
    notify("Robô iniciado", f"Modo {CFG.get('modo')} · {len(CFG['ativos'])} ativos · conta {'DEMO' if is_demo() else 'REAL'}", 2)
    last_bar = None
    while True:
        try:
            if not mt5.terminal_info():
                log.warning("MT5 desconectado, reconectando...")
                mt5.shutdown(); time.sleep(5); connect()
            manage(st)
            manage_ibs()
            bar = int(time.time() // 900)
            # roda 20 s depois do fechamento de cada vela de 15 min
            if bar != last_bar and time.time() - bar * 900 >= 20:
                last_bar = bar
                scan(st)
        except Exception as e:
            log.exception("Erro no ciclo: %s", e)
        time.sleep(10)


if __name__ == "__main__":
    main()
