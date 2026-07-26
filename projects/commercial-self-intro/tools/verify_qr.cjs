#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const { chromium } = require("playwright");

async function main() {
  const imagePath = path.resolve(
    process.argv[2] ||
      path.join(
        __dirname,
        "..",
        "03-deliverables",
        "swen-commercial-profile-long-image-1080x7736.png",
      ),
  );
  if (!fs.existsSync(imagePath)) {
    throw new Error(`Image does not exist: ${imagePath}`);
  }
  const jsQrPath = path.join(__dirname, "vendor", "jsqr-1.4.0", "jsQR.js");
  if (!fs.existsSync(jsQrPath)) {
    throw new Error(`Bundled jsQR decoder does not exist: ${jsQrPath}`);
  }

  const browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CHROME_PATH ||
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  });
  try {
    const page = await browser.newPage();
    await page.goto(pathToFileURL(imagePath).href, {
      waitUntil: "load",
      timeout: 30000,
    });
    await page.addScriptTag({ path: jsQrPath });
    const result = await page.evaluate(async () => {
      const image = document.querySelector("img");
      await image.decode();
      const width = image.naturalWidth;
      const height = image.naturalHeight;
      const sliceHeight = Math.min(1600, height);
      const overlap = 240;
      const step = Math.max(1, sliceHeight - overlap);
      const canvas = document.createElement("canvas");
      canvas.width = width;

      for (let y = 0; y < height; y += step) {
        const currentHeight = Math.min(sliceHeight, height - y);
        canvas.height = currentHeight;
        const context = canvas.getContext("2d", {
          alpha: false,
          willReadFrequently: true,
        });
        context.drawImage(
          image,
          0,
          y,
          width,
          currentHeight,
          0,
          0,
          width,
          currentHeight,
        );
        const pixels = context.getImageData(0, 0, width, currentHeight);
        const code = globalThis.jsQR(pixels.data, width, currentHeight, {
          inversionAttempts: "attemptBoth",
        });
        if (code) {
          return {
            values: [code.data],
            slice: { y, height: currentHeight },
          };
        }
        if (y + currentHeight >= height) break;
      }
      return { values: [] };
    });

    if (result.values.length === 0) {
      throw new Error("No QR code was decoded");
    }
    console.log(`qr_count=${result.values.length}`);
    for (const value of result.values) console.log(`qr_value=${value}`);
    console.log(`qr_slice_y=${result.slice.y}`);
    console.log("qr_decode=PASS");
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(`qr_decode=FAIL: ${error.message}`);
  process.exit(1);
});
