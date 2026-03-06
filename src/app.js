const fileInput = document.getElementById("fileInput");
const dropZone = document.getElementById("dropZone");
const statusEl = document.getElementById("status");
const dropSubtitle = document.getElementById("dropSubtitle");
const urlInput = document.getElementById("urlInput");
const urlLoad = document.getElementById("urlLoad");
const loadingSpinner = document.getElementById("loadingSpinner");
const content = document.getElementById("content");
const scrollArea = document.getElementById("scrollArea");
const progressFill = document.getElementById("progressFill");
const progressText = document.getElementById("progressText");
const progressWrap = document.getElementById("progressWrap");
const titleSpinner = document.getElementById("titleSpinner");
const halfToggle = document.getElementById("halfToggle");
const unlockZone = document.getElementById("unlockZone");
const scrollBack = document.getElementById("scrollBack");

const BASE_FONT_SIZE = 18;
const state = {
  fontSize: BASE_FONT_SIZE,
  currentFile: null,
  currentType: null,
  currentPdfData: null,
  currentPdfDoc: null,
  currentIframe: null,
  currentText: "",
  resizeRaf: 0,
  lastSize: { width: 0, height: 0 },
  halfMode: false,
  resetScrollOnRender: false,
  pdfCropRel: null,
  pdfCropEnabled: false,
  scrollUpdateQueued: false,
  slicePositions: [],
  halfTextColumn: 0,
  textColumnsEl: null,
  lastTapTime: 0,
  lastTapX: 0,
  lastTapY: 0,
  ignoreClickUntil: 0,
  scrollRestore: null,
};

const HTML_STYLE = `
  :root {
    font-size: ${BASE_FONT_SIZE}px;
    line-height: 1.7;
    font-family: "Source Sans 3", "Segoe UI", sans-serif;
    color: #1c1b1a;
    text-rendering: optimizeLegibility;
    -webkit-font-smoothing: antialiased;
  }
  body {
    margin: 0;
    padding: 0;
    background: transparent;
  }
  img { max-width: 100%; }
  pre {
    white-space: pre-wrap;
    word-break: break-word;
  }
`;

function setStatus(text) {
  if (!statusEl) return;
  statusEl.textContent = text;
}

function resetProgress() {
  progressFill.style.width = "0%";
  progressText.textContent = "0%";
  if (progressWrap) {
    progressWrap.classList.add("is-hidden");
  }
}

function logSlicePositions(label) {
  const count = state.slicePositions.length;
  if (count === 0) {
    console.warn(`[Rowing Reader] ${label}: no slice positions detected`);
    return;
  }
  const preview = state.slicePositions
    .slice(0, Math.min(4, count))
    .map((slice) => `${Math.round(slice.top)}→${Math.round(slice.bottom)}`)
    .join(", ");
  console.info(`[Rowing Reader] ${label}: ${count} slices (${preview}${count > 4 ? ", ..." : ""})`);
}

function waitForImages(root) {
  const images = Array.from(root.querySelectorAll("img"));
  if (!images.length) return Promise.resolve();
  return Promise.all(
    images.map(
      (img) =>
        new Promise((resolve) => {
          if (img.complete) {
            resolve();
            return;
          }
          img.addEventListener("load", resolve, { once: true });
          img.addEventListener("error", resolve, { once: true });
        }),
    ),
  );
}

function setLoading(isLoading) {
  if (!loadingSpinner) return;
  loadingSpinner.classList.toggle("is-hidden", !isLoading);
  if (titleSpinner) {
    titleSpinner.classList.toggle("is-hidden", !isLoading);
  }
}

function isReasonableUrl(rawUrl) {
  const value = rawUrl?.trim();
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "file:";
  } catch {
    return false;
  }
}

function updateUrlButtonState() {
  if (!urlLoad) return;
  urlLoad.disabled = !isReasonableUrl(urlInput?.value);
}

function getScrollStep() {
  const height = Math.max(1, scrollArea.clientHeight);
  const isFullPdf =
    !state.halfMode && (state.currentType === "pdf" || content.classList.contains("pdf-mode"));
  if (isFullPdf) {
    return height;
  }
  return Math.round(height * 0.85);
}

function setFontSize(size) {
  const clamped = Math.max(14, Math.min(28, size));
  state.fontSize = clamped;
  document.documentElement.style.setProperty("--reader-font-size", `${clamped}px`);
  if (state.currentType === "pdf" && state.currentPdfData) {
    renderPdfFromDoc();
  }
  if (state.currentType === "html" && state.currentIframe) {
    applyIframeStyles(state.currentIframe);
  }
  queueScrollUpdate();
}

