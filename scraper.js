// scraper.js (GitHub Actions / lokal üçün)
const fetch = require('node-fetch');              // npm i node-fetch@2
const puppeteer = require('puppeteer');           // npm i puppeteer
const UA = require('random-useragent');           // npm i random-useragent
const fs = require('fs');
const path = require('path');

/** ───────────── SƏNİN VERDİYİN DƏYƏRLƏR ───────────── **/
const WEBAPP_URL = 'https://script.google.com/macros/s/AKfycbwO09UI9cMA2Gj2NIAQAkUCgEb0x3U9E5xaUBQApvuTn-nIs9Ip1DyMlRSXjgC12YCV/exec';
const SECRET     = 'AKfycbzArtHCNqjQA';
/** ─────────────────────────────────────────────────── **/

// Səhifə və selector-lər
const PAGE_URL   = 'https://page.cainiao.com/guoguo/app-myexpress-taobao/search-express.html';
const INPUT_SEL  = 'body > div > div.search > input[type=text]';
const BUTTON_SEL = 'body > div > div.btn';

// Nəticə üçün mümkün selector-lər
const STATUS_CANDIDATES = [
  'div.package-status',
  '.package-status',
  '.cp-info_detail .package-status',
  '.cp-info .package-status',
  '.cp-info .status',
  '.result', '.status', '.topStatus', '.title'
];

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

function cnToAzStatus(textCN) {
  const t = (textCN || '').toString().trim();
  if (!t) return 'hazırlanır';
  if (/未查询到|暂无|没有相关|无法查询/.test(t)) return 'problem';
  if (/[已|签]签收|妥投|签收/.test(t))         return 'çatdı (received)';
  if (/派送中|投递|派件/.test(t))               return 'çatdırılmada';
  if (/运输中|在途|到达|转运|已发出/.test(t))   return 'yoldadır (in transit)';
  if (/待揽收|已揽收|收寄|揽收成功/.test(t))   return 'hazırlanır';
  if (/异常|问题件|退回|失败|无法派送/.test(t)) return 'problem';
  const tl = t.toLowerCase();
  if (tl.includes('delivered') || tl.includes('received') || tl.includes('signed')) return 'çatdı (received)';
  if (tl.includes('out for delivery')) return 'çatdırılmada';
  if (tl.includes('transit') || tl.includes('arrived')) return 'yoldadır (in transit)';
  if (tl.includes('pickup') || tl.includes('accept') || tl.includes('preparing')) return 'hazırlanır';
  if (tl.includes('exception') || tl.includes('failed')) return 'problem';
  return 'yoldadır (in transit)';
}

async function getTrackingList() {
  const url = `${WEBAPP_URL}?secret=${encodeURIComponent(SECRET)}`;
  const res = await fetch(url, { method: 'GET' });
  const text = await res.text();
  let js; try { js = JSON.parse(text); } catch { throw new Error('WebApp cavabı JSON deyil: ' + text.slice(0,200)); }
  if (!js.ok) throw new Error('WebApp doGet error: ' + (js.error || 'unknown'));
  return js.items || [];
}

async function postResult(tracking, status) {
  await fetch(WEBAPP_URL, {
    method: 'POST',
    headers: { 'Content-Type':'application/json' },
    body: JSON.stringify({ secret: SECRET, tracking, status })
  });
}

async function saveDebug(page, name) {
  const dir = path.join(process.cwd(), 'debug');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  try { await page.screenshot({ path: path.join(dir, `${name}.png`), fullPage: true }); } catch {}
  try { const html = await page.content(); fs.writeFileSync(path.join(dir, `${name}.html`), html, 'utf8'); } catch {}
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
    const hasStatusWords = (s) => !!(s && /已签收|派送中|运输中|已揽收|问题件|在途|投递|揽收|收寄|未查询到|暂无|没有相关|无法查询/i.test(String(s)));
    const findInShadow = (root, selectors) => {
      for (const sel of selectors) {
        const el = root.querySelector?.(sel);
        if (el && el.innerText && el.innerText.trim()) return el.innerText.trim();
      }
      const text = root.innerText || '';
      if (hasStatusWords(text)) {
        const hit = text.split(/\n+/).map(s=>s.trim()).find(hasStatusWords);
        if (hit) return hit;
      }
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null);
      let node;
      while ((node = walker.nextNode())) {
        const txt = node.innerText;
        if (txt && hasStatusWords(txt)) {
          const hit = txt.split(/\n+/).map(s=>s.trim()).find(hasStatusWords);
          if (hit) return hit;
        }
        if (node.shadowRoot) {
          const sub = findInShadow(node.shadowRoot, selectors);
          if (sub) return sub;
        }
      }
      return '';
    };
    let val = findInShadow(document, cands);
    if (val) return val;
    const iframes = document.querySelectorAll('iframe');
    for (const f of iframes) {
      try {
        const doc = f.contentDocument || f.contentWindow?.document;
        if (doc) {
          val = findInShadow(doc, cands);
          if (val) return val;
        }
      } catch(_) {}
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

    await page.goto(PAGE_URL, { waitUntil: 'networkidle2', timeout: 60000 });

    try {
      await page.evaluate(() => {
        const ok = [...document.querySelectorAll('button,.btn,[role="button"]')]
          .find(b => /同意|接受|继续|确定|知道了|OK|Accept|Agree/.test((b.textContent||'').trim()));
        if (ok) ok.click();
      });
    } catch {}

    await page.waitForSelector(INPUT_SEL, { visible: true, timeout: 30000 });
    await page.click(INPUT_SEL);
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el) { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); }
    }, INPUT_SEL);
    await page.type(INPUT_SEL, tracking, { delay: 25 });

    await page.waitForSelector(BUTTON_SEL, { visible: true, timeout: 15000 });
    await hardClick(page, BUTTON_SEL);
    try { await page.keyboard.press('Enter'); } catch {}
    console.log(`➡️  ${tracking} üçün düyməyə basıldı`);

    let statusCN = '';
    const start = Date.now();
    while (!statusCN && Date.now() - start < 60000) {
      await sleep(1200);
      statusCN = await findStatusInPageAndFrames(page);
      if (!statusCN) { try { await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 2500 }); } catch {} }
    }

    if (!statusCN) {
      await saveDebug(page, `${tracking}_nostatus`);
      await page.close();
      return { statusAZ: 'problem', statusCN: '' };
    }

    const statusAZ = cnToAzStatus(statusCN);
    await page.close();
    return { statusAZ, statusCN };
  } catch (e) {
    console.error(`❌ ${tracking} üçün səhv: ${e.message}`);
    try { await saveDebug(page, `${tracking}_error`); } catch {}
    try { await page.close(); } catch {}
    return { statusAZ: 'problem', statusCN: '' };
  }
}

async function main() {
  const list = await getTrackingList();
  if (!list.length) { console.log('Heç bir izləmə kodu tapılmadı.'); return; }

  const browser = await puppeteer.launch({
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-gpu',
    '--disable-dev-shm-usage']
  });

  for (const tr of list) {
    console.log('Yoxlanır:', tr);
    const { statusAZ } = await scrapeOne(browser, tr);
    console.log(' →', statusAZ);
    await postResult(tr, statusAZ);
    await sleep(1500 + Math.floor(Math.random()*1200));
  }

  await browser.close();
}

if (require.main === module) {
  main().catch(err => { console.error('FATAL:', err); process.exit(1); });
}
