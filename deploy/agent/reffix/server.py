"""reffix as a service for the Genie Agent Gateway.

POST /fix {"bib": "<BibTeX>", "replace_arxiv": true} -> {"fixed": "<BibTeX>", "log": [...]}
runs `reffix in.bib -o out.bib [-a]` (https://github.com/kasnerz/reffix, MIT):
DBLP lookups that complete entries, protect capitalisation and, with -a,
prefer published versions over arXiv preprints. Keys are kept. One run at a
time, so DBLP sees a single polite client; internal network only.
"""
import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("REFFIX_PORT", "8000"))
TIMEOUT = int(os.environ.get("REFFIX_TIMEOUT", "300"))
MAX_BYTES = 1_000_000
ANSI = re.compile(r"\x1b\[[0-9;]*m")
LOCK = threading.Lock()
REFFIX = shutil.which("reffix") or "reffix"


def run(bib: str, replace_arxiv: bool) -> dict:
    with LOCK, tempfile.TemporaryDirectory() as tmp:
        src, out = os.path.join(tmp, "in.bib"), os.path.join(tmp, "out.bib")
        with open(src, "w", encoding="utf-8") as f:
            f.write(bib)
        args = [REFFIX, src, "-o", out] + (["-a"] if replace_arxiv else [])
        env = {**os.environ, "NO_COLOR": "1", "ANSI_COLORS_DISABLED": "1"}
        proc = subprocess.run(args, cwd=tmp, env=env, capture_output=True, text=True, timeout=TIMEOUT)
        log = [ANSI.sub("", l).rstrip() for l in (proc.stdout + proc.stderr).splitlines()]
        log = [l for l in log if l.startswith("[") and not l.startswith("[INFO]")]
        if proc.returncode != 0 or not os.path.exists(out):
            return {"error": f"reffix exited with {proc.returncode}", "log": log[-40:]}
        with open(out, encoding="utf-8") as f:
            return {"fixed": f.read(), "log": log[-200:]}


class Handler(BaseHTTPRequestHandler):
    def _send(self, code: int, body: dict):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self._send(200 if self.path == "/health" else 404, {"ok": self.path == "/health"})

    def do_POST(self):
        if self.path != "/fix":
            return self._send(404, {"error": "not found"})
        n = int(self.headers.get("content-length") or 0)
        if n <= 0 or n > MAX_BYTES:
            return self._send(413, {"error": f"send 1 byte to {MAX_BYTES} bytes of JSON"})
        try:
            body = json.loads(self.rfile.read(n))
            bib = body["bib"]
            if not isinstance(bib, str) or not bib.strip():
                raise ValueError
        except Exception:
            return self._send(400, {"error": 'expected {"bib": "<BibTeX>"}'})
        try:
            self._send(200, run(bib, bool(body.get("replace_arxiv", True))))
        except subprocess.TimeoutExpired:
            self._send(504, {"error": f"reffix took longer than {TIMEOUT} s (DBLP is slow or rate-limiting); check fewer entries"})

    def log_message(self, fmt, *args):  # one line per request, no bodies
        print(f"[reffix] {self.command} {self.path} {args[1] if len(args) > 1 else ''}", flush=True)


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
