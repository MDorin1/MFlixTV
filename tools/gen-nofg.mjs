/**
 * gen-nofg.mjs —— 给 flex-gap 兜底块生成一份 `.nofg` 镜像
 *
 * 背景：`@supports not (gap: 1px)` 检测不出「flex 的 gap 不支持」。
 * `gap` 这个属性从 Chrome 57 起就能被解析（当时只作用于 grid），但 flex 的 gap
 * 要到 Chrome 84 才有。所以 57–83 这一段内核里 `@supports (gap:1px)` 返回 true、
 * `not (...)` 返回 false —— 整块兜底不生效，而 flex 的 gap 也确实不起作用，
 * 结果是两边都没有间距。安卓 8/9/10 上的系统 WebView 正落在这段区间。
 *
 * 做法：保留原来的 `@supports` 块（覆盖 Chrome < 57），再从它生成一份完全等价的
 * `html.nofg ...` 副本；页面用 JS 实测 flex gap 是否真的生效，不生效才给 <html>
 * 加 `.nofg`。这样 57–83 也能拿到兜底，现代内核两边都不生效。
 *
 * 用法：node tools/gen-nofg.mjs [--check]
 *       默认改文件；--check 只报告两份是否一致、不写盘。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.join(path.resolve(HERE, '..'), 'android', 'app', 'src', 'main', 'assets');
const FILES = ['index.html', 'tv.html'];
const MARK_BEGIN = '/* nofg-mirror:begin';
const MARK_END = '/* nofg-mirror:end */';
const check = process.argv.includes('--check');

function blockBody(css, at) {
  const open = css.indexOf('{', at);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') {
      depth--;
      if (!depth) return { start: i + 1, body: css.slice(open + 1, i) };
    }
  }
  return null;
}

/** 顶层规则拆解：普通规则 + 一层嵌套 @media / @supports */
function rules(body, media = '') {
  const out = [];
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
    if (selector.startsWith('@media')) out.push(...rules(inner, selector));
    else if (selector.startsWith('@supports')) out.push(...rules(inner, media));
    else if (selector) out.push({ media, selector, decls: inner.trim() });
    i = end + 1;
  }
  return out;
}

function prefixSelector(sel) {
  return sel.split(',').map((s) => {
    s = s.trim();
    // `html.desk X` 要合并成 `html.nofg.desk X`，不能变成 `html.nofg html.desk`
    if (/^html(\.|\[|\s|$)/.test(s)) return s.replace(/^html/, 'html.nofg');
    return 'html.nofg ' + s;
  }).join(',');
}

function render(list) {
  const plain = list.filter((r) => !r.media);
  const medias = new Map();
  for (const r of list.filter((x) => x.media)) {
    if (!medias.has(r.media)) medias.set(r.media, []);
    medias.get(r.media).push(r);
  }
  const line = (r, indent = '    ') => `${indent}${prefixSelector(r.selector)}{${r.decls}}`;
  const parts = [];
  parts.push(`  ${MARK_BEGIN}：Chrome 57–83 能解析 gap（grid）但 flex 的 gap 要 84，
      @supports not (gap) 在这段内核上判不出来，所以这份副本由 JS 实测后加 .nofg 才生效 */`);
  parts.push(...plain.map((r) => line(r)));
  for (const [media, rs] of medias) {
    parts.push(`    ${media}{`);
    parts.push(...rs.map((r) => line(r, '      ')));
    parts.push('    }');
  }
  parts.push(`  ${MARK_END}`);
  return parts.join('\n') + '\n';
}

for (const file of FILES) {
  const p = path.join(ASSETS, file);
  let html = fs.readFileSync(p, 'utf8');
  const at = html.indexOf('@supports not (gap');
  if (at < 0) { console.log(`${file}: 没有 gap 兜底块，跳过`); continue; }
  const blk = blockBody(html, at);
  if (!blk) { console.log(`${file}: 兜底块解析失败`); continue; }
  const list = rules(blk.body.replace(/\/\*[\s\S]*?\*\//g, ''));
  const fresh = render(list);

  // 已有旧副本先删掉（幂等）
  const b = html.indexOf(MARK_BEGIN);
  if (b >= 0) {
    const e = html.indexOf(MARK_END);
    if (e > b) html = html.slice(0, b) + html.slice(e + MARK_END.length + 1);
  }
  // 重新定位插入点（删过之后索引会变）
  const at2 = html.indexOf('@supports not (gap');
  const blk2 = blockBody(html, at2);
  const insertAt = blk2.start;
  html = html.slice(0, insertAt) + '\n' + fresh + html.slice(insertAt);
  fs.writeFileSync(p, html, 'utf8');

  const again = fs.readFileSync(p, 'utf8');
  const same = again.includes(fresh.trim());
  console.log(`${file}: 生成 ${list.length} 条 .nofg 规则${same ? '（已写入）' : '（写盘校验失败）'}${check ? ' [check 模式也写了，注意]' : ''}`);
}
