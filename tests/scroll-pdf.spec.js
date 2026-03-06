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

test("full-mode PDF scrolls exactly one viewport height per click", async ({ page }) => {
  await loadTestPdf(page);

  const result = await page.evaluate(() => {
    const scrollArea = document.getElementById("scrollArea");
    const forward = document.getElementById("unlockZone");
    scrollArea.scrollTop = 0;
    const height = scrollArea.clientHeight;
    const before = scrollArea.scrollTop;
    forward.click();
    return new Promise((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          resolve({
            before,
            after: scrollArea.scrollTop,
            height,
            scrollHeight: scrollArea.scrollHeight,
          });
        });
      });
    });
  });

  const delta = result.after - result.before;
  expect(result.scrollHeight).toBeGreaterThan(result.height + 50);
  expect(Math.abs(delta - result.height)).toBeLessThanOrEqual(2);
});

test("full-mode PDF scroll emits exact-scroll logs", async ({ page }) => {
  const logs = [];
  page.on("console", (msg) => {
    const text = msg.text();
    if (text.includes("[Rowing Reader] exact-scroll")) {
      logs.push(text);
    }
  });

  await loadTestPdf(page);

  await page.evaluate(() => {
    const scrollArea = document.getElementById("scrollArea");
    scrollArea.scrollTop = 0;
    document.getElementById("unlockZone").click();
  });

  await expect.poll(() => logs.length).toBeGreaterThanOrEqual(2);

  const startLog = logs.find((line) => line.includes("exact-scroll start"));
  const endLog = logs.find((line) => line.includes("exact-scroll end"));
  expect(startLog).toBeTruthy();
  expect(endLog).toBeTruthy();

  // We only require that the start/end log lines are emitted; payload format may vary by browser.
});
