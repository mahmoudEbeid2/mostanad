"""label-resizer service: the label resize that keeps the original design (resizer.py).

  GET  /health
  POST /v1/describe { pdf (base64), page? }                       → { pageMm, pages, blocks, png (base64) }
  POST /v1/resize   { pdf, page?, sizes: [{ widthMm, heightMm }], minFontPt?, mode? (auto | scale | smart),
                      bleedMm?, cropMarks?, overrides? }           → { results: [{ widthMm, heightMm, fit, mode, pdf, png, report }] }

One request at a time (MuPDF is not thread-safe across threads); the API queues behind it.
Optional shared token: RESIZER_TOKEN, sent as x-resizer-token.
"""

import base64
import json
import os
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import resizer

LOCK = threading.Lock()
TOKEN = os.environ.get("RESIZER_TOKEN") or ""
MAX_BODY = 160 * 1024 * 1024


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, status, body):
        data = json.dumps(body).encode("utf8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *args):  # one line per request, no bodies
        print(f"[label-resizer] {self.address_string()} {fmt % args}", flush=True)

    def do_GET(self):
        if self.path == "/health":
            return self._send(200, {"ok": True, "engine": "pymupdf"})
        self._send(404, {"error": "not found"})

    def do_POST(self):
        if TOKEN and self.headers.get("x-resizer-token") != TOKEN:
            return self._send(401, {"error": "bad token"})
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY:
            return self._send(413, {"error": "body too large or empty"})
        try:
            body = json.loads(self.rfile.read(length))
            pdf = base64.b64decode(body["pdf"])
            page = int(body.get("page") or 0)
            with LOCK:
                if self.path == "/v1/describe":
                    out = resizer.describe(pdf, page)
                    png, info = resizer.preview_original(pdf, page)
                    out.update({"png": base64.b64encode(png).decode(), "original": info})
                    return self._send(200, out)
                if self.path == "/v1/resize":
                    results = []
                    for size in body.get("sizes") or []:
                        r = resizer.resize(
                            pdf,
                            float(size["widthMm"]),
                            float(size["heightMm"]),
                            page=page,
                            min_font_pt=float(body.get("minFontPt") or 6),
                            mode=body.get("mode") or "auto",
                            bleed_mm=float(body.get("bleedMm") or 0),
                            crop_marks=bool(body.get("cropMarks")),
                            overrides=body.get("overrides") or {},
                        )
                        results.append({
                            "widthMm": size["widthMm"],
                            "heightMm": size["heightMm"],
                            "fit": r["fit"],
                            "mode": r["mode"],
                            "pdf": base64.b64encode(r["pdf"]).decode() if r["pdf"] else None,
                            "png": base64.b64encode(r["png"]).decode(),
                            "report": r["report"],
                        })
                    return self._send(200, {"results": results})
            self._send(404, {"error": "not found"})
        except (KeyError, ValueError) as err:
            self._send(400, {"error": str(err)})
        except Exception as err:  # a file MuPDF can't read, a broken font…: the caller gets the reason
            traceback.print_exc()
            self._send(422, {"error": f"{type(err).__name__}: {err}"})


if __name__ == "__main__":
    port = int(os.environ.get("PORT") or 5080)
    print(f"[label-resizer] listening on {port}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
