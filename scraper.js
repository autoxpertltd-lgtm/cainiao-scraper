// scraper.js — Sequential, per-row POST, 60s timeout, genişləndirilmiş "çatdı" regex
const fetch = require('node-fetch');              // npm i node-fetch@2
const puppeteer = require('puppeteer');           // npm i puppeteer
const UA = require('random-useragent');           // npm i random-useragent
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
  'div.package-status','.package-status','.cp-info_detail .package-status',
  '.cp-info .package-status','.cp-info .status','.result','.status','.topStatus','.title'
];

/** Taymaut/performans parametrləri */
const NAV_TIMEOUT_MS        = 20000;
const WAIT_INPUT_TIMEOUT_MS = 15000;
const WAIT_BTN_TIMEOUT_MS   = 10000;
const PER_TRACKING_MAX_MS   = 60000;   // 60s — gec yüklənənlər üçün
const STATUS_POLL_INTERVAL  = 1000;    // 1s
const CONCURRENCY           = 1;       // ardıcıl, sətir-sətir

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

function cnToAzStatus(textCN) {
  const t = (textCN || '').toString().trim();
  if (!t) return 'hazırlanır';
  // ÇATDI / DELIVERED (genişləndirilmiş)
  if (
    /签收|签收成功|成功签收|签收完成|妥投|妥投成功|已送达|投递成功|派送成功|包裹已送达/.test(t) ||
    /\b(delivered|received|signed|delivered\s*successfully)\b/i.test(t)
  ) return 'çatdı (received)';
  // ÇATDIRILMADA
  if (/派送中|投递|派件/.test(t) || /out\s*for\s*delivery/i.test(t)) return 'çatdırılmada';
  // YOLDADIR
  if (/运输中|在途|到达|转运|已发出|已发货/.test(t) || /(in\s*transit|arrived)/i.test(t)) return 'yoldadır (in transit)';
  // HAZIRLANIR
  if (/待揽收|已揽收|收寄|揽收成功|揽收/.test(t) || /(pickup|accept|preparing)/i.test(t)) return 'hazırlanır';
  // PROBLEM / TAPILMADI
  if (/异常|问题件|退回|失败|无法派送|未查询到|暂无|没有相关|无法查询/.test(t) || /exception|failed|not\s*found/i.test(t)) return 'problem';
  return 'yoldadır (in transit)';
}

/** Debug (problem/nostatus üçün screenshot + HTML) */
async function saveDebug(page, name) {
  try {
    const dir = path.join(process.cwd(), 'debug');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
    await page.screenshot({ path: path.join(dir, `${name}.png`), fullPage: true }).catch(()=>{});
    const html = await page.content().catch(()=> '');
    if (html) fs.writeFileSync(path.join(dir, `${name}.html`), html, 'utf8');
  } catch {}
}

/** GET: server yalnız D dolu & E “çatdı” olmayanları qaytarır */
async function getTrackingList() {
  const res = await fetch(`${WEBAPP_URL}?secret=${encodeURIComponent(SECRET)}`);
  const js  = await res.json();
  if (!js.ok) throw new Error('WebApp doGet error: ' + (js.error || 'unknown'));
  return (js.items || []).map(r => String((r && r.tracking) ? r.tracking : r).trim()).filter(Boolean);
}

/** POST: nəticəni dərhal geri yaz */
async function postResult(tracking, status) {
  await fetch(WEBAPP_URL, {
    method: 'POST',
    headers: { 'Content-Type':'application/json' },
    body: JSON.stringify({ secret: SECRET, tracking, status })
  }).catch(()=>{});
}

/** Klik yardımçısı */
async function hardClick(page, selector) {
  try { await page.$eval(selector, el => { el.scrollIntoView({block:'center'}); el.click(); }); } catch(_) {}
  try {
    const el = await page.$(selector); if (!el) return;
    const box = await el.boundingBox(); if (!box) return;
    await page.mouse.move(box.x+box.width/2, box.y+box.height/2);
    await page.mouse.down(); await page.mouse.up();
  } catch(_) {}
}

