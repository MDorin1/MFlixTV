#!/usr/bin/env node
/**
 * 新年份覆盖报告 / 断更体检（只读，不写任何东西）
 *
 * 目的：出包前自查「还在更新的节目，最新一集日期是不是真的新」，
 * 而不是只看源站通不通（通不代表有新鲜内容）。
 *
 * 做法：
 *   1) 逐源取最新列表（ac=videolist&pg=1..N），抽出每个节目名 + 类型 + 期号/备注里的日期；
 *   2) 按（规范化节目名）聚合成一条，取各源里最新的那期；
 *   3) 对「综艺/真人秀/脱口秀」这类仍在连载的节目做二次比对：
 *      拿节目名打应用内 /api/search，与源站直连比较，
 *      应用侧最新日期 < 源站最新日期 → 判定「解析丢」；
 *      两侧都停在同一老日期 → 判定「源无」；
 *      应用侧搜不到、只有换词才搜到 → 判定「词不对」。
 *
 * 用法：
 *   node tools/freshness-check.mjs                     # 全量，默认 30 天门槛
 *   node tools/freshness-check.mjs --base http://127.0.0.1:8137 --password MFlixTV
 *   node tools/freshness-check.mjs --stale-days 7 --json out.json --fail-on-stale
 *
 * --fail-on-stale：有「解析丢」或「词不对」时以退出码 2 结束（可以挂进出包脚本）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const BASE = String(arg('base', process.env.MFL_BASE || 'http://127.0.0.1:8137'));
const PASSWORD = String(arg('password', process.env.MFL_PWD || 'MFlixTV'));
const STALE_DAYS = Number(arg('stale-days', 30));
const PAGES = Math.max(1, Math.min(3, Number(arg('pages', 2))));
const JSON_OUT = arg('json', '');
const FAIL_ON_STALE = Boolean(arg('fail-on-stale', false));
const CONCURRENCY = Math.max(2, Math.min(16, Number(arg('concurrency', 8))));

const NOW = Date.now();
const DAY = 86400000;

/** 读 app/.env 里的源列表（与界面同源，避免两套配置） */
function loadSources() {
  const envPath = path.join(REPO, 'app', '.env');
  const text = fs.readFileSync(envPath, 'utf8');
  const m = text.match(/^DEFAULT_SOURCES=(.*)$/m);
  if (!m) throw new Error('app/.env 里没有 DEFAULT_SOURCES');
  const arr = JSON.parse(m[1]);
  return arr.map((s, i) => ({
    key: `env_${i}`,
    name: s.name,
    url: s.url,
    isAdult: Boolean(s.isAdult),
  }));
}

/** 备注里的期号 → 日期。支持 20251020 / 2025-10-20 / 2025.10.20 / 更新至第20251020期 */
function dateFromRemarks(remarks) {
  if (!remarks) return null;
  const s = String(remarks);
  let m = s.match(/(20\d{2})[-./年](\d{1,2})[-./月](\d{1,2})/);
  if (m) return Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]);
  m = s.match(/(20\d{2})(\d{2})(\d{2})/);
  if (m) {
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return Number(m[1]) * 10000 + mo * 100 + d;
  }
  return null;
}

function toDate(yyyymmdd) {
  if (!yyyymmdd) return null;
  const y = Math.floor(yyyymmdd / 10000);
  const m = Math.floor((yyyymmdd % 10000) / 100);
  const d = yyyymmdd % 100;
  return new Date(y, m - 1, d).getTime();
}

function normName(name) {
  return String(name || '')
    .replace(/\s+/g, '')
    .replace(/[（(].*?[)）]/g, '')
    .toLowerCase();
}

const SERIES_TYPE = /综艺|真人秀|脱口秀|访谈|晚会|选秀|综艺节目/;

async function fetchJson(url, timeoutMs = 20000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal: ctl.signal,
      headers: { 'user-agent': 'Mozilla/5.0 MFlixTV-freshness-check' },
    });
    const text = await r.text();
    return JSON.parse(text);
  } finally {
    clearTimeout(t);
  }
}

function apiUrl(api, params) {
  const u = new URL(api);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  return u.toString();
}

