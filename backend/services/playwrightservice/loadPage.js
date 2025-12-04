const { chromium } = require("playwright");

async function loadPage(url) {
  console.log(`🔗 Connecting to user Chrome session (port 9222): ${url}`);

  let browser = null;
  try {
    // Connect to user's running Chrome with remote debugging
    browser = await chromium.connectOverCDP("http://localhost:9222");

    // Use user's authenticated Chrome context
    const context = browser.contexts()[0];
    const page = await context.newPage();

    // Stealth patches (safe)
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
      Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
      window.chrome = { runtime: {} };
      Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });

      const originalQuery = window.navigator.permissions.query;
      window.navigator.permissions.query = (parameters) =>
        parameters.name === "notifications"
          ? Promise.resolve({ state: Notification.permission })
          : originalQuery(parameters);
    });

    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });
    await page.waitForTimeout(2000);

    console.log("✅ Connected to authenticated user session!");
    return page; // Very important — do NOT close browser

  } catch (error) {
    console.log("❌ ERROR in loadPage:", error.message);

    // ❗ FIX: Remove browser.disconnect() — Playwright doesn't support it
    // Instead, we safely close context ONLY if needed
    try {
      if (browser) {
        console.log("🔌 Closing Playwright context only (not Chrome)");
        const ctx = browser.contexts()[0];
        if (ctx) await ctx.close().catch(() => {});
      }
    } catch (e) {
      // Ignore cleanup errors
    }

    // Special error message for missing debug Chrome
    if (error.message.includes("could not connect") || error.message.includes("9222")) {
      throw new Error(
        "❌ Chrome is NOT running in debugging mode.\n" +
        "Start Chrome first:\n" +
        `"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9222 --user-data-dir="C:\\Users\\HP\\temp\\chrome-session"`
      );
    }

    throw error;
  }
}

module.exports = { loadPage };
