#!/usr/bin/env python3
from __future__ import annotations

import argparse
import ssl
import sys
from functools import partial
from http.server import BaseHTTPRequestHandler, SimpleHTTPRequestHandler, ThreadingHTTPServer
from ipaddress import ip_address
from pathlib import Path
from socket import AF_INET, IPPROTO_TCP, SOCK_DGRAM, getaddrinfo, socket
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlsplit, urlunsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


# The request line is attacker-controlled, and Python 3.8's http.server writes it
# to stderr verbatim in its access log. A crafted request could therefore smuggle
# ANSI / terminal escape sequences into the log and scramble the tmux pane running
# the server, so escape every C0/C1 control byte and DEL before logging. (Newer
# Pythons do this themselves via BaseHTTPRequestHandler._control_char_table; 3.8
# does not.)
_LOG_CTRL_ESCAPES = {
    c: f"\\x{c:02x}" for c in list(range(0x20)) + [0x7F] + list(range(0x80, 0xA0))
}


class SafeLogMixin:
    """Escape control characters in every logged request line so a malicious
    request can't corrupt the terminal. Mixed in ahead of the stdlib handler so
    this log_message wins."""

    def log_message(self, format: str, *args) -> None:  # noqa: A002 - stdlib signature
        try:
            message = format % args
        except Exception:
            message = format
        sys.stderr.write(
            "%s - - [%s] %s\n"
            % (
                self.address_string(),
                self.log_date_time_string(),
                message.translate(_LOG_CTRL_ESCAPES),
            )
        )


# Same-origin relay for "load this URL" in the browser. Most sites that host a
# PDF send no Access-Control-Allow-Origin header, so the page's own fetch() is
# blocked; the browser asks us to fetch it instead.
PROXY_PATH = "/__fetch"
PROXY_MAX_BYTES = 512 * 1024 * 1024
PROXY_TIMEOUT = 30
PROXY_MAX_REDIRECTS = 5
PROXY_USER_AGENT = "RowingReader/1.0 (+local relay)"
# Headers worth passing back to the page; everything else (cookies, auth,
# framing policies) is dropped. Content-Encoding has to travel with the body it
# describes — urllib hands us the bytes undecoded.
PROXY_FORWARD_HEADERS = (
    "Content-Type",
    "Content-Disposition",
    "Content-Length",
    "Content-Encoding",
)


class ProxyRefused(Exception):
    """The requested URL is not one this relay will fetch."""


HOSTS_FILE = Path("/etc/hosts")


def hosts_file_loopback_names() -> frozenset:
    """Names the machine's own hosts file pins to a loopback address.

    A box that also serves a public site often maps that site's name to
    127.0.0.1 so it reaches itself directly. Those names are chosen by whoever
    administers the machine (a remote DNS answer can't add one), so they are
    trusted — but the stock localhost aliases are not, since they exist on
    every box and name nothing but loopback.
    """
    excluded = {"localhost", "localhost.localdomain", "ip6-localhost", "ip6-loopback"}
    names = set()
    try:
        lines = HOSTS_FILE.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return frozenset()
    for line in lines:
        fields = line.split("#", 1)[0].split()
        if len(fields) < 2:
            continue
        try:
            if not ip_address(fields[0]).is_loopback:
                continue
        except ValueError:
            continue
        for name in fields[1:]:
            name = name.lower().rstrip(".")
            if name in excluded or name.endswith(".localhost"):
                continue
            names.add(name)
    return frozenset(names)


