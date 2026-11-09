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
      let child = '';   // 后代子元素选择器（没有 `>` 的写法，如 `#search .right`）
      const plusTail = container.match(/^(.*?)\s*>\s*\*\s*\+\s*\*$/);
      if (plusTail) container = plusTail[1].trim();
      else {
        const tail = container.match(/^(.*?)\s*>\s*([^\s>]+)$/);
        if (tail && /[*:]/.test(tail[2])) container = tail[1].trim();
        else if (!/>/.test(container) && /\s/.test(container.trim())) {
          // `#search .right{margin-left:3rem}`：容器是 #search，命中的是它的子元素 .right。
          // 老脚本把整条当容器，于是只量到 .right 自己的 gap=0、静默跳过，兜底等于没验。
          const parts = container.trim().split(/\s+/);
          child = parts.pop();
          container = parts.join(' ');
        }
      }
      // `html.desk X` 前缀：真值只在 html.desk 语境下成立，剥离并在 fixture 的 <html> 上加 class
      let desk = false;
      if (/^html\.desk\s+/.test(container)) {
        desk = true;
        container = container.replace(/^html\.desk\s+/, '').trim();
      }
      const d = r.decls;
      out.push({
        selector: sel, container, media: r.media || '', plusSibling, desk, child,
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

/** 兜底规则 → fixture 选择器：加 id 后缀；没有 id 的容器用 data-fx 限定，
 *  否则同一条兜底会同时命中 A（真 gap）和 B（gap:0），A 变成 gap+margin、结论假通过 */
function fixtureSelector(f, suffix, container) {
  let sel = suffixIds(f.selector, suffix);
  if (!/#[\w-]+/.test(container)) {
    sel = sel.replace(/^(\.[\w-]+)/, `$1[data-fx="${suffix}"]`);
  }
  return sel;
}

/** 容器选择器：没有 id 的容器（`.hot`、`.strip`）没法靠 id 区分 A/B，改用 data-fx 标记 */
function hostSelector(container, suffix) {
  const sel = suffixIds(container, suffix);
  if (!/#[\w-]+/.test(container)) return `${sel}[data-fx="${suffix}"]`;
  return sel;
}

function chainHtml(container, suffix, marks = {}, kidCount = 3, kidTag = 'div') {
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
  const kids = Array.from({ length: kidCount }, (_, i) => {
    const extra = (marks[i] || []).join(' ');
    return `<${kidTag} class="k${extra ? ' ' + extra : ''}"></${kidTag}>`;
  }).join('');
  return open + kids + tags.map(() => '</div>').join('');
}

function pageHtml(cases, rootFs) {
  const desk = cases.some((c) => c.desk);
  return `<!doctype html><html${desk ? ' class="desk"' : ''}><head><meta charset="utf-8"><style>
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

  // 1) 真实页面读真值：两个视口 + `html.desk` 语境
  //    运行态容器（JS 才 appendChild 的）在静态 DOM 里不存在，按选择器补一条最小骨架再量；
  //    补出来的容器单独标记 injected，报告里与“真页面就有”分开写，不当成已验证。
  async function readTruths(vw, desk) {
    await page.setViewportSize({ width: vw, height: 900 });
    await page.goto(pathToFileURL(filePath).href, { waitUntil: 'load' });
    return page.evaluate(({ cs, desk }) => {
      if (desk) document.documentElement.classList.add('desk');
      function ensure(sel) {
        let el = null;
        try { el = document.querySelector(sel); } catch (e) { return { bad: true }; }
        if (el) return { el, injected: false };
        const parts = sel.trim().split(/\s+/).filter(Boolean);
        let parent = document.body;
        let made = null;
        for (const part of parts) {
          let next = null;
          try { next = parent.querySelector(part); } catch (e) { next = null; }
          if (!next) {
            const tag = (part.match(/^([a-z][a-z0-9]*)/i) || [, 'div'])[1];
            const id = (part.match(/#([\w-]+)/) || [, ''])[1];
            const classes = [...part.matchAll(/\.([\w-]+)/g)].map((m) => m[1]);
            next = document.createElement(/^[a-z]/i.test(tag) ? tag : 'div');
            if (id) next.id = id;
            if (classes.length) next.className = classes.join(' ');
            next.setAttribute('data-probe', '1');
            parent.appendChild(next);
          }
          parent = next;
          made = next;
        }
        return { el: made, injected: true };
      }
      const rootFs = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      return cs.map((c) => {
        const r = ensure(c);
        if (r.bad || !r.el) return { container: c, missing: true, rootFs, injected: false };
        const s = getComputedStyle(r.el);
        return {
          container: c, missing: false, injected: !!r.injected, rootFs,
          gap: s.gap || s.rowGap, dir: s.flexDirection, wrap: s.flexWrap, display: s.display,
          justify: s.justifyContent, align: s.alignItems,
          // 首个子元素在真实页面里就已经 display:none 的容器：`> * + *` 会立刻露馅，
          // 这类不能只记「潜在」，必须算失败
          firstHidden: r.el.firstElementChild ? getComputedStyle(r.el.firstElementChild).display === 'none' : false,
          // 真实子元素的类名：兜底里 `#groups .grp` 这类「给某个类加 margin」的规则，
          // fixture 要照着把 class 补到同样位置的子元素上，否则量出来的间距没有意义
          kids: [...r.el.children].map((k) => k.className || ''),
        };
      });
    }, { cs: containers, desk });
  }

  const truths = [];
  for (const vw of VIEWPORTS) {
    for (const t of await readTruths(vw, false)) truths.push({ vw: String(vw), ...t });
  }
  // 兜底里带 `html.desk` 前缀的容器，真值只在 desk 语境下成立（如 #pbL/#pbR 的 px 值）
  const deskContainers = [...new Set(fb.filter((x) => x.desk).map((x) => x.container))];
  if (deskContainers.length) {
    for (const t of await readTruths(1200, true)) {
      if (deskContainers.includes(t.container)) truths.push({ vw: 'desk', ...t });
    }
  }

  const byContainer = new Map();
  for (const t of truths) {
    if (!byContainer.has(t.container)) byContainer.set(t.container, []);
    byContainer.get(t.container).push(t);
  }

  // 2) 造 fixtures
  const cases = [];
  const unmeasured = [];   // 连骨架都建不出 / 取不到 computed gap：未验证，不算通过
  const injected = [];     // 静态 DOM 没有、本轮补骨架量到的运行态容器
  const zeroGap = [];      // 真值 0：本来就不需要兜底
  for (const container of containers) {
    const seen = new Set();
    for (const t of byContainer.get(container) || []) {
      if (t.missing) { unmeasured.push(container); continue; }
      const isDesk = t.vw === 'desk';
      if (t.injected) injected.push(container);
      const gap = String(t.gap || '').split(' ')[0];
      if (!gap || gap === 'normal' || gap === '0px') { if (isDesk === false) zeroGap.push(container); continue; }
      const key = `${gap}|${t.wrap}|${t.dir}|${isDesk ? 'desk' : 'base'}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const id = `c${cases.length}`;
      const isWrap = String(t.wrap || '') === 'wrap';
      const wbox = isWrap ? 'width:120px;' : 'width:400px;';
      const common = `display:flex;${wbox}flex-direction:${t.dir};${isWrap ? 'flex-wrap:wrap;' : 'flex-wrap:nowrap;'}justify-content:${t.justify || 'normal'};align-items:${t.align || 'normal'};`;
      const selA = hostSelector(container, `${id}a`);
      const selB = hostSelector(container, `${id}b`);
      // 只取在该视口下生效的兜底规则（含块内嵌套 @media 的断点镜像）；
      // desk 语境的真值只对 `html.desk ...` 那几条兜底有效，基础规则对它不适用
      const fbVw = fb.filter((f) => f.container === container && mediaMatches(f.media, isDesk ? 1200 : t.vw) && (isDesk ? f.desk : !f.desk));
      const fbSel = fbVw.map((f) => fixtureSelector(f, `${id}b`, container)).join(',');
      const decl = fbVw.map((f) => f.decls).join(';');
      // 子元素兜底（`#groups .grp` / `#search .right` / `.hero-dots i`）要在 fixture 里补回真实结构：
      // 命中第几个子元素就只给那几个补 class；标签选择器（`i`）则把子元素换成该标签。
      const marks = {};
      let kidTag = 'div';
      for (const f of fbVw) {
        if (!f.child) continue;
        if (/^[a-z][a-z0-9]*$/i.test(f.child)) { kidTag = f.child; continue; }   // 标签选择器
        const cls = f.child.replace(/^\./, '').split(/[:.[]/)[0];
        const kids = t.kids || [];
        const hits = kids.length
          ? kids.map((k, i) => ((' ' + k + ' ').includes(' ' + cls + ' ') ? i : -1)).filter((i) => i >= 0)
          : [0, 1, 2];
        for (const i of hits) {
          if (i > 2) continue;
          marks[i] = marks[i] || [];
          if (!marks[i].includes(cls)) marks[i].push(cls);
        }
      }
      // 子元素个数按真实结构来：`#search` 只有 .left/.right 两个子元素，
      // fixture 造三个就会要求第 3 个也吃到 gap，而真实页面里根本没这一项。
      const kidCount = (t.kids && t.kids.length) ? Math.min(3, Math.max(2, t.kids.length)) : 3;
      cases.push({
        id, container, vw: t.vw, rootFs: t.rootFs, desk: isDesk,
        kind: isWrap ? 'wrap' : (/column/.test(t.dir) ? 'column' : 'row'),
        reverse: /reverse/.test(t.dir), injected: !!t.injected,
        firstHidden: !!t.firstHidden,
        gap, problems: [],
        css: `${selA}{${common}gap:${gap}}\n${selB}{${common}gap:0}\n${fbSel}{${decl}}`,
        // A 只带 `.k`：它靠真 gap 出间距，不能再吃到兜底的 class 规则；
        // B 带真实 class，让兜底规则命中同一批子元素。
        html: chainHtml(container, `${id}a`, {}, kidCount, kidTag) + chainHtml(container, `${id}b`, marks, kidCount, kidTag),
      });
    }
  }
  // 3) 结构判据
  for (const c of cases) {
    const f = fb.filter((x) => x.container === c.container && (c.desk ? x.desk : !x.desk));
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
    await page.setViewportSize({ width: vw === 'desk' ? 1200 : Number(vw), height: 900 });
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
        if (m.kind === 'wrap') {
          // 换行容器：跨行比较横向间距没有意义（x 会跳回行首，差值全是假的）。
          // 同行比横向间距；新起一行时比行首缩进 + 行距。
          const newRowA = Math.abs(va[j].y - va[j - 1].y) >= 1;
          const newRowB = Math.abs(vb[j].y - vb[j - 1].y) >= 1;
          if (newRowA !== newRowB) { sink.push(`${tag}第${j + 1}项换行位置不同（${newRowA ? '兜底先换行' : '真值先换行'}）`); continue; }
          if (newRowA) {
            if (Math.abs(va[j].x - vb[j].x) >= TOL) sink.push(`${tag}第${j + 1}项行首缩进 ${va[j].x} vs 兜底 ${vb[j].x}`);
            if (Math.abs(dy - dy2) >= TOL) sink.push(`${tag}第${j + 1}项行距 ${+dy.toFixed(2)} vs 兜底 ${+dy2.toFixed(2)}`);
          } else if (Math.abs(dx - dx2) >= TOL) {
            sink.push(`${tag}第${j + 1}项横向间距 ${+dx.toFixed(2)} vs 兜底 ${+dx2.toFixed(2)}`);
          }
          continue;
        }
        if (Math.abs(dx - dx2) >= TOL) sink.push(`${tag}第${j + 1}项横向间距 ${+dx.toFixed(2)} vs 兜底 ${+dx2.toFixed(2)}`);
        if (Math.abs(dy - dy2) >= TOL) sink.push(`${tag}第${j + 1}项纵向间距 ${+dy.toFixed(2)} vs 兜底 ${+dy2.toFixed(2)}`);
      }
    };
    cmp('a', 'b', '', false);
    // `> * + *` 的固有缺陷：只有首个子元素被 display:none 时才现形。
    // 单独记成 latent，默认不计失败；--strict 时升级为失败。
    cmp('a_h', 'b_h', '首项隐藏后 ', true);
    // 真实页面里首个子元素本来就是 display:none 的容器，这个缺陷不是“潜在”而是现在就有
    if (m.firstHidden && latent.length) {
      for (const x of latent) fails.push(x + '（真实首项已隐藏，不是潜在）');
      latent.length = 0;
    }
    m.fails = fails;
    m.latent = latent;
    m.ok = fails.length === 0 && m.problems.length === 0 && (!strict || latent.length === 0);
  }

  const uniq = (a) => [...new Set(a)];
  results.push({
    file, cond: gapBlock.cond, containers: containers.length,
    unmeasured: uniq(unmeasured), injected: uniq(injected), zeroGap: uniq(zeroGap),
    nofg: checkNofgMirror(html, fb),
    cases: measured,
  });
}

