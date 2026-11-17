"""
Ponte de preços MT5 -> site (só no seu computador, endereço 127.0.0.1:8765).

O site (GitHub Pages) busca aqui as velas M15/H1/D1 de cada ativo, direto do seu MT5:
  - sem o limite de 8 consultas por minuto da Twelve Data (a varredura fica instantânea);
  - com os preços da sua corretora, incluindo os índices reais (NAS100/US30) em vez dos ETFs.
Se esta ponte estiver desligada, o site volta sozinho para a Twelve Data.

O robô (mt5_bot.py) inicia esta ponte automaticamente. Para rodar sozinha:  python bot/mt5_feed.py
"""
from __future__ import annotations

import json
import mimetypes
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

import MetaTrader5 as mt5

from mt5_bot import TF, candles, resolve, server_offset

HOST, PORT = "127.0.0.1", 8765
SITE = Path(__file__).resolve().parent.parent  # pasta do site (index.html, css/, js/)
SITE_DIRS = ("css", "js")
_offset = {"v": None, "t": 0.0}


def offset():
    if _offset["v"] is None or time.time() - _offset["t"] > 600:
        _offset["v"], _offset["t"] = server_offset(), time.time()
    return _offset["v"]


class Handler(BaseHTTPRequestHandler):
    def _send(self, code: int, body: dict) -> None:
        raw = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_OPTIONS(self):  # pré-verificação do navegador (acesso à rede local)
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.end_headers()

    def _static(self, path: str) -> bool:
        """Serve o próprio site (index.html, css/, js/). Aberto em http://127.0.0.1:8765 o site fala com a
        ponte sem precisar da permissão de "rede local" do Chrome."""
        rel = unquote(path).lstrip("/") or "index.html"
        parts = rel.split("/")
        if not (rel == "index.html" or (len(parts) == 2 and parts[0] in SITE_DIRS)) or ".." in parts:
            return False
        f = SITE / rel
        if not f.is_file():
            return False
        raw = f.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", (mimetypes.guess_type(f.name)[0] or "application/octet-stream") + "; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)
        return True

    def do_GET(self):
        u = urlparse(self.path)
        if u.path != "/candles" and u.path != "/ping" and self._static(u.path):
            return
        if u.path == "/ping":
            return self._send(200, {"ok": True})
        if u.path != "/candles":
            return self._send(404, {"ok": False, "error": "caminho desconhecido"})
        name = (parse_qs(u.query).get("asset") or [""])[0].upper()
        try:
            if not mt5.terminal_info() and not mt5.initialize():
                return self._send(503, {"ok": False, "error": "MT5 fechado"})
            sym = resolve(name)
            if not sym:
                return self._send(404, {"ok": False, "error": f"{name} não existe na corretora"})
            off = offset()
            data = {tf: candles(sym, tf, off) for tf in TF}
            self._send(200, {"ok": True, "asset": name, "symbol": sym, "data": data})
        except Exception as e:
            self._send(500, {"ok": False, "error": str(e)})

    def log_message(self, *a):  # silencioso
        pass


def main() -> None:
    if not mt5.initialize():
        raise SystemExit(f"Não conectou ao MT5: {mt5.last_error()}")
    try:
        srv = HTTPServer((HOST, PORT), Handler)
    except OSError:
        raise SystemExit(f"Ponte já está rodando em {HOST}:{PORT}")
    print(f"Ponte de preços MT5 em http://{HOST}:{PORT}  (abra este endereço no navegador para o site rápido)")
    srv.serve_forever()


if __name__ == "__main__":
    main()
