#!/usr/bin/env python3
from __future__ import annotations

import argparse
import ssl
import sys
from functools import partial
from http.server import BaseHTTPRequestHandler, SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from socket import AF_INET, SOCK_DGRAM, socket
from urllib.parse import urlunsplit


def detect_local_ip() -> str:
    # Best-effort local LAN IP detection without external dependencies.
    try:
        with socket(AF_INET, SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))
            return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Serve Rowing Reader over HTTP and HTTPS on the local network."
    )
    parser.add_argument(
        "--host",
        default=detect_local_ip(),
        help="Bind address (default: detected local IP)",
    )
    parser.add_argument(
        "--http-port",
        type=int,
        default=8123,
        help="HTTP port (default: 8123)",
    )
    parser.add_argument(
        "--https-port",
        type=int,
        default=8124,
        help="HTTPS port (default: 8124)",
    )
    parser.add_argument(
        "--cert",
        default=str(Path("certs/rowing-reader.local.pem")),
        help="Path to TLS certificate PEM",
    )
    parser.add_argument(
        "--key",
        default=str(Path("certs/rowing-reader.local-key.pem")),
        help="Path to TLS private key PEM",
    )
    parser.add_argument(
        "--dir",
        default=str(Path(__file__).resolve().parent / "src"),
        help="Directory to serve (default: ./src)",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    root = Path(args.dir).resolve()
    if not root.exists():
        print(f"error: directory not found: {root}", file=sys.stderr)
        return 2

    cert_path = Path(args.cert).resolve()
    key_path = Path(args.key).resolve()

    if not cert_path.exists() or not key_path.exists():
        print("TLS certificate or key not found.", file=sys.stderr)
        print("Generate them with mkcert, e.g.:", file=sys.stderr)
        print(
            f"  mkcert -install\n"
            f"  mkdir -p certs\n"
            f"  mkcert -cert-file certs/rowing-reader.local.pem "
            f"-key-file certs/rowing-reader.local-key.pem "
            f"{args.host} rowing-reader.local\n",
            file=sys.stderr,
        )
        return 2

    class NoCacheRequestHandler(SimpleHTTPRequestHandler):
        def send_head(self):
            # Strip conditional headers to avoid 304 responses.
            if "If-Modified-Since" in self.headers:
                del self.headers["If-Modified-Since"]
            if "If-None-Match" in self.headers:
                del self.headers["If-None-Match"]
            return super().send_head()

        def end_headers(self) -> None:
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
            self.send_header("Pragma", "no-cache")
            self.send_header("Expires", "0")
            super().end_headers()

    https_handler = partial(NoCacheRequestHandler, directory=str(root))

    class RedirectHandler(BaseHTTPRequestHandler):
        def _redirect(self) -> None:
            host = self.headers.get("Host", args.host)
            # Replace port if present; otherwise append HTTPS port.
            if ":" in host:
                host = host.split(":", 1)[0]
            host = f"{host}:{args.https_port}"
            target = urlunsplit(("https", host, self.path, "", ""))
            self.send_response(301)
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
            self.send_header("Pragma", "no-cache")
            self.send_header("Expires", "0")
            self.send_header("Location", target)
            self.end_headers()

        def do_GET(self) -> None:  # noqa: N802 - stdlib naming
            self._redirect()

        def do_HEAD(self) -> None:  # noqa: N802 - stdlib naming
            self._redirect()

        def do_POST(self) -> None:  # noqa: N802 - stdlib naming
            self._redirect()

    httpd = ThreadingHTTPServer((args.host, args.http_port), RedirectHandler)
    httpsd = ThreadingHTTPServer((args.host, args.https_port), https_handler)

    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(certfile=str(cert_path), keyfile=str(key_path))
    httpsd.socket = context.wrap_socket(httpsd.socket, server_side=True)

    print(f"Serving HTTP  on http://{args.host}:{args.http_port}")
    print(f"Serving HTTPS on https://{args.host}:{args.https_port}")
    print(f"Root directory: {root}")

    try:
        from threading import Thread

        t = Thread(target=httpsd.serve_forever, daemon=True)
        t.start()
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down...")
    finally:
        httpd.server_close()
        httpsd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