/** 单源：抓最新列表，返回 {name,type,year,remarks,date} */
async function scanSource(src) {
  const rows = [];
  for (let pg = 1; pg <= PAGES; pg++) {
    let data;
    try {
      data = await fetchJson(apiUrl(src.url, { ac: 'videolist', pg }));
    } catch (e) {
      return { src: src.name, ok: false, error: String(e.message || e).slice(0, 80), rows };
    }
    const list = (data && data.list) || [];
    for (const it of list) {
      const remarks = it.vod_remarks || '';
      rows.push({
        name: String(it.vod_name || '').trim(),
        type: String(it.type_name || it.vod_class || '').trim(),
        year: String(it.vod_year || '').trim(),
        remarks,
        date: dateFromRemarks(remarks),
      });
    }
    const pagecount = Number(data?.pagecount || 1);
    if (pg >= pagecount) break;
  }
  return { src: src.name, ok: true, error: '', rows };
}

/** 应用内搜索（走 /api/search，和服务端渲染同一套解析） */
async function appSearch(wd, sources, cookie) {
  const r = await fetch(BASE + '/api/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ wd, sources, filterAdult: true }),
  });
  if (!r.ok) throw new Error('search HTTP ' + r.status);
  const d = await r.json();
  return (d.list || []).map((it) => ({
    name: String(it.name || '').trim(),
    year: String(it.year || '').trim(),
    remarks: String(it.remarks || ''),
    date: dateFromRemarks(it.remarks),
  }));
}

async function login() {
  const r = await fetch(BASE + '/api/auth', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  if (!r.ok) throw new Error('auth HTTP ' + r.status);
  const raw = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  const cookie = raw.map((c) => c.split(';')[0]).join('; ');
  if (!cookie) throw new Error('没拿到会话 cookie');
  return cookie;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx], idx);
      }
    })
  );
  return out;
}