/* ---- 状态级检查：首项真会被 display:none 的那两个容器 ----
   `#pbPlay` 播放时 .i-play 隐藏、`.i-pause` 成可见首项；`#pbMute` 静音时 .i-vol 隐藏。
   `> * + *` 只看 DOM 顺序，会把间距塞给新的可见首项 —— 必须在两个状态上各量一次，
   而且要在「现代内核」与「.nofg 旧内核」两种语境下都量，结论才算数。 */
const STATE_CASES = [
  { file: 'tv.html', container: '#pbPlay', addClass: 'playing', target: '.i-pause' },
  { file: 'tv.html', container: '#pbMute', addClass: 'on', target: '.i-mute' },
];
const stateResults = [];
for (const sc of STATE_CASES) {
  const url = pathToFileURL(path.join(ASSETS, sc.file)).href;
  const read = async (nofg) => {
    await page.goto(url, { waitUntil: 'load' });
    if (nofg) await page.evaluate(() => document.documentElement.classList.add('nofg'));
    return page.evaluate(({ container, addClass, target }) => {
      const host = document.querySelector(container);
      if (!host) return null;
      host.classList.add(addClass);
      const el = host.querySelector(target);
      if (!el) return null;
      const s = getComputedStyle(el);
      return {
        ml: parseFloat(s.marginLeft) || 0, mt: parseFloat(s.marginTop) || 0,
        hidden: s.display === 'none',
      };
    }, sc);
  };
  const modern = await read(false);
  const legacy = await read(true);
  stateResults.push({
    ...sc, modern, legacy,
    ok: !!modern && !!legacy && !modern.hidden &&
        Math.abs(modern.ml) < TOL && Math.abs(legacy.ml) < TOL &&
        Math.abs(modern.mt) < TOL && Math.abs(legacy.mt) < TOL,
  });
}

