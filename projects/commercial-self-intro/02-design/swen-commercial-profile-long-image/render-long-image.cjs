const { chromium } = require("playwright");

async function main() {
  const [url, output] = process.argv.slice(2);
  if (!url || !output) {
    throw new Error("Usage: node render-long-image.cjs <url> <output.png>");
  }

  const browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CHROME_PATH ||
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  });
  try {
    const context = await browser.newContext({
      viewport: { width: 1080, height: 1200 },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    const consoleErrors = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => consoleErrors.push(error.message));

    await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all(
        Array.from(document.images).map((image) => {
          if (image.complete) return Promise.resolve();
          return new Promise((resolve, reject) => {
            image.addEventListener("load", resolve, { once: true });
            image.addEventListener("error", reject, { once: true });
          });
        }),
      );
    });

    const diagnostics = await page.evaluate(() => {
      const images = Array.from(document.images).map((image) => ({
        src: image.getAttribute("src"),
        width: image.naturalWidth,
        height: image.naturalHeight,
      }));
      const overflow = Array.from(document.querySelectorAll("*"))
        .filter((element) => element.scrollWidth > element.clientWidth + 1)
        .slice(0, 20)
        .map((element) => ({
          tag: element.tagName,
          className: element.className,
          clientWidth: element.clientWidth,
          scrollWidth: element.scrollWidth,
        }));
      return {
        bodyWidth: document.body.scrollWidth,
        pageHeight: document.documentElement.scrollHeight,
        imageCount: images.length,
        brokenImages: images.filter((image) => image.width === 0),
        overflow,
      };
    });

    if (diagnostics.bodyWidth !== 1080) {
      throw new Error(`Unexpected page width: ${diagnostics.bodyWidth}`);
    }
    if (diagnostics.brokenImages.length > 0) {
      throw new Error(`Broken images: ${JSON.stringify(diagnostics.brokenImages)}`);
    }
    if (diagnostics.overflow.length > 0) {
      throw new Error(`Overflow detected: ${JSON.stringify(diagnostics.overflow)}`);
    }
    if (consoleErrors.length > 0) {
      throw new Error(`Browser errors: ${JSON.stringify(consoleErrors)}`);
    }

    await page.screenshot({ path: output, fullPage: true, type: "png" });
    console.log(JSON.stringify({ ...diagnostics, consoleErrors, output }, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
