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
MAGIC = 260611
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
def my_positions(sym: str | None = None):
    pos = mt5.positions_get(symbol=sym) if sym else mt5.positions_get()
    return [p for p in (pos or []) if p.magic == MAGIC]


def day_pnl() -> float:
    start = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    deals = mt5.history_deals_get(start, datetime.now(timezone.utc) + timedelta(days=1)) or ()
    return sum(d.profit + d.commission + d.swap for d in deals if d.magic == MAGIC)


def lot_size(sym: str, entry: float, sl: float) -> float:
    info, acc = mt5.symbol_info(sym), mt5.account_info()
    risk_money = acc.balance * CFG.get("risco_por_trade_pct", 1.0) / 100
    loss_per_lot = abs(entry - sl) / info.trade_tick_size * info.trade_tick_value
    if loss_per_lot <= 0:
        return 0.0
    step = info.volume_step
    lots = math.floor(risk_money / loss_per_lot / step) * step
    return round(min(max(lots, 0), info.volume_max), 8) if lots >= info.volume_min else 0.0


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
    lots = lot_size(sym, price, sl)
    if lots <= 0:
        return "lote calculado abaixo do mínimo da corretora"
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


# ---------------------------------------------------------------- ciclo
def scan(st: dict) -> None:
    offset = server_offset()
    now = time.time()
    modo = CFG.get("modo", "alerta")
    pode_operar = modo == "demo" and (is_demo() or CFG.get("permitir_conta_real") is True)
    if modo == "demo" and not pode_operar:
        log.warning("Conta REAL detectada: robô em modo só alerta (permitir_conta_real = false).")
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


def main() -> None:
    connect()
    st = load_state()
    notify("Robô iniciado", f"Modo {CFG.get('modo')} · {len(CFG['ativos'])} ativos · conta {'DEMO' if is_demo() else 'REAL'}", 2)
    last_bar = None
    while True:
        try:
            if not mt5.terminal_info():
                log.warning("MT5 desconectado, reconectando...")
                mt5.shutdown(); time.sleep(5); connect()
            manage(st)
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