/** Səhifə + iframelərdən status mətni çıxar */
async function findStatusInPageAndFrames(page) {
  const evalFn = (cands) => {
    const has = (s)=>!!(s && /已签收|签收成功|签收完成|妥投|已送达|投递成功|派送成功|派送中|运输中|在途|已揽收|问题件|未查询到|暂无|无法查询/i.test(String(s)));
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
    let v = probe(document, cands); if (v) return v;
    for (const f of document.querySelectorAll('iframe')) {
      try {
        const doc = f.contentDocument || f.contentWindow?.document;
        if (!doc) continue; v = probe(doc, cands); if (v) return v;
      } catch {}
    }
    return '';
  };
  try { const v = await page.evaluate(evalFn, STATUS_CANDIDATES); if (v) return v; } catch {}
  for (const fr of page.frames()) { try { const v = await fr.evaluate(evalFn, STATUS_CANDIDATES); if (v) return v; } catch {} }
  return '';
}

/** Bir izləmə kodunu yoxla (klik sonrası navigation + yüklənmə gözləməsi) */
async function scrapeOnce(browser, tracking) {
  const page = await browser.newPage();
  try {
    const ua = UA.getRandom() || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';
    await page.setUserAgent(ua);
    await page.setExtraHTTPHeaders({ 'Accept-Language':'zh-CN,zh;q=0.9,en;q=0.8' });
    await page.setViewport({ width:1280, height:900 });
    page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
    page.setDefaultTimeout(NAV_TIMEOUT_MS);

    await page.goto(PAGE_URL, { waitUntil:'domcontentloaded', timeout:NAV_TIMEOUT_MS });

    await page.waitForSelector(INPUT_SEL, { visible:true, timeout:WAIT_INPUT_TIMEOUT_MS });
    await page.click(INPUT_SEL).catch(()=>{});
    await page.evaluate((sel)=>{ const el=document.querySelector(sel); if(el){ el.value=''; el.dispatchEvent(new Event('input',{bubbles:true})); } }, INPUT_SEL);
    await page.type(INPUT_SEL, tracking, { delay:20 });

    await page.waitForSelector(BUTTON_SEL, { visible:true, timeout:WAIT_BTN_TIMEOUT_MS });
    await hardClick(page, BUTTON_SEL);

    // Yüklənmə üçün navigation + qısa fasilə
    try { await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }); } catch {}
    await sleep(1500);

    let statusCN = '';
    const start = Date.now();
    while (!statusCN && Date.now() - start < PER_TRACKING_MAX_MS) {
      statusCN = await findStatusInPageAndFrames(page);
      if (statusCN) break;
      await sleep(STATUS_POLL_INTERVAL);
    }

    if (!statusCN) { await saveDebug(page, `${tracking}_nostatus`); return { statusAZ:'problem' }; }
    return { statusAZ: cnToAzStatus(statusCN) };
  } catch (e) {
    await saveDebug(page, `${tracking}_error`);
    return { statusAZ:'problem' };
  } finally {
    try { await page.close(); } catch {}
  }
}

/** 2 dəfə retry-li wrapper */
async function scrapeWithRetry(browser, tracking) {
  try { return await scrapeOnce(browser, tracking); }
  catch { await sleep(1200); try { return await scrapeOnce(browser, tracking); } catch { return { statusAZ:'problem' }; } }
}

/** Main — Sətir-sətir yoxla və dərhal yaz */
async function main() {
  const list = await getTrackingList();
  if (!list.length) { console.log('Yoxlanacaq kod yoxdur.'); return; }

  const browser = await puppeteer.launch({
    headless:'new',
    args:[
      '--no-sandbox','--disable-setuid-sandbox','--disable-gpu',
      '--disable-dev-shm-usage','--no-zygote','--single-process',
      '--window-size=1280,900'
    ]
  });

  for (const tr of list) {
    console.log('Yoxlanır:', tr);
    const res = await Promise.race([
      scrapeWithRetry(browser, tr),
      (async ()=>{ await sleep(PER_TRACKING_MAX_MS + 5000); return { statusAZ:'problem' }; })()
    ]);
    console.log(' →', tr, '⇒', res.statusAZ);
    await postResult(tr, res.statusAZ);   // HƏR SƏTRƏ DƏRHAL YAZ
  }

  await browser.close();
}

if (require.main === module) {
  main().catch(err => { console.error('FATAL:', err); process.exit(1); });
}
