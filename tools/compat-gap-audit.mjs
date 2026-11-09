/**
 * compat-gap-audit.mjs —— 老内核 flex gap 兜底的等价性审计
 *
 * 背景：Android 8.x 的 WebView 常见 Chrome 6x/7x 内核，flex 的 gap 要 84+ 才有。
 * index.html / tv.html 里有 `@supports not (gap: ...)` 兜底块，用 margin 模拟间距。
 * 「选择器写了没有」挡不住写错：margin 给错方向、值跟 gap 对不上、换行容器缺行间距、
 * 首个子元素被 display:none 时多出缩进 —— 这四类只有量几何才看得见。
 *
 * 做法（不解析整份 CSS，避免自写解析器出错）：
 *   1) 用真实 Chrome 打开页面，在两个视口（1200 / 400）读出每个容器的
 *      computed gap / flex-direction / flex-wrap —— 这就是真值，含媒体查询。
 *   2) 用真值造 fixtures：A = 真 gap，B = gap:0 + 原兜底规则；各 3 个子元素。
 *   3) 量相邻子元素间距、首项缩进；再把首项设为 display:none 量一次。
 *      任何一项差 >= 0.6px 即 FAIL。
 *
 * 用法：node tools/compat-gap-audit.mjs [--json]
 * 退出码：0 全通过，1 有 FAIL。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const ASSETS = path.join(REPO, 'android', 'app', 'src', 'main', 'assets');
const FILES = ['index.html', 'tv.html'];
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PLAYWRIGHT = path.join(process.env.USERPROFILE || '', '.dsh-browser', 'runtime', 'node_modules');
const VIEWPORTS = [1200, 400];
const TOL = 0.6;
const asJson = process.argv.includes('--json');
const strict = process.argv.includes('--strict');

/* ---------------- 只解析兜底块 ---------------- */
function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '');
}

function styleText(html) {
  const out = [];
  const re = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  let m;
  while ((m = re.exec(html))) out.push(m[1]);
  return stripComments(out.join('\n'));
}

/** 取 @supports <含 condFragment> 的块体，按花括号配对 */
function supportsBlock(css, condFragment) {
  const idx = css.indexOf(condFragment);
  if (idx < 0) return null;
  const open = css.indexOf('{', idx);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') {
      depth--;
      if (!depth) return { cond: css.slice(idx, open).trim(), body: css.slice(open + 1, i) };
    }
  }
  return null;
}

/** 把块体拆成 {selector, decls, media}，支持块内嵌套 @media；用花括号计数，不依赖正则 */
function parseBlock(body, media = '', out = []) {
  let i = 0;
  while (i < body.length) {
    const brace = body.indexOf('{', i);
    if (brace < 0) break;
    const selector = body.slice(i, brace).trim();
    let depth = 0;
    let end = -1;
    for (let j = brace; j < body.length; j++) {
      if (body[j] === '{') depth++;
      else if (body[j] === '}') { depth--; if (!depth) { end = j; break; } }
    }
    if (end < 0) break;
    const inner = body.slice(brace + 1, end);
    if (selector.startsWith('@media')) {
      parseBlock(inner, selector, out);
    } else if (selector.startsWith('@supports')) {
      parseBlock(inner, media, out);   // 兜底块的嵌套 @supports 直接展开
    } else if (selector) {
      out.push({ selector, decls: inner.trim(), media });
    }
    i = end + 1;
  }
  return out;
}

/** 某个媒体条件在给定视口宽度下是否生效 */
function mediaMatches(cond, vw) {
  if (!cond) return true;
  const min = cond.match(/min-width\s*:\s*([\d.]+)px/);
  const max = cond.match(/max-width\s*:\s*([\d.]+)px/);
  if (min && vw < parseFloat(min[1])) return false;
  if (max && vw > parseFloat(max[1])) return false;
  return true;
}

