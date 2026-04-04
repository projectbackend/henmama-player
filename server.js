const express = require('express');
const puppeteer = require('puppeteer');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3001;
const API_KEY = process.env.API_KEY || 'secret';
const WORKER_URL = (process.env.CF_WORKER_URL || 'https://henmama.andhikarafi321.workers.dev/').replace(/\/$/, '');

app.use((req, res, next) => {
  if (req.headers['x-api-key'] !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

let browser = null;

async function getBrowser() {
  if (!browser || !browser.connected) {
    browser = await puppeteer.launch({
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote', '--single-process'],
    });
  }
  return browser;
}

function fetchViaWorker(url) {
  return new Promise((resolve, reject) => {
    const proxyUrl = `${WORKER_URL}?url=${encodeURIComponent(url)}`;
    https.get(proxyUrl, { timeout: 15000 }, r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => resolve(d));
    }).on('error', reject);
  });
}

app.get('/player', async (req, res) => {
  const { postId, epUrl } = req.query;
  if (!postId || !epUrl) return res.status(400).json({ error: 'postId and epUrl required' });

  let page = null;
  try {
    const b = await getBrowser();
    page = await b.newPage();

    // Route only non-essential resources via Worker to save bandwidth
    await page.setRequestInterception(true);
    let playerData = null;

    page.on('request', r => {
      const url = r.url();
      const type = r.resourceType();
      // Block heavy resources
      if (['image', 'font', 'media', 'stylesheet'].includes(type)) return r.abort();
      if (url.startsWith('data:') || url.startsWith('about:') || url.startsWith('blob:')) return r.continue();
      // Let admin-ajax go directly — routing via Worker breaks WordPress session
      if (url.includes('admin-ajax')) return r.continue();
      // Block ads/trackers
      if (url.includes('juicyads') || url.includes('adserver') || url.includes('magsrv') || url.includes('twinrd')) return r.abort();
      r.continue();
    });

    page.on('response', async response => {
      const url = response.url();
      if (!url.includes('admin-ajax')) return;
      try {
        const text = await response.text();
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed) && parsed.length > 0) {
          playerData = parsed;
          console.log(`[player] Got player data for ${postId}!`);
        }
      } catch(e) {}
    });

    // Navigate directly to the episode page so WordPress session/cookies work properly
    await page.goto(epUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});

    // Wait for jQuery AJAX to fire automatically
    await new Promise(r => setTimeout(r, 5000));

    if (!playerData) {
      console.log(`[player] No data after page load, trying manual trigger for ${postId}`);
      try {
        await page.evaluate((pid) => {
          if (typeof jQuery !== 'undefined') {
            jQuery.post('/wp-admin/admin-ajax.php', { action: 'get_player_contents', a: pid });
          }
        }, postId);
        await new Promise(r => setTimeout(r, 4000));
      } catch(e) {}
    }

    if (!playerData) return res.status(404).json({ error: 'No player data' });

    const iframeSrcs = playerData.slice(0, 2).map(html => {
      const m = html.match(/src=["']([^"']*hentaimama\.io\/new[^"']+)["']/i);
      return m ? m[1].replace(/\\\//g, '/') : null;
    }).filter(Boolean);

    if (iframeSrcs.length === 0) return res.status(404).json({ error: 'No iframe found' });

    const srcs = [];
    for (let i = 0; i < iframeSrcs.length; i++) {
      try {
        const playerHtml = await fetchViaWorker(iframeSrcs[i].replace('https://', 'http://'));
        const mp4 = playerHtml.match(/file\s*:\s*["']([^"']+)["']/i) ||
                    playerHtml.match(/["'](https?:\/\/[^"'\s]+\.mp4[^"'\s]*)["']/i);
        if (mp4) srcs.push({ option: i + 1, src: mp4[1], type: 'mp4' });
      } catch(e) {}
    }

    if (srcs.length === 0) return res.status(404).json({ error: 'No MP4 found' });
    res.json({ success: true, srcs });
  } catch(err) {
    res.status(500).json({ error: err.message });
  } finally {
    if (page) await page.close().catch(() => {});
  }
});

app.get('/health', (_, res) => res.json({ ok: true }));
app.listen(PORT, () => console.log(`Player service on port ${PORT}`));
process.on('SIGTERM', async () => { if (browser) await browser.close(); process.exit(0); });
