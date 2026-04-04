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
    // Fetch HTML via worker (bypasses SSL/IP issues from Railway)
    const epHtml = await fetchViaWorker(epUrl.replace('https://', 'http://'));

    const b = await getBrowser();
    page = await b.newPage();
    await page.setRequestInterception(true);
    let playerData = null;

    page.on('request', intercepted => {
      const url = intercepted.url();
      const type = intercepted.resourceType();
      if (['image', 'font', 'media', 'stylesheet'].includes(type)) return intercepted.abort();
      if (url.startsWith('data:') || url.startsWith('blob:')) return intercepted.continue();
      if (/juicyads|adserver|magsrv|twinrd|disqus|googlesyndication/.test(url)) return intercepted.abort();
      // Already going to worker — let through
      if (url.includes('workers.dev')) return intercepted.continue().catch(() => intercepted.abort());
      // Route hentaimama requests via worker
      if (url.includes('hentaimama.io') || url.includes('admin-ajax')) {
        const workerUrl = `${WORKER_URL}?url=${encodeURIComponent(url.replace('https://', 'http://'))}`;
        return intercepted.continue({ url: workerUrl }).catch(() => intercepted.abort());
      }
      intercepted.continue().catch(() => intercepted.abort());
    });

    page.on('response', async response => {
      const url = response.url();
      if (!url.includes('admin-ajax') && !url.includes('workers.dev')) return;
      try {
        const text = await response.text();
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed) && parsed.length > 0) {
          playerData = parsed;
          console.log(`[player] Got player data for ${postId}!`);
        }
      } catch(e) {}
    });

    // Strip external scripts, inject jQuery CDN + base tag to avoid setContent timeout
    const htmlCleaned = epHtml
      .replace('<head>', `<head><base href="http://hentaimama.io/"><script src="https://code.jquery.com/jquery-3.7.1.min.js"></script>`)
      .replace(/<script[^>]+src=["'][^"']*["'][^>]*><\/script>/gi, '');

    await page.setContent(htmlCleaned, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 4000));

    if (!playerData) {
      console.log(`[player] No auto AJAX, trying manual trigger for ${postId}`);
      try {
        const result = await page.evaluate(async (pid, workerUrl) => {
          if (typeof jQuery === 'undefined') return { error: 'no jQuery' };
          return new Promise((resolve) => {
            jQuery.post(
              `${workerUrl}?url=${encodeURIComponent('http://hentaimama.io/wp-admin/admin-ajax.php')}`,
              { action: 'get_player_contents', a: pid },
              (data) => resolve(data)
            ).fail(() => resolve(null));
            setTimeout(() => resolve(null), 6000);
          });
        }, postId, WORKER_URL);

        if (result && result !== '0') {
          try {
            const parsed = typeof result === 'string' ? JSON.parse(result) : result;
            if (Array.isArray(parsed) && parsed.length > 0) playerData = parsed;
          } catch(e) {}
        }
      } catch(e) { console.log('[player] Manual trigger error:', e.message); }
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
