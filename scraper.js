// scraper.js — yalnız D (Tracking) dolu və E "çatdı" DEYİL olanlar gəlir
const fetch = require('node-fetch');
const puppeteer = require('puppeteer');
const UA = require('random-useragent');
const fs = require('fs');
const path = require('path');

/** Sənin dəyərlərin */
const WEBAPP_URL = 'https://script.google.com/macros/s/AKfycbwO09UI9cMA2Gj2NIAQAkUCgEb0x3U9E5xaUBQApvuTn-nIs9Ip1DyMlRSXjgC12YCV/exec';
const SECRET     = 'AKfycbzArtHCNqjQA';

/** Selektorlar */
const PAGE_URL   = 'https://page.cainiao.com/guoguo/app-myexpress-taobao/search-express.html';
const INPUT_SEL  = 'body > div > div.search > input[type=text]';
const BUTTON_SEL = 'body > div > div.btn';
const STATUS_CANDIDATES = [
  'div.package-status', '.package-status', '.cp-info_detail .package-status',
  '.cp-info .package-status', '.cp-info .status', '.result', '.status', '.topStatus', '.title'
];

/** Taymaut/performans */
const NAV_TIMEOUT_MS         = 20000;
const WAIT_INPUT_TIMEOUT_MS  = 12000;
const WAIT_BTN_TIMEOUT_MS    = 8000;
const PER_TRACKING_MAX_MS    = 15000;  // sürətli
const STATUS_POLL_INTERVAL   = 800;
const CONCURRENCY            = 3;      // paralel 3
const BETWEEN_JOBS_SLEEP_MS  = 0;      // filtrləmədə əlavə gecikmə YOXDUR

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

function cnToAzStatus(textCN) {
  const t = (textCN || '').toString().trim();
  if (!t) return 'hazırlanır';
  if (/未查询到|暂无|没有相关|无法查询/.test(t)) return 'problem';
  if (/[已|签]签收|妥投|签收/.test(t)) return 'çatdı (received)';
  if (/派送中|投递|派件/.test(t))       return 'çatdırılmada';
  if (/运输中|在途|到达|转运|已发出/.test(t)) return 'yoldadır (in transit)';
  if (/待揽收|已揽收|收寄|揽收成功/.test(t)) return 'hazırlanır';
  const tl = t.toLowerCase();
  if (tl.includes('delivered') || tl.includes('received') || tl.includes('signed')) return 'çatdı (received)';
  if (tl.includes('out for delivery')) return 'çatdırılmada';
  if (tl.includes('transit') || tl.includes('arrived')) return 'yoldadır (in transit)';
  if (tl.includes('pickup') || tl.includes('accept') || tl.includes('preparing')) return 'hazırlanır';
  if (tl.includes('exception') || tl.includes('failed')) return 'problem';
  return 'yoldadır (in transit)';
}

async function saveDebug(page, name) {
  try {
    const dir = path.join(process.cwd(), 'debug');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
    await page.screenshot({ path: path.join(dir, `${name}.png`), fullPage: true }).catch(()=>{});
    const html = await page.content().catch(()=> '');
    if (html) fs.writeFileSync(path.join(dir, `${name}.html`), html, 'utf8');
  } catch {}
}

async function getTrackingList() {
  const url = `${WEBAPP_URL}?secret=${encodeURIComponent(SECRET)}`;
  const res = await fetch(url, { method: 'GET' });
  const js  = await res.json();
  if (!js.ok) throw new Error('WebApp doGet error: ' + (js.error || 'unknown'));
  // Gələn obyektlər artıq D&E əsaslı filtrlənib: [{tracking, status}]
  return (js.items || []).map(r => String(r.tracking || '').trim()).filter(Boolean);
}

async function postResult(tracking, status) {
  await fetch(WEBAPP_URL, {
    method: 'POST',
    headers: { 'Content-Type':'application/json' },
    body: JSON.stringify({ secret: SECRET, tracking, status })
  }).catch(()=>{});
}

