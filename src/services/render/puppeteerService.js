import puppeteer from 'puppeteer';

class PuppeteerService {
  async renderHtmlToPng(html, outputPath, width = 1200) {
    console.log(`[PuppeteerService] Launching browser to render HTML...`);
    const browser = await puppeteer.launch({
      headless: "new",
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    try {
      const page = await browser.newPage();
      await page.setViewport({ width, height: 800 });
      await page.setContent(html, { waitUntil: 'networkidle0' });
      await page.screenshot({ path: outputPath, fullPage: true });
      console.log(`[PuppeteerService] Saved rendered screenshot to ${outputPath}`);
    } finally {
      await browser.close();
    }
  }
}

export default new PuppeteerService();
