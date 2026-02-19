# Rowing Reader

Minimal webapp to render PDF, Markdown, or HTML with a locked viewport and controlled scrolling.

## Run

Use any static server (recommended) or open the file directly.

```bash
python -m http.server 8000
```

Then open `http://localhost:8000`.

## Behavior

- The viewport never scrolls by wheel, touch, or keys.
- The only scroll actions are the lower-left and lower-right buttons (or Page Up / Page Down).
- Half toggle switches to two-column reading (PDF only).

## Notes

- PDF and Markdown rendering use CDN scripts (`pdf.js`, `marked`).
- For offline use, download those scripts and update the script tags in `index.html`.
