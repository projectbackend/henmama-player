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

// Sniff: goto worker URL directly, intercept admin-ajax
app.get('/sniff', async (req, res) => {
  const { epUrl, postId } = req.query;
  if (!epUrl) return res.status(400).json({ error: 'epUrl required' });

  let page = null;
  const captured = { requests: [], responses: [], pageTitle: '' };

  try {
    const b = await getBrowser();
    page = await b.newPage();
    await page.setRequestInterception(true);

    page.on('request', r => {
      const url = r.url();
      const type = r.resourceType();
      if (['image', 'font', 'stylesheet', 'media'].includes(type)) return r.abort();
      if (/juicyads|adserver|magsrv|twinrd|disqus/.test(url)) return r.abort();

      // Log interesting requests
      if (url.includes('admin-ajax') || url.includes('new2.php') || url.includes('gdvid') || url.includes('javprovider')) {
        captured.requests.push({ url: url.slice(0, 200), method: r.method(), postData: r.postData() });
      }

      // Already going to worker — let it through
      if (url.includes('workers.dev')) return r.continue().catch(() => r.abort());

      // Route hentaimama requests via worker
      if (url.includes('hentaimama.io')) {
        const wUrl = `${WORKER_URL}?url=${encodeURIComponent(url.replace('https://', 'http://'))}`;
        return r.continue({ url: wUrl }).catch(() => r.abort());
      }
      r.continue().catch(() => r.abort());
    });

    page.on('response', async response => {
      const url = response.url();
      if (url.includes('admin-ajax') || url.includes('new2.php') || url.includes('gdvid') || url.includes('javprovider') || url.includes('workers.dev')) {
        try {
          const text = await response.text();
          captured.responses.push({ url: url.slice(0, 150), status: response.status(), body: text.slice(0, 500) });
        } catch(e) {}
      }
    });

    // Fetch HTML via worker, inject <base> tag so relative URLs resolve to hentaimama.io
    const epHtml = await fetchViaWorker(epUrl.replace('https://', 'http://'));
    captured.htmlLength = epHtml.length;
    const htmlWithBase = epHtml.replace('<head>', '<head><base href="http://hentaimama.io/">');

    // Use evaluate to write HTML directly — avoids setContent timeout issues
    await page.evaluate((html) => {
      document.open(); document.write(html); document.close();
    }, htmlWithBase).catch(() => {});
    // Give page time to stabilize after setContent
    await new Promise(r => setTimeout(r, 1000));

    captured.pageTitle = await page.title().catch(() => '');
    captured.pageUrl = page.url();

    // Wait for scripts to load
    await new Promise(r => setTimeout(r, 2000));

    // Inject jQuery if not loaded, then manually trigger AJAX
    // Extract postId from HTML if not provided
    const pid = postId || epHtml.match(/a:\s*['"](\d+)['"]/)?.[1] || '';
    captured.postId = pid;

    const ajaxResult = await page.evaluate(async (pid, workerUrl) => {
      // Inject jQuery if missing
      if (typeof jQuery === 'undefined') {
        await new Promise((resolve) => {
          const s = document.createElement('script');
          s.src = 'https://code.jquery.com/jquery-3.7.1.min.js';
          s.onload = resolve;
          s.onerror = resolve;
          document.head.appendChild(s);
        });
      }
      if (typeof jQuery === 'undefined') return { error: 'jQuery not available' };

      return new Promise((resolve) => {
        jQuery.post(
          workerUrl + '?url=' + encodeURIComponent('http://hentaimama.io/wp-admin/admin-ajax.php'),
          { action: 'get_player_contents', a: pid },
          (data) => resolve({ data: typeof data === 'string' ? data : JSON.stringify(data) })
        ).fail((xhr) => resolve({ error: xhr.status + ' ' + xhr.responseText?.slice(0, 100) }));        setTimeout(() => resolve({ timeout: true }), 8000);
      });
    }, pid, WORKER_URL).catch(e => ({ error: e.message }));

    captured.ajaxResult = ajaxResult;

    // Wait for any auto-fired AJAX
    await new Promise(r => setTimeout(r, 3000));

    res.json(captured);
  } catch(e) {
    res.status(500).json({ error: e.message, captured });
  } finally {
    if (page) await page.close().catch(() => {});
  }
});

app.get('/player', async (req, res) => {
  const { postId, epUrl } = req.query;
  if (!postId || !epUrl) return res.status(400).json({ error: 'postId and epUrl required' });

  let page = null;
  try {
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
      if (url.includes('admin-ajax') || url.includes('hentaimama.io')) {
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

    await page.setContent(epHtml, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await page.evaluate((url) => { try { history.replaceState({}, '', url); } catch(e) {} }, epUrl).catch(() => {});
    await new Promise(r => setTimeout(r, 4000));

    if (!playerData) {
      try {
        const result = await page.evaluate(async (pid, workerUrl) => {
          if (typeof jQuery !== 'undefined') {
            return new Promise((resolve) => {
              jQuery.post(workerUrl + '?url=' + encodeURIComponent('http://hentaimama.io/wp-admin/admin-ajax.php'),
                { action: 'get_player_contents', a: pid },
                (data) => resolve(data)
              );
              setTimeout(() => resolve(null), 5000);
            });
          }
          const r = await fetch(workerUrl + '?url=' + encodeURIComponent('http://hentaimama.io/wp-admin/admin-ajax.php'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' },
            body: `action=get_player_contents&a=${pid}`
          });
          return r.text();
        }, postId, WORKER_URL);

        if (result) {
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
