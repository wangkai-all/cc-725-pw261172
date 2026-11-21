"""纯标准库 HTTP 服务：页面 + 报告 API。

接口：
  GET  /                 网页（web/index.html）
  GET  /api/report       完整分析报告（默认价格）
  POST /api/report       给定三项线性价格后重算费用范围
  POST /api/regenerate   重新生成本地数据并重建报告（可调样本量/漂移开关）
"""

from __future__ import annotations

import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from data_generation import GenerationConfig, generate
from analysis import run

ROOT = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(ROOT, "web")
DATA_DIR = os.path.join(ROOT, "data")

_state_lock = threading.Lock()
_state: dict = {"report": None, "raw": None, "cfg": None}


def build(cfg: GenerationConfig, prices) -> None:
    raw = generate(cfg)
    report = run(raw, prices=prices)
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(os.path.join(DATA_DIR, "raw_batches.json"), "w",
              encoding="utf-8") as f:
        json.dump(raw, f, ensure_ascii=False, indent=1)
    with open(os.path.join(DATA_DIR, "report.json"), "w",
              encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=1, allow_nan=False)
    with _state_lock:
        _state["raw"], _state["report"], _state["cfg"] = raw, report, cfg


def recompute_prices(prices) -> dict:
    with _state_lock:
        raw = _state["raw"]
    return run(raw, prices=prices)


class Handler(BaseHTTPRequestHandler):
    def _send_json(self, obj, status=200) -> None:
        body = json.dumps(obj, ensure_ascii=False, allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_file(self, rel, ctype) -> None:
        path = os.path.normpath(os.path.join(WEB, rel))
        if not path.startswith(WEB) or not os.path.isfile(path):
            self.send_error(404)
            return
        with open(path, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path in ("/", "/index.html"):
            self._send_file("index.html", "text/html; charset=utf-8")
        elif self.path == "/api/report":
            with _state_lock:
                self._send_json(_state["report"])
        elif self.path.startswith("/web/"):
            rel = self.path[len("/web/"):]
            ctype = ("text/css; charset=utf-8" if rel.endswith(".css")
                     else "application/javascript; charset=utf-8")
            self._send_file(rel, ctype)
        else:
            self.send_error(404)

    def do_POST(self) -> None:
        try:
            length = int(self.headers.get("Content-Length", 0))
            payload = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, json.JSONDecodeError):
            self._send_json({"error": "请求体不是合法 JSON"}, 400)
            return

        if self.path == "/api/report":
            prices = payload.get("prices")
            if (not isinstance(prices, list) or len(prices) != 3
                    or not all(isinstance(v, (int, float)) and v >= 0
                               for v in prices)):
                self._send_json(
                    {"error": "prices 必须是 3 个非负数字 [电价, 蒸汽价, 冷却水价]"},
                    400)
                return
            self._send_json(recompute_prices(prices))
        elif self.path == "/api/regenerate":
            try:
                cfg = GenerationConfig(
                    n_train=int(payload.get("n_train", 45)),
                    n_calibrate=int(payload.get("n_calibrate", 25)),
                    n_check=int(payload.get("n_check", 30)),
                    seed=int(payload.get("seed", 20261122)),
                    drift=bool(payload.get("drift", True)))
                if min(cfg.n_train, cfg.n_calibrate, cfg.n_check) < 3:
                    raise ValueError("每部分至少 3 个批次")
            except (TypeError, ValueError) as exc:
                self._send_json({"error": f"参数不合法: {exc}"}, 400)
                return
            prices = payload.get("prices", [0.80, 220.0, 0.30])
            build(cfg, prices)
            with _state_lock:
                self._send_json(_state["report"])
        else:
            self.send_error(404)

    def log_message(self, fmt, *args) -> None:  # 简洁日志
        print(f"[server] {self.address_string()} {fmt % args}")


def main() -> None:
    import argparse
    ap = argparse.ArgumentParser(description="批次能耗联合预测 Web 服务")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8765)
    args = ap.parse_args()

    build(GenerationConfig(), prices=(0.80, 220.0, 0.30))
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"服务已启动: http://{args.host}:{args.port}/")
    print("按 Ctrl+C 停止。")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")


if __name__ == "__main__":
    main()