function classify(rules) {
  const out = [];
  for (const r of rules) {
    for (const sel of r.selector.split(',').map((s) => s.trim()).filter(Boolean)) {
      const plusSibling = />\s*\*\s*\+\s*\*/.test(sel);
      // 容器 = 去掉末尾 `> 子元素选择器`（`> *`、`> * + *`、`> *:not(...)` 等）
      let container = sel.trim();
      const plusTail = container.match(/^(.*?)\s*>\s*\*\s*\+\s*\*$/);
      if (plusTail) container = plusTail[1].trim();
      else {
        const tail = container.match(/^(.*?)\s*>\s*([^\s>]+)$/);
        if (tail && /[*:]/.test(tail[2])) container = tail[1].trim();
      }
      const d = r.decls;
      out.push({
        selector: sel, container, media: r.media || '', plusSibling,
        ml: /margin-left\s*:/.test(d), mt: /margin-top\s*:/.test(d),
        mr: /margin-right\s*:/.test(d), mb: /margin-bottom\s*:/.test(d),
        shorthand: /(^|;|\s)margin\s*:/.test(d), decls: d,
      });
    }
  }
  return out;
}

/* ---------------- fixture ---------------- */
function suffixIds(sel, suffix) {
  return sel.replace(/#([\w-]+)/g, (_, id) => `#${id}-${suffix}`);
}

function chainHtml(container, suffix) {
  const parts = container.split(/\s*>\s*/).flatMap((p) => p.split(/\s+/)).filter(Boolean);
  let open = '';
  const tags = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const tag = (part.match(/^([a-z][a-z0-9]*)/i) || [, 'div'])[1];
    const id = (part.match(/#([\w-]+)/) || [, ''])[1];
    const classes = [...part.matchAll(/\.([\w-]+)/g)].map((m) => m[1]);
    const idAttr = id ? ` id="${id}-${suffix}"` : '';
    const clsAttr = classes.length ? ` class="${classes.join(' ')}"` : '';
    const fxAttr = i === parts.length - 1 ? ` data-fx="${suffix}"` : '';
    open += `<${tag}${idAttr}${clsAttr}${fxAttr}>`;
    tags.push(tag);
  }
  return open + '<div class="k"></div><div class="k"></div><div class="k"></div>' + tags.map(() => '</div>').join('');
}

function pageHtml(cases, rootFs) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  html{font-size:${rootFs || 16}px}html,body{margin:0;padding:0}body{font-size:16px}
  .casehost{margin:0 0 6px}
  .k{width:40px;height:40px;background:#444;flex:0 0 auto}
  ${cases.map((c) => c.css).join('\n')}
  </style></head><body>${cases.map((c) => `<div class="casehost">${c.html}</div>`).join('')}</body></html>`;
}

/* ---------------- 主流程 ---------------- */
const require2 = createRequire(path.join(PLAYWRIGHT, 'noop.js'));
const { chromium } = require2('playwright-core');

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });

const results = [];
for (const file of FILES) {
  const filePath = path.join(ASSETS, file);
  const html = fs.readFileSync(filePath, 'utf8');
  const css = styleText(html);
  const gapBlock = supportsBlock(css, '@supports not (gap');
  if (!gapBlock) { results.push({ file, error: '没有 gap 兜底块' }); continue; }
  const fb = classify(parseBlock(gapBlock.body));
  const containers = [...new Set(fb.map((f) => f.container).filter(Boolean))];

  // 1) 真实页面读真值
  const truths = [];
  for (const vw of VIEWPORTS) {
    await page.setViewportSize({ width: vw, height: 900 });
    await page.goto(pathToFileURL(filePath).href, { waitUntil: 'load' });
    const got = await page.evaluate((cs) => {
      const rootFs = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      return cs.map((c) => {
        let el = null;
        try { el = document.querySelector(c); } catch (e) { return { container: c, missing: true, rootFs }; }
        if (!el) return { container: c, missing: true, rootFs };
        const s = getComputedStyle(el);
        return {
          container: c, missing: false, rootFs,
          gap: s.gap || s.rowGap, dir: s.flexDirection, wrap: s.flexWrap, display: s.display,
          justify: s.justifyContent, align: s.alignItems,
        };
      });
    }, containers);
    for (const g of got) truths.push({ vw, ...g });
  }

  const byContainer = new Map();
  for (const t of truths) {
    if (!byContainer.has(t.container)) byContainer.set(t.container, []);
    byContainer.get(t.container).push(t);
  }

  // 2) 造 fixtures
  const cases = [];
  const skipped = [];
  for (const container of containers) {
    const seen = new Set();
    for (const t of byContainer.get(container) || []) {
      if (t.missing) { skipped.push(container); continue; }
      const gap = String(t.gap || '').split(' ')[0];
      if (!gap || gap === 'normal' || gap === '0px') continue;
      const key = `${gap}|${t.wrap}|${t.dir}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const id = `c${cases.length}`;
      const isWrap = String(t.wrap || '') === 'wrap';
      const wbox = isWrap ? 'width:120px;' : 'width:400px;';
      const common = `display:flex;${wbox}flex-direction:${t.dir};${isWrap ? 'flex-wrap:wrap;' : 'flex-wrap:nowrap;'}justify-content:${t.justify || 'normal'};align-items:${t.align || 'normal'};`;
      const selA = suffixIds(container, `${id}a`);
      const selB = suffixIds(container, `${id}b`);
      // 只取在该视口下生效的兜底规则（含块内嵌套 @media 的断点镜像）
      const fbVw = fb.filter((f) => f.container === container && mediaMatches(f.media, t.vw));
      const fbSel = fbVw.map((f) => suffixIds(f.selector, `${id}b`)).join(',');
      const decl = fbVw.map((f) => f.decls).join(';');
      cases.push({
        id, container, vw: t.vw, rootFs: t.rootFs, kind: isWrap ? 'wrap' : (/column/.test(t.dir) ? 'column' : 'row'),
        reverse: /reverse/.test(t.dir),
        gap, problems: [],
        css: `${selA}{${common}gap:${gap}}\n${selB}{${common}gap:0}\n${fbSel}{${decl}}`,
        html: chainHtml(container, `${id}a`) + chainHtml(container, `${id}b`),
      });
    }
  }
  // 3) 结构判据
  for (const c of cases) {
    const f = fb.filter((x) => x.container === c.container);
    const twoWay = f.some((x) => x.shorthand || (x.mr && (x.mb || x.mt)));
    if (c.kind === 'wrap') {
      if (f.some((x) => x.plusSibling)) c.problems.push('wrap 容器用了 `> * + *`（换行行首会多缩进）');
      if (!twoWay) c.problems.push('wrap 容器缺双向 margin（右+下）');
    } else if (c.kind === 'column') {
      if (f.some((x) => x.ml) && !f.some((x) => x.mt)) c.problems.push('竖排补了 margin-left，应为 margin-top');
    } else if (f.some((x) => x.mt) && !f.some((x) => x.ml)) {
      c.problems.push('横排补了 margin-top，应为 margin-left');
    }
  }

  // 4) 量几何（每个视口一次）
  const measured = [];
  for (const vw of [...new Set(cases.map((c) => c.vw))]) {
    const list = cases.filter((c) => c.vw === vw);
    await page.setViewportSize({ width: vw, height: 900 });
    await page.setContent(pageHtml(list, list[0] && list[0].rootFs), { waitUntil: 'load' });
    const part = await page.evaluate((cs) => {
      const snap = (host) => {
        const box = host.getBoundingClientRect();
        return [...host.querySelectorAll(':scope > .k')].map((k) => {
          if (getComputedStyle(k).display === 'none') return { hidden: true };
          const r = k.getBoundingClientRect();
          return { x: +(r.left - box.left).toFixed(2), y: +(r.top - box.top).toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2) };
        });
      };
      return cs.map((c) => {
        const out = { ...c, variants: {} };
        for (const st of ['a', 'b']) {
          const host = document.querySelector(`[data-fx="${c.id}${st}"]`);
          if (host) out.variants[st] = snap(host);
        }
        for (const st of ['a', 'b']) {
          const host = document.querySelector(`[data-fx="${c.id}${st}"]`);
          const first = host && host.querySelector(':scope > .k');
          if (first) first.style.display = 'none';
        }
        for (const st of ['a', 'b']) {
          const host = document.querySelector(`[data-fx="${c.id}${st}"]`);
          if (host) out.variants[st + '_h'] = snap(host);
        }
        return out;
      });
    }, list);
    measured.push(...part);
  }

  for (const m of measured) {
    const fails = [];
    const latent = [];
    const cmp = (ka, kb, tag, isLatent) => {
      const A = m.variants[ka] || [], B = m.variants[kb] || [];
      const sink = isLatent ? latent : fails;
      if (!A.length && !B.length) { sink.push(`${tag}没量到子元素`); return; }
      const vis = (arr) => arr.filter((v) => v && !v.hidden);
      let va = vis(A), vb = vis(B);
      if (va.length !== vb.length) { sink.push(`${tag}可见子元素数不同 ${va.length}/${vb.length}`); return; }
      // 反向轴（column-reverse / row-reverse）按屏幕位置排序，间距才有意义
      if (m.reverse) {
        const col = m.kind === 'column';
        const by = (p) => (col ? p.y : p.x);
        va = va.slice().sort((a, b) => by(a) - by(b));
        vb = vb.slice().sort((a, b) => by(a) - by(b));
      }
      if (!m.reverse) {
        for (const k of ['x', 'y']) {
          if (Math.abs((va[0]?.[k] || 0) - (vb[0]?.[k] || 0)) >= TOL) {
            sink.push(`${tag}首项 ${k} 缩进 ${va[0][k]} vs 兜底 ${vb[0][k]}`);
          }
        }
      }
      for (let j = 1; j < va.length; j++) {
        const dx = va[j].x - (va[j - 1].x + va[j - 1].w), dx2 = vb[j].x - (vb[j - 1].x + vb[j - 1].w);
        const dy = va[j].y - (va[j - 1].y + va[j - 1].h), dy2 = vb[j].y - (vb[j - 1].y + vb[j - 1].h);
        if (Math.abs(dx - dx2) >= TOL) sink.push(`${tag}第${j + 1}项横向间距 ${+dx.toFixed(2)} vs 兜底 ${+dx2.toFixed(2)}`);
        if (Math.abs(dy - dy2) >= TOL) sink.push(`${tag}第${j + 1}项纵向间距 ${+dy.toFixed(2)} vs 兜底 ${+dy2.toFixed(2)}`);
      }
    };
    cmp('a', 'b', '', false);
    // `> * + *` 的固有缺陷：只有首个子元素被 display:none 时才现形。
    // 单独记成 latent，默认不计失败；--strict 时升级为失败。
    cmp('a_h', 'b_h', '首项隐藏后 ', true);
    m.fails = fails;
    m.latent = latent;
    m.ok = fails.length === 0 && m.problems.length === 0 && (!strict || latent.length === 0);
  }

  results.push({ file, cond: gapBlock.cond, containers: containers.length, skipped: [...new Set(skipped)], cases: measured });
}