/** `.nofg` 副本必须与 `@supports` 块逐条等价（选择器去掉前缀后比对） */
function checkNofgMirror(html, fb) {
  const b = html.indexOf('/* nofg-mirror:begin');
  if (b < 0) return { present: false, mirrorRules: 0, sameSelectors: false };
  const e = html.indexOf('/* nofg-mirror:end */');
  // 从注释结尾开始切，不能从第一个 `}` 开始（那条是第一条规则的结尾）
  const bodyStart = html.indexOf('*/', b) + 2;
  const body = html.slice(bodyStart, e);
  const mirror = [];
  const re = /html\.nofg([^{}]*)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(body))) {
    // 用整段匹配取选择器串（含 `html.nofg` 前缀），逗号分组逐项展开
    for (const part of m[0].split('{')[0].split(',')) if (part.trim()) mirror.push(part.trim());
  }
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  // 镜像侧还原前缀：`html.nofg.desk X` → `html.desk X`，`html.nofg X` → `X`
  const strip = (s) => norm(s).replace(/html\.nofg\./g, 'html.').replace(/html\.nofg\s+/g, '');
  const want = fb.map((f) => norm(f.selector)).sort();
  const got = mirror.map(strip).sort();
  return {
    present: true, mirrorRules: mirror.length, baseRules: want.length,
    sameSelectors: want.length === got.length && want.every((w, i) => w === got[i]),
    missing: want.filter((w) => !got.includes(w)).slice(0, 5),
  };
}

