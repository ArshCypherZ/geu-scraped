const puppeteer = require('puppeteer');
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');

// Global browser instance to reuse
let globalBrowser = null;

// Concurrency limits
const MAX_CONCURRENT_PAGES = 5;
const MAX_CONCURRENT_DOWNLOADS = 10;

// Semaphore class for concurrency control
class Semaphore {
  constructor(permits) {
    this.permits = permits;
    this.waiting = [];
  }

  async acquire() {
    if (this.permits > 0) {
      this.permits--;
      return;
    }
    
    return new Promise(resolve => {
      this.waiting.push(resolve);
    });
  }

  release() {
    this.permits++;
    if (this.waiting.length > 0) {
      const next = this.waiting.shift();
      this.permits--;
      next();
    }
  }
}

const pageSemaphore = new Semaphore(MAX_CONCURRENT_PAGES);
const downloadSemaphore = new Semaphore(MAX_CONCURRENT_DOWNLOADS);

async function getBrowser() {
  if (!globalBrowser) {
    globalBrowser = await puppeteer.launch({
      headless: "new",
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
  }
  return globalBrowser;
}

// Download documents concurrently
async function downloadDocument(link) {
  await downloadSemaphore.acquire();
  try {
    console.log(`Downloading document: ${link}`);
    const response = await axios({
      method: 'GET',
      url: link,
      responseType: 'arraybuffer',
      timeout: 30000
    });
    // Extract file extension from link (default to .bin if not found)
    let ext = path.extname(link.split('?')[0]).toLowerCase();
    if (!ext || ext.length > 6) ext = '.bin';
    // Use a safe filename with extension
    const base = link.replace(/[^a-z0-9]/gi, '_').substring(0, 100);
    const filename = base + ext;
    await fs.writeFile(path.join('scraped_content', filename), response.data);
    console.log(`Downloaded: ${filename}`);
  } catch (error) {
    console.error(`Failed to download document: ${link}`, error.message);
  } finally {
    downloadSemaphore.release();
  }
}

async function scrapeWebsite(url, visited = new Set(), baseUrl = null, urlQueue = []) {
  if (visited.has(url)) {
    return;
  }
  visited.add(url);

  // Set base URL for the first call
  if (!baseUrl) {
    try {
      const urlObj = new URL(url);
      baseUrl = urlObj.origin;
    } catch (error) {
      console.error(`Invalid URL: ${url}`);
      return;
    }
  }

  await pageSemaphore.acquire();
  
  try {
    console.log(`Scraping: ${url} (${visited.size} pages visited, ${urlQueue.length} in queue)`);

    const browser = await getBrowser();
    const page = await browser.newPage();
    
    await page.setDefaultNavigationTimeout(30000);
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
    
    await new Promise(resolve => setTimeout(resolve, 200));
    
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });

    // Extract text content
    const textContent = await page.evaluate(() => {
      return document.body.innerText;
    });

    // Save text content to file
    const filename = url.replace(/[^a-z0-9]/gi, '_').substring(0, 100) + '.txt';
    const saveTextPromise = fs.writeFile(path.join('scraped_content', filename), textContent);

    // Find document links
    const documentLinks = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a[href]'));
      return links
        .map(link => link.href)
        .filter(href => {
          return !href.startsWith('#') && !href.startsWith('javascript:');
        })
        .filter(href => {
          const fileExtensions = ['.pdf', '.docx', '.doc', '.xls', '.xlsx', '.csv', '.txt', '.zip', '.rar', '.pptx', '.ppt'];
          return fileExtensions.some(ext => href.toLowerCase().endsWith(ext));
        });
    });

    // Find subpage links
    const subpageLinks = await page.evaluate((baseOrigin) => {
      const links = Array.from(document.querySelectorAll('a[href]'));
      return links
        .map(link => {
          try {
            // Handle relative URLs
            if (link.href.startsWith('/')) {
              return baseOrigin + link.href;
            }
            return link.href;
          } catch (e) {
            return null;
          }
        })
        .filter(href => href && href.startsWith(baseOrigin))
        .filter(href => href !== window.location.href)
        .filter(href => !href.includes('#'))
        .filter(href => !href.includes('javascript:'))
        .filter(href => !href.includes('mailto:'))
        .filter(href => !href.includes('tel:'));
    }, baseUrl);

    await page.close();

    await saveTextPromise;
    const downloadPromises = documentLinks.map(link => downloadDocument(link));

    const newSubpages = subpageLinks.filter(link => !visited.has(link));
    urlQueue.push(...newSubpages);
    await Promise.allSettled(downloadPromises);

  } catch (error) {
    console.error(`Failed to scrape: ${url}`, error.message);
  } finally {
    pageSemaphore.release();
  }
}

async function processUrlQueue(visited, baseUrl) {
  const urlQueue = ['https://geu.ac.in/'];
  const activePromises = new Set();

  while (urlQueue.length > 0 || activePromises.size > 0) {
    while (urlQueue.length > 0 && activePromises.size < MAX_CONCURRENT_PAGES) {
      const url = urlQueue.shift();
      if (!visited.has(url)) {
        const promise = scrapeWebsite(url, visited, baseUrl, urlQueue)
          .finally(() => activePromises.delete(promise));
        activePromises.add(promise);
      }
    }

    if (activePromises.size > 0) {
      await Promise.race(activePromises);
    }
  }
}

(async () => {
  try {
    await fs.mkdir('scraped_content', { recursive: true });
  } catch (error) {
  }

  console.log('Starting web scraping...');
  
  try {
    const visited = new Set();
    await processUrlQueue(visited);
    console.log('Scraping completed successfully!');
    console.log(`Total pages scraped: ${visited.size}`);
  } catch (error) {
    console.error('Scraping failed:', error);
  } finally {
    if (globalBrowser) {
      await globalBrowser.close();
    }
    console.log('Browser closed. Exiting...');
    process.exit(0);
  }
})();
