const { test, expect } = require("@playwright/test");
const path = require("path");

async function loadTestPdf(page) {
  await page.setViewportSize({ width: 900, height: 700 });
  await page.goto("/");

  await page.evaluate(() => {
    window.__pdfReady = new Promise((resolve) => {
      document.addEventListener("pdf-render-complete", resolve, { once: true });
    });
  });

  const pdfPath = path.resolve(__dirname, "fixtures", "sample.pdf");
  await page.setInputFiles("#fileInput", pdfPath);
  await page.evaluate(() => window.__pdfReady);

  await page.waitForFunction(() => {
    const scrollArea = document.getElementById("scrollArea");
    return scrollArea.scrollHeight > scrollArea.clientHeight + 50;
  });
}

test("full-mode PDF scrolls one viewport minus one line height per click", async ({ page }) => {
  await loadTestPdf(page);

  const result = await page.evaluate(() => {
    const scrollArea = document.getElementById("scrollArea");
    const forward = document.getElementById("unlockZone");
    scrollArea.scrollTop = 0;
    const height = scrollArea.clientHeight;
    const fontSize = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--reader-font-size"));
    const lineHeight = Math.round(fontSize * 1.7);
    const overlap = Math.round(lineHeight / 2);
    const expectedStep = Math.max(lineHeight, height - overlap);
    const before = scrollArea.scrollTop;
    forward.click();
    return new Promise((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          resolve({
            before,
            after: scrollArea.scrollTop,
            expectedStep,
            scrollHeight: scrollArea.scrollHeight,
            height,
          });
        });
      });
    });
  });

  const delta = result.after - result.before;
  expect(result.scrollHeight).toBeGreaterThan(result.height + 50);
  expect(Math.abs(delta - result.expectedStep)).toBeLessThanOrEqual(2);
});
