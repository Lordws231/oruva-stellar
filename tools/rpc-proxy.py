#!/usr/bin/env python3
"""Local reverse proxy for the Stellar testnet RPC.

Why this exists: this VM has no direct internet egress; outbound traffic must
go through the egress proxy named in the HTTPS_PROXY env var. curl honours
that variable (including its authentication), but the Stellar CLI's HTTP
client does not, so the CLI fails to connect to soroban-testnet.stellar.org
directly. Python's urllib also stalls on this proxy, so the upstream leg is
done with curl, which is fast and reliable here.

This proxy listens on 127.0.0.1 only and forwards JSON-RPC requests to the
real testnet RPC. Point the CLI at it with --rpc-url http://127.0.0.1:8765

Testnet only. No credentials are stored here.
"""
import os
import subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

UPSTREAM = os.environ.get("ORUVA_RPC_UPSTREAM", "https://soroban-testnet.stellar.org/")
LISTEN_HOST = "127.0.0.1"
LISTEN_PORT = int(os.environ.get("ORUVA_RPC_PROXY_PORT", "8765"))


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _forward(self, method):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""
        ctype = self.headers.get("Content-Type", "application/json")
        cmd = [
            "curl", "-s", "-S", "-m", "110",
            "-X", method,
            "-H", f"Content-Type: {ctype}",
            "--data-binary", "@-",
            "-w", "\n%{http_code}",
            UPSTREAM,
        ]
        try:
            proc = subprocess.run(cmd, input=body, capture_output=True, timeout=115)
            out = proc.stdout
            # Last line is the HTTP status code from -w.
            *payload_lines, status_line = out.rsplit(b"\n", 1)
            payload = b"\n".join(payload_lines)
            try:
                status = int(status_line.decode().strip())
            except ValueError:
                status = 502
                payload = b'{"error": "upstream curl failed"}'
        except Exception as e:  # noqa: BLE001 - surface as JSON error
            status = 502
            payload = ('{"error": "%s"}' % str(e).replace('"', "'")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        self._forward("GET")

    def do_POST(self):
        self._forward("POST")

    def log_message(self, fmt, *args):  # keep the log quiet
        pass


if __name__ == "__main__":
    server = ThreadingHTTPServer((LISTEN_HOST, LISTEN_PORT), Handler)
    print(f"RPC proxy listening on http://{LISTEN_HOST}:{LISTEN_PORT} -> {UPSTREAM}", flush=True)
    server.serve_forever()
