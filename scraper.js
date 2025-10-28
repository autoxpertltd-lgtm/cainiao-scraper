const fetch = require('node-fetch');
const puppeteer = require('puppeteer');
const UA = require('random-useragent');
const fs = require('fs');
const path = require('path');

const WEBAPP_URL = 'https://script.google.com/macros/s/AKfycbwO09UI9cMA2Gj2NIAQAkUCgEb0x3U9E5xaUBQApvuTn-nIs9Ip1DyMlRSXjgC12YCV/exec';
const SECRET     = 'AKfycbzArtHCNqjQA';

const PAGE_URL   = 'https://page.cainiao.com/guoguo/app-myexpress-taobao/search-express.html';
const INPUT_SEL  = 'body > div > div.search > input[type=text]';
const BUTTON_SEL = 'body > div > div.btn';
const STATUS_CANDIDATES = [
  'div.package-status','.package-status','.cp-info_detail .package-status','.cp-info .package-status',
  '.cp-info .status','.result','.status','.topStatus','.title'
];

const NAV_TIMEOUT_MS=20000, WAIT_INPUT_TIMEOUT_MS=12000, WAIT_BTN_TIMEOUT_MS=8000;
const PER_TRACKING_MAX_MS=15000, STATUS_POLL_INTERVAL=800;
const CONCURRENCY=3;

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

function cnToAzStatus(textCN) {
  const t = (textCN || '').toString().trim();
  if (!t) return 'hazırlanır';
  if (/已签收|签收成功|成功签收|妥投|妥投成功|已送达|投递成功|派送成功/.test(t) ||
      /\b(delivered|received|signed)\b/i.test(t)) return 'çatdı (received)';
  if (/派送中|投递|派件/.test(t) || /out\s*for\s*delivery/i.test(t)) return 'çatdırılmada';
  if (/运输中|在途|到达|转运|已发出|已发货/.test(t) || /(in\s*transit|arrived)/i.test(t)) return 'yoldadır (in transit)';
  if (/待揽收|已揽收|收寄|揽收成功|揽收/.test(t) || /(pickup|accept|preparing)/i.test(t)) return 'hazırlanır';
  if (/异常|问题件|退回|失败|无法派送|未查询到|暂无|没有相关|无法查询/.test(t) || /exception|failed|not\s*found/i.test(t)) return 'problem';
  return 'yoldadır (in transit)';
}

async function getTrackingList() {
  const res = await fetch(`${WEBAPP_URL}?secret=${encodeURIComponent(SECRET)}`);
  const js  = await res.json();
  if (!js.ok) throw new Error('WebApp doGet error: ' + (js.error || 'unknown'));
  // server artıq yalnız D dolu & E çatmamış sətrləri qaytarır
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
    const el = await page.$(selector); if (!el) return;
    const box = await el.boundingBox(); if (!box) return;
    await page.mouse.move(box.x+box.width/2, box.y+box.height/2);
    await page.mouse.down(); await page.mouse.up();
  } catch(_) {}
}

async function findStatusInPageAndFrames(page) {
  const evalFn = (cands) => {
    const has = (s)=>!!(s && /已签收|签收成功|妥投|已送达|投递成功|派送成功|派送中|运输中|在途|已揽收|问题件|未查询到|暂无|无法查询/i.test(String(s)));
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

async function scrapeOne(browser, tracking) {
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

    let statusCN = '', start = Date.now();
    while (!statusCN && Date.now()-start < PER_TRACKING_MAX_MS) {
      statusCN = await findStatusInPageAndFrames(page);
      if (statusCN) break;
      await sleep(STATUS_POLL_INTERVAL);
    }
    if (!statusCN) return { statusAZ:'problem' };
    return { statusAZ: cnToAzStatus(statusCN) };
  } catch {
    return { statusAZ:'problem' };
  } finally {
    try { await page.close(); } catch {}
  }
}

async function main() {
  const list = await getTrackingList();
  if (!list.length) { console.log('Yoxlanacaq kod yoxdur.'); return; }

  const browser = await puppeteer.launch({
    headless:'new',
    args:['--no-sandbox','--disable-setuid-sandbox','--disable-gpu','--disable-dev-shm-usage','--no-zygote','--single-process','--window-size=1280,900']
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
    }
  };
  await Promise.all(Array(Math.min(CONCURRENCY, queue.length)).fill(0).map(worker));
  await browser.close();
}

if (require.main === module) {
  main().catch(err => { console.error('FATAL:', err); process.exit(1); });
}