function detectType(file) {
  const name = file.name.toLowerCase();
  if (file.type === "application/pdf" || name.endsWith(".pdf")) return "pdf";
  if (file.type === "text/markdown" || name.endsWith(".md") || name.endsWith(".markdown")) return "markdown";
  if (file.type === "text/html" || name.endsWith(".html") || name.endsWith(".htm")) return "html";
  return "text";
}

function resetContent() {
  content.innerHTML = "";
  state.currentIframe = null;
  content.classList.remove("pdf-mode");
  state.slicePositions = [];
  state.textColumnsEl = null;
  state.halfTextColumn = 0;
  state.pdfCropRel = null;
  state.pdfCropEnabled = false;
}

function applyTextHalfColumn() {
  if (!state.textColumnsEl) return;
  state.textColumnsEl.classList.toggle("column-right", state.halfTextColumn === 1);
}

function getTextWidth() {
  const width = getContentWidth();
  return Math.min(width, 820);
}

function applyTextWidths(node, width) {
  node.style.maxWidth = `${width}px`;
  node.style.margin = "0 auto";
}

function createHalfSlice({ html, fullWidth, textWidth, baseHeight, pageHeight, offsetX, offsetY }) {
  const slice = document.createElement("div");
  slice.className = "half-slice slice";
  slice.style.height = `${pageHeight}px`;

  const zoom = document.createElement("div");
  zoom.className = "half-zoom";
  zoom.style.width = `${fullWidth}px`;
  zoom.style.height = `${baseHeight}px`;
  zoom.style.transform = "scale(2)";
  zoom.style.transformOrigin = "top left";

  const inner = document.createElement("div");
  inner.className = "half-zoom-inner";
  inner.style.width = `${fullWidth}px`;
  inner.style.position = "relative";
  inner.style.left = `${-offsetX}px`;
  inner.style.top = `${-offsetY}px`;

  const article = document.createElement("article");
  article.className = "reader-article";
  applyTextWidths(article, textWidth);
  article.innerHTML = html;
  inner.appendChild(article);
  zoom.appendChild(inner);
  slice.appendChild(zoom);
  return slice;
}

function renderHalfText(html) {
  resetContent();
  content.classList.add("half-text-mode");

  const fullWidth = getContentWidth();
  const textWidth = getTextWidth();

  const measure = document.createElement("div");
  measure.style.position = "absolute";
  measure.style.visibility = "hidden";
  measure.style.pointerEvents = "none";
  measure.style.left = "-99999px";
  measure.style.top = "0";
  measure.style.width = `${fullWidth}px`;
  const measureArticle = document.createElement("article");
  measureArticle.className = "reader-article";
  applyTextWidths(measureArticle, textWidth);
  measureArticle.innerHTML = html;
  measure.appendChild(measureArticle);
  content.appendChild(measure);

  state.textColumnsEl = null;
  requestAnimationFrame(() => {
    requestAnimationFrame(async () => {
      await waitForImages(measure);
      const baseHeight = measureArticle.scrollHeight;
      measure.remove();

      const pageHeight = Math.max(1, scrollArea.clientHeight);
      const scaledHeight = baseHeight * 2;
      const totalPages = Math.max(1, Math.ceil(scaledHeight / pageHeight));
      const pageStep = pageHeight / 2;
      const halfOffsetX = fullWidth / 2;

      for (let i = 0; i < totalPages; i += 1) {
        const offsetY = i * pageStep;
        const leftSlice = createHalfSlice({
          html,
          fullWidth,
          textWidth,
          baseHeight,
          pageHeight,
          offsetX: 0,
          offsetY,
        });
        leftSlice.classList.add("slice-left");

        const rightSlice = createHalfSlice({
          html,
          fullWidth,
          textWidth,
          baseHeight,
          pageHeight,
          offsetX: halfOffsetX,
          offsetY,
        });
        rightSlice.classList.add("slice-right");

        content.appendChild(leftSlice);
        content.appendChild(rightSlice);
      }

      captureSlicePositions();
      logSlicePositions("Half text render");
      applyScrollRestore();
      queueScrollUpdate();
    });
  });
}

