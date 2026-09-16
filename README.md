# Rowing Reader

Minimal webapp to render PDF, Markdown, or HTML with a locked viewport and controlled scrolling.

![Rowing Reader cartoon](assets/rr.jpg)

## Run

Use any static server (recommended) or open the file directly.

```bash
python -m http.server 8000
```

Then open `http://localhost:8000`.

## Local HTTPS (LAN)

Serve over HTTP and HTTPS on your local network with self-trusted certificates.

```bash
mkcert -install
mkdir -p certs
mkcert -cert-file certs/rowing-reader.local.pem \
  -key-file certs/rowing-reader.local-key.pem \
  192.168.1.178 rowing-reader.local

python serve_local.py
```

Defaults:

- HTTP: `http://<local-ip>:8123`
- HTTPS: `https://<local-ip>:8124`
- HTTP automatically redirects to HTTPS.

You can override the bind address and ports:

```bash
python serve_local.py --host 192.168.1.178 --http-port 8123 --https-port 8124
```

## Loading a document

Four ways in, all equivalent:

- **Upload** picks a local file.
- **Drag-and-drop** a file, or a link / browser tab / selected URL, anywhere on the page.
- **Paste** (Ctrl/Cmd-V) a URL into the URL field or onto the page. Copied files paste too.
- **`?url=`** loads a document on page load, e.g. `https://…:8124/?url=https://arxiv.org/pdf/2301.00001`.

URLs may omit the scheme (`arxiv.org/pdf/2301.00001` works). A document is
treated as a PDF when its bytes start with `%PDF-`, so a missing `.pdf`
extension or a wrong `Content-Type` still renders correctly.

### Why URLs need `serve_local.py`

Most sites that host a PDF send no `Access-Control-Allow-Origin` header, so the
browser blocks the page from fetching them directly. `serve_local.py` exposes a
same-origin relay at `/__fetch?url=…` and the page falls back to it whenever a
direct fetch fails. Under a plain static server (`python -m http.server`) the
relay does not exist, so only same-origin and CORS-enabled URLs load.

The relay will fetch any http(s) URL reachable from the machine running it,
except loopback, link-local, and multicast addresses — so it cannot be used to
probe services bound only to that machine. Other LAN addresses are allowed on
purpose, so a PDF on a local NAS still loads. Run it on trusted networks only.

One exception: a name that `/etc/hosts` maps to a loopback address (other than
`localhost` and its stock aliases) is relayed on its scheme's standard port
(80 for http, 443 for https). That covers a machine hosting its own public site
and pinning that site's name to `127.0.0.1`.

## Behavior

- The viewport never scrolls by wheel, touch, or pinch.
- The only scroll actions are the lower-left and lower-right buttons, or the keys: PageUp/PageDown, ArrowLeft/ArrowRight, Home/End.
- Half toggle switches to a 2× zoomed, two-column reading layout (works for PDF, Markdown, and plain text). HTML is displayed full-width only.

## Notes

- PDF and Markdown rendering use CDN scripts (`pdf.js`, `marked`, and `DOMPurify`, which sanitizes rendered Markdown).
- For offline use, download those scripts and update the script tags in `index.html`.
