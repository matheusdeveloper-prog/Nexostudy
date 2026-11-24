
#!/usr/bin/env python3
import json
import os
import time
import urllib.request
import urllib.error
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path

BASE = Path(__file__).resolve().parent
SITE = BASE / "nexo-paper-edition.html"
HOST = "127.0.0.1"
PORT = 8000
MODEL = os.environ.get("NEXO_OLLAMA_MODEL", "llama3.2:3b")
RATE = {}

def allowed(ip, limit=12, window=60):
    now = time.time()
    hits = [t for t in RATE.get(ip, []) if now - t < window]
    if len(hits) >= limit:
        RATE[ip] = hits
        return False
    hits.append(now)
    RATE[ip] = hits
    return True

class Handler(BaseHTTPRequestHandler):
    server_version = "NEXO-Demo/1.0"

    def send_json(self, status, payload):
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def read_body(self, max_size=26000):
        try:
            size = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            size = -1
        if size < 0 or size > max_size:
            return None
        raw = self.rfile.read(size)
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return None

    def do_GET(self):
        if self.path in ("/", "/index.html", "/nexo-paper-edition.html"):
            try:
                raw = SITE.read_bytes()
            except OSError:
                self.send_error(500, "Arquivo HTML da NEXO não encontrado.")
                return
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
            return

        if self.path == "/api/health":
            self.send_json(200, {"ok": True, "app": "NEXO", "model": MODEL})
            return
        self.send_error(404)

    def do_POST(self):
        ip = self.client_address[0]
        if self.path == "/api/chat":
            if not allowed(ip, limit=12):
                self.send_json(429, {"error": "Limite temporário de mensagens atingido. Aguarde um minuto."})
                return

            body = self.read_body()
            if not isinstance(body, dict) or not isinstance(body.get("messages"), list):
                self.send_json(400, {"error": "Formato de conversa inválido."})
                return

            payload = {"model": MODEL, "messages": body["messages"][-14:], "stream": False}
            data = json.dumps(payload).encode("utf-8")
            req = urllib.request.Request(
                "http://127.0.0.1:11434/api/chat",
                data=data,
                headers={"Content-Type": "application/json"},
                method="POST"
            )
            try:
                with urllib.request.urlopen(req, timeout=180) as upstream:
                    result = upstream.read(4_000_000)
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Length", str(len(result)))
                self.end_headers()
                self.wfile.write(result)
            except urllib.error.HTTPError as exc:
                self.send_json(502, {"error": f"Ollama retornou erro {exc.code}. Verifique se está ativo."})
            except Exception:
                self.send_json(502, {"error": "Não consegui alcançar o Ollama local. Confirme que ele está aberto e tente novamente."})
            return
        self.send_error(404)

    def log_message(self, fmt, *args):
        print(f"[{self.log_date_time_string()}] {self.client_address[0]} - {fmt % args}")

if __name__ == "__main__":
    print("=" * 58)
    print(" NEXO / BRENO - SERVIDOR DE APRESENTAÇÃO")
    print(f" Site local: http://localhost:{PORT}")
    print(f" Modelo Ollama: {MODEL}")
    print(" Acesso sem código de demonstração.")
    print(" Mantenha Ollama aberto. Para internet, use Cloudflare Tunnel.")
    print(" Compartilhe o link somente com os participantes.")
    print("=" * 58)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