function renderMarkdown(text) {
  resetContent();
  const article = document.createElement("article");
  article.className = "reader-article";
  applyTextWidths(article, getTextWidth());
  if (window.marked && typeof window.marked.parse === "function") {
    const html = window.marked.parse(text);
    if (state.halfMode) {
      renderHalfText(html);
      return;
    }
    article.innerHTML = html;
  } else {
    const pre = document.createElement("pre");
    pre.textContent = text;
    article.appendChild(pre);
  }
  content.appendChild(article);
  applyScrollRestore();
  queueScrollUpdate();
}

function renderText(text) {
  if (state.halfMode) {
    const escaped = text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    renderHalfText(`<pre>${escaped}</pre>`);
    return;
  }
  resetContent();
  const pre = document.createElement("pre");
  pre.textContent = text;
  pre.style.whiteSpace = "pre-wrap";
  pre.style.wordBreak = "break-word";
  applyTextWidths(pre, getTextWidth());
  content.appendChild(pre);
  applyScrollRestore();
  queueScrollUpdate();
}

function applyIframeStyles(iframe) {
  const doc = iframe.contentDocument;
  if (!doc) return;
  const style = doc.createElement("style");
  style.textContent = HTML_STYLE.replace(`${BASE_FONT_SIZE}px`, `${state.fontSize}px`);
  if (doc.head) {
    doc.head.appendChild(style);
  } else {
    doc.documentElement.appendChild(style);
  }
  iframe.style.height = `${doc.documentElement.scrollHeight}px`;
}

function renderHtml(text) {
  resetContent();
  const iframe = document.createElement("iframe");
  iframe.className = "html-frame";
  iframe.setAttribute("sandbox", "allow-same-origin");
  iframe.srcdoc = text;
  iframe.onload = () => {
    applyIframeStyles(iframe);
    updateScrollButtons();
    applyScrollRestore();
  };
  content.appendChild(iframe);
  state.currentIframe = iframe;
}

function getContentWidth() {
  const styles = window.getComputedStyle(scrollArea);
  const paddingLeft = Number.parseFloat(styles.paddingLeft || "0");
  const paddingRight = Number.parseFloat(styles.paddingRight || "0");
  const width = scrollArea.clientWidth - paddingLeft - paddingRight;
  if (width && width > 0) return width;
  const fallback = scrollArea.clientWidth - 120;
  return Math.max(360, fallback);
}

function captureSlicePositions() {
  const nodes = content.querySelectorAll(".pdf-slice, .pdf-page, .half-slice");
  const scrollRect = scrollArea.getBoundingClientRect();
  state.slicePositions = Array.from(nodes).map((node) => {
    const rect = node.getBoundingClientRect();
    const top = rect.top - scrollRect.top + scrollArea.scrollTop;
    const height = rect.height;
    return { top, bottom: top + height };
  });
}

function getCurrentSliceIndex() {
  const slices = state.slicePositions;
  if (!slices.length) return 0;
  const y = scrollArea.scrollTop + 1;
  for (let i = slices.length - 1; i >= 0; i -= 1) {
    if (y >= slices[i].top) return i;
  }
  return 0;
}

function clampCrop(crop, margin, maxWidth, maxHeight) {
  const x = Math.max(0, crop.x - margin);
  const y = Math.max(0, crop.y - margin);
  const width = Math.min(maxWidth - x, crop.width + margin * 2);
  const height = Math.min(maxHeight - y, crop.height + margin * 2);
  return { x, y, width, height };
}

