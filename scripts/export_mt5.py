"""Exporta histórico do MT5 para o backtest: .bt-data-mt5/<ATIVO>.json com M15, H1 e D1 em UTC.
Uso: python scripts/export_mt5.py [anos]   (padrão 3 anos; o MT5 precisa estar aberto e logado)"""
import json
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import MetaTrader5 as mt5

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / ".bt-data-mt5"
CFG = json.loads((ROOT / "bot" / "config.json").read_text(encoding="utf-8"))
YEARS = float(sys.argv[1]) if len(sys.argv) > 1 else 3
TFS = {"M15": mt5.TIMEFRAME_M15, "H1": mt5.TIMEFRAME_H1, "D1": mt5.TIMEFRAME_D1}

if not mt5.initialize():
    sys.exit(f"MT5 não conectado: {mt5.last_error()}")

# diferença do horário do servidor para UTC (pelo último tick)
ticks = [t.time for t in (mt5.symbol_info_tick(s) for s in ("EURUSD", "XAUUSD")) if t]
offset = round((max(ticks) - time.time()) / 3600) * 3600 if ticks else 0
print(f"Servidor agora: UTC{offset / 3600:+.0f}h")


def us_dst(ts: int) -> bool:
    """Horário de verão dos EUA: 2º domingo de março até 1º domingo de novembro."""
    d = datetime.fromtimestamp(ts, timezone.utc)
    def nth_sunday(month, n):
        first = datetime(d.year, month, 1, tzinfo=timezone.utc)
        return first + timedelta(days=(6 - first.weekday()) % 7 + 7 * (n - 1))
    return nth_sunday(3, 2) <= d < nth_sunday(11, 1)


# servidores "fechamento de NY" (UTC+2 inverno / UTC+3 verão) seguem o horário de verão americano
NY_CLOSE = offset in (7200, 10800)


def to_utc(ts: int) -> int:
    if NY_CLOSE:
        return ts - (10800 if us_dst(ts - 7200) else 7200)
    return ts - offset

OUT.mkdir(exist_ok=True)
for name in CFG["ativos"]:
    sym = CFG.get("simbolos", {}).get(name, name)
    if not mt5.symbol_select(sym, True):
        print(f"{name}: símbolo {sym} não encontrado")
        continue
    out = {}
    for tf, code in TFS.items():
        # copy_rates_range recusa intervalos longos; lemos as últimas N velas (limite "max bars" do terminal = 100 mil)
        n = {"M15": min(int(YEARS * 26000), 90000), "H1": min(int((YEARS + 0.3) * 6300), 90000), "D1": int((YEARS + 2) * 320)}[tf]
        rates = None
        for _ in range(5):
            rates = mt5.copy_rates_from_pos(sym, code, 1, n)
            if rates is not None and len(rates) > 0:
                break
            time.sleep(2)
        if rates is None or len(rates) == 0:
            print(f"{name} {tf}: sem dados ({mt5.last_error()})")
            break
        bars = [{"t": to_utc(int(r["time"])), "o": float(r["open"]), "h": float(r["high"]), "l": float(r["low"]), "c": float(r["close"])} for r in rates]
        sec = {"M15": 900, "H1": 3600, "D1": 86400}[tf]
        bars = [b for b in bars if b["t"] + sec <= time.time()]  # só velas fechadas
        out[tf] = bars
    if len(out) == 3:
        sp = sorted(int(r["spread"]) for r in mt5.copy_rates_from_pos(sym, mt5.TIMEFRAME_M15, 1, 20000))
        out["spread"] = sp[len(sp) // 2] * mt5.symbol_info(sym).point  # spread mediano, em preço
        (OUT / f"{name}.json").write_text(json.dumps(out), encoding="utf-8")
        d0 = datetime.fromtimestamp(out["M15"][0]["t"], timezone.utc).date()
        print(f"{name} ({sym}): M15 {len(out['M15'])} velas desde {d0}, H1 {len(out['H1'])}, D1 {len(out['D1'])}, spread {out['spread']:.5g}")
mt5.shutdown()
