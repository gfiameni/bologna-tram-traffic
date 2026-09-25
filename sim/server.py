"""Optional exact-slider server. The page also works from catalog.json alone."""

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from sim.device import describe
from sim.models import run
from sim.supply import load
from sim.surrogate import load_weights

PORT = 8765


def main():
    corridor = load()
    weights_path = __import__("pathlib").Path(__file__).resolve().parents[1] / "data" / "surrogate.json"
    if weights_path.exists():
        load_weights(json.loads(weights_path.read_text()))
    device = describe()

    class Handler(BaseHTTPRequestHandler):
        def _send(self, code, payload):
            body = json.dumps(payload).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_OPTIONS(self):
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
            self.end_headers()

        def do_GET(self):
            self._send(200, {"ok": True, "device": device})

        def do_POST(self):
            length = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(length) or b"{}")
            model = body.get("model", "ctm")
            shift = float(body.get("shift", 0.25))
            headway = float(body.get("headway", 4.5))
            hour = int(body.get("hour", 8))
            try:
                before = run(model, corridor, "before", shift, headway, use_warp=device["cuda"], hour=hour)
                after = run(model, corridor, "after", shift, headway, use_warp=device["cuda"], hour=hour)
            except KeyError:
                self._send(400, {"error": "unknown model"})
                return
            self._send(200, {
                "before": before,
                "after": after,
                "device": device["device"],
                "cuda": device["cuda"],
            })

        def log_message(self, fmt, *args):
            return

    print(f"model server on http://127.0.0.1:{PORT} ({device['device']})")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