async function analyzePageContentBox(page) {
  const analysisScale = 0.35;
  const viewport = page.getViewport({ scale: analysisScale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  const context = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
  await page.render({ canvasContext: context, viewport }).promise;

  const { width, height } = canvas;
  const imageData = context.getImageData(0, 0, width, height).data;
  const step = 2;
  let minX = width;
  let minY = height;
  let maxX = 0;
  let maxY = 0;
  let found = false;

  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const index = (y * width + x) * 4;
      const r = imageData[index];
      const g = imageData[index + 1];
      const b = imageData[index + 2];
      if (r < 245 || g < 245 || b < 245) {
        found = true;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (!found) {
    return { crop: null, isMarginHeavy: false };
  }

  const contentWidth = maxX - minX + 1;
  const contentHeight = maxY - minY + 1;
  const widthRatio = contentWidth / width;
  const heightRatio = contentHeight / height;
  const left = minX / width;
  const right = (width - 1 - maxX) / width;
  const top = minY / height;
  const bottom = (height - 1 - maxY) / height;
  const marginMax = Math.max(left, right, top, bottom);

  const isMarginHeavy =
    widthRatio < 0.92 ||
    heightRatio < 0.92 ||
    marginMax > 0.06 ||
    left + right > 0.12 ||
    top + bottom > 0.14;

  const crop = {
    x: minX / analysisScale,
    y: minY / analysisScale,
    width: contentWidth / analysisScale,
    height: contentHeight / analysisScale,
  };

  return { crop, isMarginHeavy, widthRatio, heightRatio, marginMax };
}

function normalizePdfData(data) {
  if (data instanceof Uint8Array) {
    return data.slice();
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  return null;
}

async function loadPdfDocument(pdfData) {
  if (!window.pdfjsLib) {
    renderText("PDF renderer not available. Check the PDF.js script link.");
    return null;
  }
  if (state.currentPdfDoc) return state.currentPdfDoc;
  console.info("[Rowing Reader] PDF load started");
  window.pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  const normalized = normalizePdfData(pdfData);
  if (!normalized) {
    renderText("PDF renderer not available. Invalid PDF data.");
    return null;
  }
  const loadingTask = window.pdfjsLib.getDocument({ data: normalized, disableWorker: true });
  const pdf = await loadingTask.promise;
  state.currentPdfDoc = pdf;
  console.info("[Rowing Reader] PDF load complete");
  return pdf;
}

function captureScrollRestore() {
  const maxScroll = scrollArea.scrollHeight - scrollArea.clientHeight;
  if (state.currentType === "pdf" && state.slicePositions.length) {
    const index = getCurrentSliceIndex();
    const slice = state.slicePositions[index];
    const offset = scrollArea.scrollTop - slice.top;
    const pageIndex = state.halfMode ? Math.floor(index / 2) : index;
    const halfIndex = state.halfMode ? index % 2 : 0;
    return { kind: "pdf", pageIndex, halfIndex, offset };
  }
  const ratio = maxScroll > 0 ? scrollArea.scrollTop / maxScroll : 0;
  return { kind: "ratio", ratio };
}

function applyScrollRestore() {
  const restore = state.scrollRestore;
  if (!restore) return;
  state.scrollRestore = null;

  if (restore.kind === "pdf" && state.currentType === "pdf" && state.slicePositions.length) {
    let index = restore.pageIndex;
    if (state.halfMode) {
      index = restore.pageIndex * 2 + Math.min(restore.halfIndex, 1);
    }
    index = Math.max(0, Math.min(index, state.slicePositions.length - 1));
    const slice = state.slicePositions[index];
    const maxTop = Math.max(slice.bottom - scrollArea.clientHeight, slice.top);
    const targetTop = Math.min(Math.max(slice.top + restore.offset, slice.top), maxTop);
    scrollArea.scrollTo({ top: targetTop, behavior: "auto" });
    queueScrollUpdate();
    return;
  }

  if (restore.kind === "ratio") {
    const maxScroll = scrollArea.scrollHeight - scrollArea.clientHeight;
    const targetTop = maxScroll > 0 ? restore.ratio * maxScroll : 0;
    scrollArea.scrollTo({ top: targetTop, behavior: "auto" });
    queueScrollUpdate();
  }
}

async function renderPdfFromDoc() {
  if (!window.pdfjsLib) {
    renderText("PDF renderer not available. Check the PDF.js script link.");
    return;
  }
  try {
    const pdf = state.currentPdfDoc || (await loadPdfDocument(state.currentPdfData));
    if (!pdf) return;

    console.info("[Rowing Reader] PDF render started");
    resetContent();
    content.classList.add("pdf-mode");
    const pages = document.createElement("div");
    pages.className = "pdf-pages";
    content.appendChild(pages);

    const contentWidth = getContentWidth();
    const scaleFactor = 1;

    if (!state.pdfCropRel && pdf.numPages > 0) {
      let bestCrop = null;
      let bestArea = 0;
      let anyMarginHeavy = false;
      for (let i = 1; i <= pdf.numPages; i += 1) {
        const page = await pdf.getPage(i);
        const baseViewport = page.getViewport({ scale: 1 });
        const analysis = await analyzePageContentBox(page);
        if (!analysis.crop) continue;
        const rel = {
          x: analysis.crop.x / baseViewport.width,
          y: analysis.crop.y / baseViewport.height,
          width: analysis.crop.width / baseViewport.width,
          height: analysis.crop.height / baseViewport.height,
        };
        const area = rel.width * rel.height;
        if (area > bestArea) {
          bestArea = area;
          bestCrop = rel;
        }
        if (analysis.isMarginHeavy) {
          anyMarginHeavy = true;
        }
      }
      if (anyMarginHeavy && bestCrop) {
        state.pdfCropRel = bestCrop;
        state.pdfCropEnabled = true;
      } else {
        state.pdfCropRel = null;
        state.pdfCropEnabled = false;
      }
    }

    for (let i = 1; i <= pdf.numPages; i += 1) {
      const page = await pdf.getPage(i);
      const baseViewport = page.getViewport({ scale: 1 });
      let crop = { x: 0, y: 0, width: baseViewport.width, height: baseViewport.height };
      if (state.pdfCropEnabled && state.pdfCropRel) {
        crop = {
          x: baseViewport.width * state.pdfCropRel.x,
          y: baseViewport.height * state.pdfCropRel.y,
          width: baseViewport.width * state.pdfCropRel.width,
          height: baseViewport.height * state.pdfCropRel.height,
        };
      }

      const margin = Math.max(crop.width * 0.008, crop.height * 0.008, 2);
      crop = clampCrop(crop, margin, baseViewport.width, baseViewport.height);
      const targetWidth = state.halfMode ? contentWidth * 2 : contentWidth;
      const scale = (targetWidth / crop.width) * scaleFactor;
      const scaledViewport = page.getViewport({ scale });

      const fullWidth = Math.ceil(crop.width * scale);
      const fullHeight = Math.ceil(crop.height * scale);
      const baseTransform = [1, 0, 0, 1, -crop.x * scale, -crop.y * scale];

      if (state.halfMode) {
        const leftWidth = Math.floor(fullWidth / 2);
        const rightWidth = Math.max(1, fullWidth - leftWidth);

        const leftCanvas = document.createElement("canvas");
        leftCanvas.className = "pdf-page pdf-slice";
        leftCanvas.width = Math.max(1, leftWidth);
        leftCanvas.height = Math.max(1, fullHeight);
        pages.appendChild(leftCanvas);
        const leftContext = leftCanvas.getContext("2d", { alpha: false });
        await page.render({ canvasContext: leftContext, viewport: scaledViewport, transform: baseTransform }).promise;

        const rightCanvas = document.createElement("canvas");
        rightCanvas.className = "pdf-page pdf-slice";
        rightCanvas.width = rightWidth;
        rightCanvas.height = Math.max(1, fullHeight);
        pages.appendChild(rightCanvas);
        const rightContext = rightCanvas.getContext("2d", { alpha: false });
        const rightShift = crop.x * scale + leftWidth;
        const rightTransform = [1, 0, 0, 1, -rightShift, -crop.y * scale];
        await page.render({ canvasContext: rightContext, viewport: scaledViewport, transform: rightTransform }).promise;
      } else {
        const canvas = document.createElement("canvas");
        canvas.className = "pdf-page";
        canvas.width = Math.max(1, fullWidth);
        canvas.height = Math.max(1, fullHeight);
        pages.appendChild(canvas);
        const context = canvas.getContext("2d", { alpha: false });
        await page.render({ canvasContext: context, viewport: scaledViewport, transform: baseTransform }).promise;
      }
    }
    await new Promise((resolve) => {
      requestAnimationFrame(resolve);
    });
    await new Promise((resolve) => {
      requestAnimationFrame(resolve);
    });
    captureSlicePositions();
    logSlicePositions("PDF render");
    applyScrollRestore();
    if (state.resetScrollOnRender) {
      scrollArea.scrollTop = 0;
      state.resetScrollOnRender = false;
    }
    queueScrollUpdate();
    console.info("[Rowing Reader] PDF render complete");
    const renderEvent = new Event("pdf-render-complete");
    document.dispatchEvent(renderEvent);
    window.dispatchEvent(renderEvent);
  } catch (err) {
    renderText(`PDF render error: ${err.message || err}`);
  }
}

async function handleFile(file) {
  state.currentFile = file;
  state.currentType = detectType(file);
  state.currentPdfData = null;
  state.currentPdfDoc = null;
  state.halfMode = false;
  state.currentText = "";
  state.slicePositions = [];
  updateHalfToggle();
  document.body.classList.toggle("has-pdf", state.currentType === "pdf");
  document.body.classList.toggle("has-file", true);
  setStatus(`Loaded ${file.name} (${state.currentType}).`);
  state.resetScrollOnRender = true;
  resetProgress();
  unlockZone.classList.remove("is-hidden");

  if (state.currentType === "pdf") {
    setLoading(true);
    try {
      const buffer = await file.arrayBuffer();
      state.currentPdfData = new Uint8Array(buffer);
      state.currentPdfDoc = null;
      await loadPdfDocument(state.currentPdfData);
      await renderPdfFromDoc();
      queueScrollUpdate();
    } finally {
      setLoading(false);
    }
    return;
  }

  setLoading(true);
  try {
    const text = await file.text();
    state.currentText = text;
    if (state.currentType === "markdown") {
      renderMarkdown(text);
    } else if (state.currentType === "html") {
      renderHtml(text);
    } else {
      renderText(text);
    }
    queueScrollUpdate();
    if (progressWrap) {
      progressWrap.classList.remove("is-hidden");
    }
  } finally {
    setLoading(false);
  }
}

function handleFiles(files) {
  if (!files || files.length === 0) return;
  handleFile(files[0]);
}

async function handleUrlLoad(rawUrl) {
  const url = rawUrl?.trim();
  if (!url) return;
  try {
    setLoading(true);
    if (dropSubtitle) {
      dropSubtitle.textContent = "Loading URL...";
    }
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const blob = await response.blob();
    const nameFromUrl = decodeURIComponent(url.split("?")[0].split("#")[0].split("/").pop() || "document");
    const file = new File([blob], nameFromUrl, { type: blob.type || "" });
    await handleFile(file);
  } catch (err) {
    if (dropSubtitle) {
      dropSubtitle.textContent = `Failed to load URL (${err.message || err}).`;
    }
    setLoading(false);
  }
}

function updateHalfToggle() {
  halfToggle.setAttribute("aria-pressed", state.halfMode ? "true" : "false");
  halfToggle.textContent = state.halfMode ? "Full Mode" : "Half Mode";
}

function updateProgress() {
  const step = Math.max(1, getScrollStep());
  const maxScroll = scrollArea.scrollHeight - scrollArea.clientHeight;
  if (maxScroll <= 1) {
    progressFill.style.width = "100%";
    progressText.textContent = "100%";
    return;
  }
  const totalSteps = Math.max(1, Math.ceil(maxScroll / step));
  const currentSteps = scrollArea.scrollTop <= 0 ? 0 : Math.min(totalSteps, Math.ceil(scrollArea.scrollTop / step));
  const percent = Math.round((currentSteps / totalSteps) * 100);
  progressFill.style.width = `${percent}%`;
  progressText.textContent = `${percent}%`;
}

function updateScrollButtons() {
  const maxScroll = scrollArea.scrollHeight - scrollArea.clientHeight;
  if (maxScroll <= 1) {
    scrollBack.classList.add("is-hidden");
    unlockZone.classList.add("is-hidden");
    updateProgress();
    return;
  }
  if (scrollArea.scrollTop <= 1) {
    scrollBack.classList.add("is-hidden");
  } else {
    scrollBack.classList.remove("is-hidden");
  }
  if (scrollArea.scrollTop >= maxScroll - 1) {
    unlockZone.classList.add("is-hidden");
  } else {
    unlockZone.classList.remove("is-hidden");
  }
  updateProgress();
}

function queueScrollUpdate() {
  if (state.scrollUpdateQueued) return;
  state.scrollUpdateQueued = true;
  requestAnimationFrame(() => {
    state.scrollUpdateQueued = false;
    updateScrollButtons();
  });
}

function preventScroll(event) {
  event.preventDefault();
}

function setupStrictScrolling() {
  document.addEventListener("wheel", preventScroll, { passive: false });
  document.addEventListener("touchmove", preventScroll, { passive: false });
  const preventGesture = (event) => {
    event.preventDefault();
  };
  document.addEventListener("gesturestart", preventGesture, { passive: false });
  document.addEventListener("gesturechange", preventGesture, { passive: false });
  document.addEventListener("gestureend", preventGesture, { passive: false });
  document.addEventListener("dblclick", preventGesture, { passive: false });
  document.addEventListener(
    "touchend",
    (event) => {
      if (!event.changedTouches || event.changedTouches.length !== 1) return;
      if (event.touches && event.touches.length > 0) return;

      const touch = event.changedTouches[0];
      const now = Date.now();
      const dt = now - state.lastTapTime;
      const dx = Math.abs(touch.clientX - state.lastTapX);
      const dy = Math.abs(touch.clientY - state.lastTapY);
      const isDoubleTap = dt > 0 && dt < 300 && dx < 24 && dy < 24;

      state.lastTapTime = now;
      state.lastTapX = touch.clientX;
      state.lastTapY = touch.clientY;

      if (isDoubleTap) {
        event.preventDefault();
      }
    },
    { passive: false },
  );
  const scrollByExact = (delta) => {
    const startTop = scrollArea.scrollTop;
    const targetTop = startTop + delta;
    const maxScroll = scrollArea.scrollHeight - scrollArea.clientHeight;
    const clampedTarget = Math.min(targetTop, maxScroll);
    console.info(
      "[Rowing Reader] exact-scroll start",
      JSON.stringify({
        delta,
        startTop,
        targetTop,
        clampedTarget,
        clientHeight: scrollArea.clientHeight,
        scrollHeight: scrollArea.scrollHeight,
      }),
    );
    scrollArea.scrollTo({ top: clampedTarget, behavior: "auto" });
    requestAnimationFrame(() => {
      const correctedMax = scrollArea.scrollHeight - scrollArea.clientHeight;
      const correctedTarget = Math.min(targetTop, correctedMax);
      const endTop = scrollArea.scrollTop;
      if (Math.abs(scrollArea.scrollTop - correctedTarget) > 1) {
        scrollArea.scrollTo({ top: correctedTarget, behavior: "auto" });
      }
      console.info(
        "[Rowing Reader] exact-scroll end",
        JSON.stringify({
          endTop,
          correctedTarget,
          correctedMax,
          clientHeight: scrollArea.clientHeight,
          scrollHeight: scrollArea.scrollHeight,
        }),
      );
      queueScrollUpdate();
    });
  };
  const scrollForward = () => {
    if (state.halfMode && !state.slicePositions.length) {
      console.warn("[Rowing Reader] Half Mode: no slices available for scroll forward");
    }
    if (state.halfMode && state.slicePositions.length) {
      const index = getCurrentSliceIndex();
      const slice = state.slicePositions[index];
      const step = getScrollStep();
      const maxTop = Math.max(slice.bottom - scrollArea.clientHeight, slice.top);
      if (scrollArea.scrollTop < maxTop - 1) {
        const targetTop = Math.min(scrollArea.scrollTop + step, maxTop);
        scrollArea.scrollTo({ top: targetTop, behavior: "auto" });
        queueScrollUpdate();
        return;
      }
      if (index + 1 < state.slicePositions.length) {
        scrollArea.scrollTo({ top: state.slicePositions[index + 1].top, behavior: "auto" });
        queueScrollUpdate();
        return;
      }
    }
    const isFullPdf =
      !state.halfMode && (state.currentType === "pdf" || content.classList.contains("pdf-mode"));
    if (isFullPdf) {
      scrollByExact(scrollArea.clientHeight);
      return;
    }
    scrollArea.scrollBy({ top: getScrollStep(), behavior: "auto" });
    queueScrollUpdate();
  };
  const scrollBackward = () => {
    if (state.halfMode && !state.slicePositions.length) {
      console.warn("[Rowing Reader] Half Mode: no slices available for scroll back");
    }
    if (state.halfMode && state.slicePositions.length) {
      const index = getCurrentSliceIndex();
      const slice = state.slicePositions[index];
      const step = getScrollStep();
      const minTop = slice.top;
      if (scrollArea.scrollTop > minTop + 1) {
        const targetTop = Math.max(scrollArea.scrollTop - step, minTop);
        scrollArea.scrollTo({ top: targetTop, behavior: "auto" });
        queueScrollUpdate();
        return;
      }
      if (index > 0) {
        const prev = state.slicePositions[index - 1];
        const targetTop = Math.max(prev.bottom - scrollArea.clientHeight, prev.top);
        scrollArea.scrollTo({ top: targetTop, behavior: "auto" });
        queueScrollUpdate();
        return;
      }
    }
    const isFullPdf =
      !state.halfMode && (state.currentType === "pdf" || content.classList.contains("pdf-mode"));
    if (isFullPdf) {
      scrollByExact(-scrollArea.clientHeight);
      return;
    }
    scrollArea.scrollBy({ top: -getScrollStep(), behavior: "auto" });
    queueScrollUpdate();
  };

  const handleScrollForward = () => {
    unlockZone.click();
  };

  const handleScrollBackward = () => {
    scrollBack.click();
  };

  document.addEventListener("keydown", (event) => {
    const tag = event.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    const keys = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End", " "];
    if (keys.includes(event.key)) {
      event.preventDefault();
    }
    if (event.key === "PageDown") {
      handleScrollForward();
    }
    if (event.key === "PageUp") {
      handleScrollBackward();
    }
    if (event.key === "Home") {
      scrollArea.scrollTo({ top: 0, behavior: "auto" });
      queueScrollUpdate();
    }
    if (event.key === "End") {
      scrollArea.scrollTo({ top: scrollArea.scrollHeight, behavior: "auto" });
      queueScrollUpdate();
    }
    if (event.key === "ArrowRight") {
      handleScrollForward();
    }
    if (event.key === "ArrowLeft") {
      handleScrollBackward();
    }
  });

  unlockZone.addEventListener("click", () => {
    if (Date.now() < state.ignoreClickUntil) return;
    scrollForward();
  });

  scrollBack.addEventListener("click", () => {
    if (Date.now() < state.ignoreClickUntil) return;
    scrollBackward();
  });

  const handleTouchScroll = (event, direction) => {
    event.preventDefault();
    state.ignoreClickUntil = Date.now() + 500;
    if (direction === "forward") {
      scrollForward();
    } else {
      scrollBackward();
    }
  };

  unlockZone.addEventListener(
    "touchstart",
    (event) => handleTouchScroll(event, "forward"),
    { passive: false },
  );

  scrollBack.addEventListener(
    "touchstart",
    (event) => handleTouchScroll(event, "back"),
    { passive: false },
  );

  scrollArea.addEventListener("scroll", () => {
    updateScrollButtons();
  });
}

function setupEvents() {
  fileInput.addEventListener("change", (event) => {
    handleFiles(event.target.files);
  });

  dropZone.addEventListener("dragover", (event) => {
    event.preventDefault();
    dropZone.classList.add("dragover");
  });

  dropZone.addEventListener("dragleave", () => {
    dropZone.classList.remove("dragover");
  });

  dropZone.addEventListener("drop", (event) => {
    event.preventDefault();
    dropZone.classList.remove("dragover");
    handleFiles(event.dataTransfer.files);
  });

  urlLoad.addEventListener("click", () => {
    if (urlLoad.disabled) return;
    handleUrlLoad(urlInput.value);
  });

  urlInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      handleUrlLoad(urlInput.value);
    }
  });

  urlInput.addEventListener("input", () => {
    updateUrlButtonState();
  });

  halfToggle.addEventListener("click", () => {
    state.scrollRestore = captureScrollRestore();
    state.halfMode = !state.halfMode;
    updateHalfToggle();
    console.info(`[Rowing Reader] Half Mode ${state.halfMode ? "enabled" : "disabled"}`);
    if (state.currentType === "pdf" && state.currentPdfData) {
      state.resetScrollOnRender = false;
      renderPdfFromDoc();
    } else if (state.currentType === "markdown") {
      renderMarkdown(state.currentText);
    } else if (state.currentType === "text") {
      renderText(state.currentText);
    } else {
      queueScrollUpdate();
    }
  });

  const brandLink = document.querySelector(".brand-title-link");
  if (brandLink) {
    brandLink.addEventListener("click", (event) => {
      event.preventDefault();
      window.location.href = "/";
    });
  }

  window.addEventListener("resize", () => {
    if (state.currentType !== "pdf" || !state.currentPdfData) return;
    if (state.resizeRaf) return;
    state.resizeRaf = requestAnimationFrame(() => {
      state.resizeRaf = 0;
      const width = scrollArea.clientWidth;
      const height = scrollArea.clientHeight;
      if (width === state.lastSize.width && height === state.lastSize.height) {
        return;
      }
      state.lastSize = { width, height };
      renderPdfFromDoc();
      queueScrollUpdate();
    });
  });
}

setupStrictScrolling();
setupEvents();
setFontSize(BASE_FONT_SIZE);
updateHalfToggle();
queueScrollUpdate();
updateUrlButtonState();

document.addEventListener("pdf-render-complete", () => {
  if (progressWrap) {
    progressWrap.classList.remove("is-hidden");
  }
});

const urlParam = new URLSearchParams(window.location.search).get("url");
if (urlParam) {
  urlInput.value = urlParam;
  handleUrlLoad(urlParam);
}