await browser.close();

if (asJson) {
  console.log(JSON.stringify(results, null, 2));
} else {
  let totalFail = 0;
  let totalLatent = 0;
  for (const r of results) {
    if (r.error) { console.log(`\n== ${r.file} ==  ${r.error}`); totalFail++; continue; }
    const bad = r.cases.filter((c) => !c.ok);
    const lat = r.cases.filter((c) => (c.latent || []).length && c.ok !== undefined);
    totalFail += bad.length;
    totalLatent += lat.length;
    console.log(`\n== ${r.file} ==  ${r.cond}`);
    console.log(`   兜底容器 ${r.containers} 个；可量 ${r.cases.length} 个（按视口/取值展开）；失败 ${bad.length} 个；潜在 ${lat.length} 个`);
    if (r.skipped.length) console.log(`   运行态才有、静态 DOM 里不存在，本轮未量：${r.skipped.join(' ')}`);
    for (const c of bad) {
      console.log(`  ✗ ${c.container}  [${c.kind} gap=${c.gap} @${c.vw}px]`);
      for (const p of c.problems) console.log(`      结构：${p}`);
      for (const f of c.fails) console.log(`      行为：${f}`);
    }
    for (const c of lat) {
      console.log(`  ~ ${c.container}  [${c.kind} gap=${c.gap} @${c.vw}px] 首项隐藏才现形`);
      for (const f of c.latent) console.log(`      潜在：${f}`);
    }
    if (!bad.length) console.log('   硬失败 0');
  }
  console.log(totalFail ? `\n合计失败 ${totalFail} 项` : `\n硬失败 0 项；潜在（首项被隐藏时才有差）${totalLatent} 项`);
  process.exit(totalFail ? 1 : 0);
}