await browser.close();

if (asJson) {
  console.log(JSON.stringify(results, null, 2));
} else {
  let totalFail = 0;
  let totalLatent = 0;
  let totalUnmeasured = 0;
  for (const r of results) {
    if (r.error) { console.log(`\n== ${r.file} ==  ${r.error}`); totalFail++; continue; }
    const bad = r.cases.filter((c) => !c.ok);
    const lat = r.cases.filter((c) => (c.latent || []).length && c.ok !== undefined);
    totalFail += bad.length;
    totalLatent += lat.length;
    totalUnmeasured += r.unmeasured.length;
    console.log(`\n== ${r.file} ==  ${r.cond}`);
    console.log(`   兜底容器 ${r.containers} 个；可量 ${r.cases.length} 个（按视口/取值展开）；失败 ${bad.length} 个；潜在 ${lat.length} 个`);
    if (r.injected.length) console.log(`   运行态容器补骨架量到 ${r.injected.length} 个：${r.injected.join(' ')}`);
    if (r.zeroGap.length) console.log(`   真值 gap 为 0、不需要兜底 ${r.zeroGap.length} 个：${r.zeroGap.join(' ')}`);
    if (r.unmeasured.length) console.log(`   ⚠ 未验证 ${r.unmeasured.length} 个（骨架建不出 / 取不到 computed gap，不算通过）：${r.unmeasured.join(' ')}`);
    for (const c of bad) {
      console.log(`  ✗ ${c.container}  [${c.kind} gap=${c.gap} @${c.vw}${c.desk ? '(desk)' : ''}]${c.injected ? ' [补骨架]' : ''}`);
      for (const p of c.problems) console.log(`      结构：${p}`);
      for (const f of c.fails) console.log(`      行为：${f}`);
    }
    for (const c of lat) {
      console.log(`  ~ ${c.container}  [${c.kind} gap=${c.gap} @${c.vw}${c.desk ? '(desk)' : ''}] 首项隐藏才现形`);
      for (const f of c.latent) console.log(`      潜在：${f}`);
    }
    if (!bad.length) console.log('   硬失败 0');
    if (r.nofg && r.nofg.present) {
      const n = r.nofg;
      const same = n.sameSelectors && n.mirrorRules === n.baseRules;
      if (!same) totalFail++;
      console.log(`   .nofg 副本 ${n.mirrorRules} 条 / @supports 块 ${n.baseRules} 条 —— ${same ? '逐条等价' : '✗ 与 @supports 块不一致：缺 ' + (n.missing || []).join(' | ')}`);
    } else {
      totalFail++;
      console.log('   ✗ 没有 .nofg 副本：Chrome 57–83 上 @supports not (gap) 判不出，兜底整块不生效');
    }
  }
  // 状态级检查
  const stateBad = stateResults.filter((s) => !s.ok);
  totalFail += stateBad.length;
  console.log('\n== 状态级：首项真会被隐藏的容器 ==');
  for (const s of stateResults) {
    const tag = s.ok ? '✓' : '✗';
    const m = s.modern, l = s.legacy;
    console.log(`  ${tag} ${s.container}.${s.addClass} → ${s.target}  margin-left  现代 ${m ? m.ml : '?'}px / .nofg ${l ? l.ml : '?'}px`);
    if (!s.ok) totalFail += 0;
  }
  console.log(totalFail ? `\n合计失败 ${totalFail} 项` : `\n硬失败 0 项；潜在（首项被隐藏时才有差）${totalLatent} 项；未验证 ${totalUnmeasured} 项；状态级 ${stateResults.length} 项全通过`);
  process.exit(totalFail ? 1 : 0);
}
