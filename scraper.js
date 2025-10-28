// scraper.js — SKİP LOJİKASI: boş tracking və "çatdı/received/delivered" olanlar yoxlanmır
const fetch = require('node-fetch');              // npm i node-fetch@2
const puppeteer = require('puppeteer');           // npm i puppeteer
const UA = require('random-useragent');           // npm i random-useragent
const fs = require('fs');
const path = require('path');

/** Sənin dəyərlərin */
const WEBAPP_URL = 'https://script.google.com/macros/s/AKfycbwO09UI9cMA2Gj2NIAQAkUCgEb0x3U9E5xaUBQApvuTn-nIs9Ip1DyMlRSXjgC12YCV/exec';
const SECRET     = 'AKfycbzArtHCNqjQA';

/** Səhifə və selektorlar */
const PAGE_URL   = 'https://page.cainiao.com/guoguo/app-myexpress-taobao/search-express.html';
const INPUT_SEL  = 'body > div > div.search > input[type=text]';
const BUTTON_SEL = 'body > div > div.btn';

const STATUS_CANDIDATES = [
  'div.package-status',
  '.package-status',
  '.cp-info_detail .package-status',
  '.cp-info .package-status',
  '.cp-info .status',
  '.result', '.status', '.topStatus', '.title'
];

/** Parametrlər */
const NAV_TIMEOUT_MS         = 20000;
const WAIT_INPUT_TIMEOUT_MS  = 15000;
const WAIT_BTN_TIMEOUT_MS    = 10000;
const PER_TRACKING_MAX_MS    = 30000;   // 30s
const STATUS_POLL_INTERVAL   = 1200;
const BETWEEN_JOBS_SLEEP_MS  = 600;
const CONCURRENCY            = 2;       // paralel 2

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

/** Debug faylları */
async function saveDebug(page, name, note='') {
  try {
    const dir = path.join(process.cwd(), 'debug');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
    const png = path.join(dir, `${name}.png`);
    const html = path.join(dir, `${name}.html`);
    await page.screenshot({ path: png, fullPage: true }).catch(()=>{});
    const content = await page.content().catch(()=> '');
    if (content) fs.writeFileSync(html, content, 'utf8');
    console.log(`🧩 Debug saved: ${png} / ${html}${note ? ' — '+note : ''}`);
  } catch (e) {
    console.log('⚠️ Debug save failed:', e.message);
  }
}

/** WebApp: GET siyahı (string və ya obyekt ola bilər) */
async function getTrackingList() {
  const url = `${WEBAPP_URL}?secret=${encodeURIComponent(SECRET)}`;
  console.log('STEP0: GET list →', url.replace(/secret=[^&]+/,'secret=***'));
  const res = await fetch(url, { method: 'GET' });
  const text = await res.text();
  let js; try { js = JSON.parse(text); } catch(e) {
    console.error('❌ WebApp JSON deyil:', text.slice(0,200));
    throw e;
  }
  if (!js.ok) throw new Error('WebApp doGet error: ' + (js.error || 'unknown'));
  const raw = js.items || [];

  // Həm köhnə (["code","code2"]) formatı, həm də yeni ([{tracking,status}, ...]) üçün normalize edək:
  const normalized = raw.map(item => {
    if (typeof item === 'string') return { tracking: item.trim(), status: '' };
    // Gözlənilən sahələr: tracking, status (shipping status sütunu)
    return {
      tracking: (item.tracking || item.code || '').toString().trim(),
      status: (item.status || item.shippingStatus || '').toString().trim()
    };
  });

  console.log('STEP0: list len =', normalized.length);
  return normalized;
}

/** Yoxlamaq lazımdırmı? (izləmə kodu boşdursa və ya artıq çatdısa → SKIP) */
function shouldProcess(rec) {
  const tr = (rec.tracking || '').trim();
  if (!tr) return false; // izləmə kodu boş — yoxlama
  const s = (rec.status || '').toLowerCase();

  if (!s) return true; // status boş — yoxla

  // “çatdı/received/delivered/signed” açar sözlərinə görə SKIP
  const skipWords = [
    'çatdı', 'received', 'delivered', 'signed',
    '签收', '已签收', '妥投' // CN varyantları
  ];
  if (skipWords.some(w => s.includes(w))) return false;

  return true;
}

async function postResult(tracking, status) {
  console.log(`STEP5: POST result → ${tracking}: ${status}`);
  await fetch(WEBAPP_URL, {
    method: 'POST',
    headers: { 'Content-Type':'application/json' },
    body: JSON.stringify({ secret: SECRET, tracking, status })
  }).then(r=>r.text()).then(t=>{
    console.log('STEP5: POST resp (first 120):', String(t).slice(0,120));
  }).catch(e=>{
    console.log('STEP5: POST failed:', e.message);
  });
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

  try {
    const v = await page.evaluate(evalFn, STATUS_CANDIDATES);
    if (v) return v;
  } catch {}

  for (const fr of page.frames()) {
    try {
      const v = await fr.evaluate(evalFn, STATUS_CANDIDATES);
      if (v) return v;
    } catch {}
  }
  return '';
}