def check_proxy_target(url: str) -> None:
    """Reject anything that isn't a plain remote http(s) document.

    The relay is reachable by anyone who can reach this server, so it must not
    become a way to probe services that are only listening on loopback, or a
    cloud metadata endpoint. Other LAN addresses stay allowed on purpose: a PDF
    on a NAS is a legitimate thing to read.
    """
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https"):
        raise ProxyRefused("only http and https URLs can be relayed")
    host = parts.hostname
    if not host:
        raise ProxyRefused("URL has no host")
    default_port = 443 if parts.scheme == "https" else 80
    port = parts.port or default_port
    # A hosts-file name for this machine's own site may resolve to loopback,
    # but only on the scheme's standard port — the port its web server answers
    # publicly anyway — so it can't reach anything else bound to loopback.
    local_site = host.lower().rstrip(".") in hosts_file_loopback_names() and port == default_port
    try:
        infos = getaddrinfo(host, port, proto=IPPROTO_TCP)
    except OSError:
        raise ProxyRefused(f"cannot resolve {host}") from None
    for info in infos:
        addr = ip_address(info[4][0])
        if addr.is_loopback and local_site:
            continue
        if addr.is_loopback or addr.is_link_local or addr.is_multicast or addr.is_unspecified:
            raise ProxyRefused(f"refusing to relay {host} ({addr})")


class CheckedRedirectHandler(HTTPRedirectHandler):
    """Re-run the target check on every redirect hop."""

    max_redirections = PROXY_MAX_REDIRECTS

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        check_proxy_target(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


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

    class NoCacheRequestHandler(SafeLogMixin, SimpleHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802 - stdlib naming
            if urlsplit(self.path).path == PROXY_PATH:
                self.relay_url()
                return
            super().do_GET()

        def do_HEAD(self) -> None:  # noqa: N802 - stdlib naming
            if urlsplit(self.path).path == PROXY_PATH:
                self.send_error(405, "HEAD not supported on the relay")
                return
            super().do_HEAD()

        def send_plain_error(self, code: int, message: str) -> None:
            body = message.encode("utf-8", "replace")
            self.send_response(code)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def relay_url(self) -> None:
            query = parse_qs(urlsplit(self.path).query)
            targets = query.get("url") or []
            if not targets or not targets[0].strip():
                self.send_plain_error(400, "missing ?url= parameter")
                return
            target = targets[0].strip()

            try:
                check_proxy_target(target)
            except ProxyRefused as exc:
                self.send_plain_error(403, str(exc))
                return

            opener = build_opener(CheckedRedirectHandler)
            request = Request(
                target,
                headers={
                    "User-Agent": PROXY_USER_AGENT,
                    "Accept": "*/*",
                    # Relay raw bytes; nothing here decompresses a response.
                    "Accept-Encoding": "identity",
                },
            )
            try:
                upstream = opener.open(request, timeout=PROXY_TIMEOUT)
            except ProxyRefused as exc:
                self.send_plain_error(403, str(exc))
                return
            except HTTPError as exc:
                self.send_plain_error(502, f"upstream returned HTTP {exc.code}")
                return
            except (URLError, OSError, ValueError) as exc:
                reason = getattr(exc, "reason", exc)
                self.send_plain_error(502, f"could not reach the URL ({reason})")
                return

            with upstream:
                declared = upstream.headers.get("Content-Length")
                if declared and declared.isdigit() and int(declared) > PROXY_MAX_BYTES:
                    self.send_plain_error(413, "that document is too large to relay")
                    return

                self.send_response(200)
                for header in PROXY_FORWARD_HEADERS:
                    value = upstream.headers.get(header)
                    if value:
                        self.send_header(header, value)
                if not upstream.headers.get("Content-Type"):
                    self.send_header("Content-Type", "application/octet-stream")
                # The page fetches this from its own origin, but be explicit so
                # the response is usable if the app is ever served elsewhere.
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()

                sent = 0
                while True:
                    chunk = upstream.read(64 * 1024)
                    if not chunk:
                        break
                    sent += len(chunk)
                    if sent > PROXY_MAX_BYTES:
                        self.log_message("relay aborted: %s exceeded size cap", target)
                        break
                    try:
                        self.wfile.write(chunk)
                    except (BrokenPipeError, ConnectionResetError):
                        return

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

    class RedirectHandler(SafeLogMixin, BaseHTTPRequestHandler):
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
