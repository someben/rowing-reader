const { defineConfig } = require("@playwright/test");

const port = Number.parseInt(process.env.PLAYWRIGHT_PORT || "8125", 10);
const baseURL = `http://127.0.0.1:${port}`;

module.exports = defineConfig({
  testDir: "./tests",
  timeout: 60_000,
  use: {
    baseURL,
    headless: true,
  },
  webServer: {
    command: `python -m http.server ${port} --directory src`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