async function scrapeOne(browser, tracking) {
  const started = Date.now();
  const page = await browser.newPage();
  const dbgPrefix = tracking.replace(/[^0-9A-Za-z_-]/g,'').slice(0,30) || 'trk';

  try {
    const ua = UA.getRandom() || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';
    await page.setUserAgent(ua);
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' });
    await page.setViewport({ width: 1280, height: 900 });
    page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
    page.setDefaultTimeout(NAV_TIMEOUT_MS);

    await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS })
      .catch(async e => { await saveDebug(page, `${dbgPrefix}_goto_err`, e.message); throw e; });

    try {
      await page.evaluate(() => {
        const ok = [...document.querySelectorAll('button,.btn,[role="button"]')]
          .find(b => /同意|接受|继续|确定|知道了|OK|Accept|Agree/.test((b.textContent||'').trim()));
        if (ok) ok.click();
      });
    } catch {}

    await page.waitForSelector(INPUT_SEL, { visible: true, timeout: WAIT_INPUT_TIMEOUT_MS })
      .catch(async e => { await saveDebug(page, `${dbgPrefix}_no_input`, e.message); throw e; });

    await page.click(INPUT_SEL).catch(()=>{});
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el) { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); }
    }, INPUT_SEL);
    await page.type(INPUT_SEL, tracking, { delay: 25 });

    await page.waitForSelector(BUTTON_SEL, { visible: true, timeout: WAIT_BTN_TIMEOUT_MS })
      .catch(async e => { await saveDebug(page, `${dbgPrefix}_no_btn`, e.message); throw e; });
    await hardClick(page, BUTTON_SEL);
    try { await page.keyboard.press('Enter'); } catch {}

    let statusCN = '';
    while (!statusCN && (Date.now() - started) < PER_TRACKING_MAX_MS) {
      statusCN = await findStatusInPageAndFrames(page);
      if (statusCN) break;
      await sleep(STATUS_POLL_INTERVAL);
    }

    if (!statusCN) {
      await saveDebug(page, `${dbgPrefix}_nostatus`, 'timeout polling');
      return { statusAZ: 'problem', statusCN: '' };
    }

    const statusAZ = cnToAzStatus(statusCN);
    return { statusAZ, statusCN };
  } catch (e) {
    console.error(`❌ ${tracking} səhv: ${e.message}`);
    await saveDebug(page, `${dbgPrefix}_error_final`, e.message);
    return { statusAZ: 'problem', statusCN: '' };
  } finally {
    try { await page.close(); } catch {}
  }
}

async function main() {
  console.log('=== RUN START ===');

  // 1) Siyahını al və SKIP filtri tətbiq et
  const fullList = await getTrackingList(); // [{tracking, status}, ...]
  const toProcess = fullList.filter(shouldProcess);

  console.log(`Siyahı: ${fullList.length} sətir | Yoxlanacaq: ${toProcess.length} sətir`);
  const skipped = fullList.length - toProcess.length;
  if (skipped > 0) console.log(`SKIP: ${skipped} sətir (boş tracking və ya artıq "çatdı/received/delivered")`);

  if (!toProcess.length) { console.log('Yoxlanacaq kod yoxdur.'); return; }

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-zygote',
      '--single-process',
      '--window-size=1280,900'
    ]
  });

  // 2) Paralel işləmə
  const queue = [...toProcess];
  const runOne = async ({ tracking }) => {
    console.log('——— Yoxlanır:', tracking, '———');
    const started = Date.now();
    const res = await Promise.race([
      scrapeOne(browser, tracking),
      (async ()=>{ await sleep(PER_TRACKING_MAX_MS + 5000); throw new Error('per-tracking hard timeout'); })()
    ]).catch(e => {
      console.log('⏳ TIMEOUT per tracking:', tracking, e.message);
      return { statusAZ: 'problem', statusCN: '' };
    });
    console.log(` → Nəticə: ${tracking} ⇒ ${res.statusAZ} (took ${Date.now()-started} ms)`);
    await postResult(tracking, res.statusAZ);
    await sleep(BETWEEN_JOBS_SLEEP_MS);
  };

  const workers = Array(Math.min(CONCURRENCY, queue.length)).fill(0).map(async () => {
    while (queue.length) {
      const rec = queue.shift();
      await runOne(rec);
    }
  });

  await Promise.all(workers);
  await browser.close();
  console.log('=== RUN END ===');
}

// CLI
if (require.main === module) {
  main().catch(err => {
    console.error('FATAL:', err);
    process.exit(1);
  });
}