function fmtDate(yyyymmdd) {
  if (!yyyymmdd) return '—';
  const s = String(yyyymmdd);
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

async function main() {
  const sources = loadSources();
  process.stderr.write(`体检开始：${sources.length} 个源，每源 ${PAGES} 页，门槛 ${STALE_DAYS} 天\n`);

  const scans = await mapLimit(sources, CONCURRENCY, scanSource);
  const byName = new Map();
  for (const sc of scans) {
    for (const row of sc.rows) {
      if (!row.name) continue;
      const k = normName(row.name);
      let cur = byName.get(k);
      if (!cur) {
        cur = { name: row.name, types: new Set(), years: new Set(), latest: null, sources: new Set() };
        byName.set(k, cur);
      }
      if (row.type) cur.types.add(row.type);
      if (row.year) cur.years.add(row.year);
      cur.sources.add(sc.src);
      if (row.date && (!cur.latest || row.date > cur.latest)) cur.latest = row.date;
    }
  }

  const programs = [...byName.values()].map((p) => ({
    name: p.name,
    types: [...p.types],
    year: [...p.years].sort().pop() || '',
    latest: p.latest,
    firstSeen: p.firstSeen,
    sources: [...p.sources],
  }));

  const series = programs.filter((p) => p.types.some((t) => SERIES_TYPE.test(t)));
  const stale = series.filter((p) => {
    if (!p.latest) return true;
    const t = toDate(p.latest);
    return !t || NOW - t > STALE_DAYS * DAY;
  });

  // 只在综艺里取样做应用侧比对（这层比对要打搜索接口，成本高，取最陈旧的 25 个）
  stale.sort((a, b) => (a.latest || 0) - (b.latest || 0));
  const sample = stale.slice(0, 25);

  let cookie = '';
  const verdicts = new Map();
  if (sample.length) {
    try {
      cookie = await login();
    } catch (e) {
      process.stderr.write(`应用侧比对跳过：${e.message}\n`);
    }
  }
  if (cookie) {
    await mapLimit(sample, 4, async (p) => {
      try {
        const found = await appSearch(p.name, sources, cookie);
        const mine = found.find((f) => normName(f.name) === normName(p.name)) || found[0];
        if (!mine) {
          verdicts.set(p.name, { verdict: '词不对', note: `应用内搜「${p.name}」无结果，源站有 ${p.sources.length} 个源` });
          return;
        }
        const appDate = mine.date || 0;
        const srcDate = p.latest || 0;
        if (appDate && srcDate && appDate < srcDate) {
          verdicts.set(p.name, {
            verdict: '解析丢',
            note: `源站最新 ${fmtDate(srcDate)}，应用侧只有 ${fmtDate(appDate)}（${mine.remarks.slice(0, 20)}）`,
          });
        } else if (appDate && srcDate && appDate === srcDate) {
          verdicts.set(p.name, { verdict: '源无', note: `源站与应用侧都停在 ${fmtDate(srcDate)}` });
        } else if (!appDate && srcDate) {
          verdicts.set(p.name, { verdict: '解析丢', note: `应用侧备注「${mine.remarks.slice(0, 20)}」没解析出日期，源站是 ${fmtDate(srcDate)}` });
        } else {
          verdicts.set(p.name, { verdict: '源无', note: '两侧都没有日期/期号可用' });
        }
      } catch (e) {
        verdicts.set(p.name, { verdict: '未判定', note: String(e.message || e).slice(0, 60) });
      }
    });
  }

  const rows = sample.map((p) => {
    const v = verdicts.get(p.name) || { verdict: cookie ? '未判定' : '跳过', note: '' };
    const age = p.latest ? Math.round((NOW - toDate(p.latest)) / DAY) : null;
    return {
      节目: p.name,
      类型: p.types.join('/') || '—',
      年份字段: p.year || '—',
      各源最新期: p.latest ? fmtDate(p.latest) : '—',
      距今天数: age == null ? '—' : age,
      源数: p.sources.length,
      判定: v.verdict,
      说明: v.note,
    };
  });

  const counts = {};
  for (const r of rows) counts[r.判定] = (counts[r.判定] || 0) + 1;

  const report = {
    generatedAt: new Date().toISOString(),
    base: BASE,
    staleDays: STALE_DAYS,
    sources: scans.map((s) => ({ src: s.src, ok: s.ok, error: s.error, rows: s.rows.length })),
    totals: {
      programs: programs.length,
      series: series.length,
      staleSeries: stale.length,
      sampled: rows.length,
      verdicts: counts,
    },
    rows,
  };

  if (JSON_OUT) {
    fs.writeFileSync(String(JSON_OUT), JSON.stringify(report, null, 2), 'utf8');
    process.stderr.write(`已写 ${JSON_OUT}\n`);
  }

  const pad = (s, n) => {
    const w = [...String(s)].reduce((a, ch) => a + (ch.charCodeAt(0) > 127 ? 2 : 1), 0);
    return String(s) + ' '.repeat(Math.max(0, n - w));
  };
  const header = ['节目', '类型', '年份字段', '各源最新期', '距今', '源数', '判定'];
  const widths = [26, 14, 8, 12, 6, 4, 8];
  console.log(header.map((h, i) => pad(h, widths[i])).join(' '));
  console.log(widths.map((w) => '-'.repeat(w)).join(' '));
  for (const r of rows) {
    console.log(
      [
        pad(r.节目.slice(0, 24), widths[0]),
        pad(r.类型.slice(0, 12), widths[1]),
        pad(r.年份字段, widths[2]),
        pad(r.各源最新期, widths[3]),
        pad(r.距今天数, widths[4]),
        pad(r.源数, widths[5]),
        pad(r.判定, widths[6]),
      ].join(' ')
    );
    if (r.说明) console.log('   └ ' + r.说明);
  }
  console.log('');
  console.log(
    `节目 ${report.totals.programs} 个（综艺 ${report.totals.series} 个）｜最新一集早于 ${STALE_DAYS} 天的综艺 ${report.totals.staleSeries} 个｜本次比对 ${rows.length} 个`
  );
  console.log('判定分布：' + (Object.keys(counts).length ? Object.entries(counts).map(([k, v]) => `${k} ${v}`).join('｜') : '空'));
  const bad = rows.filter((r) => r.判定 === '解析丢' || r.判定 === '词不对').length;
  console.log(bad ? `⚠ 有 ${bad} 个节目是我们这层丢的，要修解析/搜索词` : '✅ 没有「解析丢 / 词不对」，停更都在源站一侧');
  if (FAIL_ON_STALE && bad) process.exit(2);
}

main().catch((e) => {
  console.error('体检失败：' + (e && e.message ? e.message : e));
  process.exit(1);
});