async function hardClick(page, selector) {
  try { await page.$eval(selector, el => { el.scrollIntoView({block:'center'}); el.click(); }); } catch(_) {}
  try {
    const el = await page.$(selector);
    if (el) {
      const box = await el.boundingBox();
      if (box) {
        await page.mouse.move(box.x + box.width/2, box.y + box.height/2);
        await page.mouse.down(); await page.mouse.up();
      }
    }
  } catch(_) {}
}

async function findStatusInPageAndFrames(page) {
  const evalFn = (cands) => {
    const has = (s)=>!!(s && /已签收|派送中|运输中|已揽收|问题件|在途|投递|揽收|收寄|未查询到|暂无|没有相关|无法查询/i.test(String(s)));
    const probe = (root, sels)=>{
      for (const sel of sels) {
        const el = root.querySelector?.(sel);
        if (el && el.innerText && el.innerText.trim()) return el.innerText.trim();
      }
      const txt = root.innerText || '';
      if (has(txt)) {
        const hit = txt.split(/\n+/).map(s=>s.trim()).find(has);
        if (hit) return hit;
      }
      return '';
    };
    let v = probe(document, cands);
    if (v) return v;
    for (const f of document.querySelectorAll('iframe')) {
      try {
        const doc = f.contentDocument || f.contentWindow?.document;
        if (!doc) continue;
        v = probe(doc, cands);
        if (v) return v;
      } catch {}
    }
    return '';
  };
  try { const v = await page.evaluate(evalFn, STATUS_CANDIDATES); if (v) return v; } catch {}
  for (const fr of page.frames()) {
    try { const v = await fr.evaluate(evalFn, STATUS_CANDIDATES); if (v) return v; } catch {}
  }
  return '';
}

async function scrapeOne(browser, tracking) {
  const page = await browser.newPage();
  try {
    const ua = UA.getRandom() || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';
    await page.setUserAgent(ua);
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' });
    await page.setViewport({ width: 1280, height: 900 });
    page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
    page.setDefaultTimeout(NAV_TIMEOUT_MS);

    await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });

    await page.waitForSelector(INPUT_SEL, { visible: true, timeout: WAIT_INPUT_TIMEOUT_MS });
    await page.click(INPUT_SEL).catch(()=>{});
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el) { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); }
    }, INPUT_SEL);
    await page.type(INPUT_SEL, tracking, { delay: 20 });

    await page.waitForSelector(BUTTON_SEL, { visible: true, timeout: WAIT_BTN_TIMEOUT_MS });
    await hardClick(page, BUTTON_SEL);

    let statusCN = '';
    const start = Date.now();
    while (!statusCN && Date.now() - start < PER_TRACKING_MAX_MS) {
      statusCN = await findStatusInPageAndFrames(page);
      if (statusCN) break;
      await sleep(STATUS_POLL_INTERVAL);
    }

    if (!statusCN) {
      await saveDebug(page, `${tracking}_nostatus`);
      return { statusAZ: 'problem' };
    }

    return { statusAZ: cnToAzStatus(statusCN) };
  } catch (e) {
    await saveDebug(page, `${tracking}_error`);
    return { statusAZ: 'problem' };
  } finally {
    try { await page.close(); } catch {}
  }
}

async function main() {
  const list = await getTrackingList(); // artıq D&E filtrli gəlir
  if (!list.length) { console.log('Yoxlanacaq kod yoxdur.'); return; }

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-gpu','--disable-dev-shm-usage','--no-zygote','--single-process','--window-size=1280,900']
  });

  const queue = [...list];
  const worker = async () => {
    while (queue.length) {
      const tr = queue.shift();
      const res = await Promise.race([
        scrapeOne(browser, tr),
        (async ()=>{ await sleep(PER_TRACKING_MAX_MS+4000); return { statusAZ:'problem' }; })()
      ]);
      await postResult(tr, res.statusAZ);
      if (BETWEEN_JOBS_SLEEP_MS) await sleep(BETWEEN_JOBS_SLEEP_MS);
    }
  };
  await Promise.all(Array(Math.min(CONCURRENCY, queue.length)).fill(0).map(worker));
  await browser.close();
}

if (require.main === module) {
  main().catch(err => { console.error('FATAL:', err); process.exit(1); });
}
