'use strict';
/**
 * 基于 node:http/https 的 HTTP 客户端（对应原 Java util/Http.java）。
 *
 * 关键行为对齐：
 *  - 默认跟随重定向
 *  - 默认不自动压缩（不主动发 accept-encoding，交给对端决定）
 *  - 超时抛异常而非静默返回
 */
const http = require('http');
const https = require('https');
const { URL } = require('url');

/** 响应结果。 */
class Resp {
  constructor(status, body, headers) {
    this.status = status;
    this.body = body || Buffer.alloc(0);
    this.headers = headers || {};
  }

  text() { return this.body.toString('utf8'); }

  header(name) {
    const v = this.headers[String(name).toLowerCase()];
    if (v === undefined || v === null) return null;
    return Array.isArray(v) ? (v.length ? v[0] : null) : String(v);
  }

  ok() { return this.status >= 200 && this.status < 300; }
}

/**
 * 发起请求。
 * @param {object} req { method, url, headers, body, timeoutMs, followRedirect }
 * @returns {Promise<Resp>}
 */
function send(req) {
  const follow = req.followRedirect !== false;
  return sendOnce(req, follow ? 5 : 0);
}

function sendOnce(req, redirectsLeft) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(req.url);
    } catch (e) {
      reject(new Error('非法 URL: ' + req.url));
      return;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      reject(new Error('仅支持 http/https，当前协议不支持：' + req.url));
      return;
    }
    const mod = u.protocol === 'https:' ? https : http;
    const method = req.method || 'GET';
    const headers = Object.assign({}, req.headers || {});
    const body = req.body || null;
    const hasLen = Object.keys(headers).some((k) => k.toLowerCase() === 'content-length');
    if (body && !hasLen) headers['content-length'] = String(body.length);

    const r = mod.request(u, {
      method,
      headers,
      timeout: req.timeoutMs || 30000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const loc = res.headers.location;
        if (redirectsLeft > 0 && res.statusCode >= 300 && res.statusCode < 400 && loc) {
          let m = method;
          if (res.statusCode === 303 || m === 'POST') m = 'GET';
          const nextUrl = new URL(loc, u).toString();
          const nh = Object.assign({}, headers);
          let nb = body;
          if (m === 'GET') {
            nb = null;
            for (const k of Object.keys(nh)) {
              const kl = k.toLowerCase();
              if (kl === 'content-length' || kl === 'content-type') delete nh[k];
            }
          }
          resolve(sendOnce({ ...req, method: m, url: nextUrl, body: nb, headers: nh }, redirectsLeft - 1));
          return;
        }
        resolve(new Resp(res.statusCode, buf, res.headers));
      });
    });
    r.on('timeout', () => r.destroy(new Error('请求超时')));
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

/**
 * 流式下载到已打开的文件：边收边按 position 绝对写盘。
 *
 * 为什么要有这个：send() 是「chunks 数组 + Buffer.concat」把整个响应读进堆。
 * 短剧一集动辄 100~200MB，预取后面两集同时下就是 400MB 堆——播放时看到的内存
 * 飙升基本都出自这里。走这条边收边写的路，堆占用只有一块 64KB 的读缓冲，
 * 与文件大小无关；同一文件的多个分段各自带自己的 position，并发写也不会串。
 *
 * @param {object} req { url, method, headers, body, timeoutMs, followRedirect }
 * @param {{fd:number, position?:number, onProgress?:function(number)}} sink
 * @returns {Promise<{status:number, bytes:number, headers:object}>}
 */
function downloadTo(req, sink) {
  const follow = req.followRedirect !== false;
  return downloadToOnce(req, sink, follow ? 5 : 0);
}

function downloadToOnce(req, sink, redirectsLeft) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(req.url);
    } catch (e) {
      reject(new Error('非法 URL: ' + req.url));
      return;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      reject(new Error('仅支持 http/https，当前协议不支持：' + req.url));
      return;
    }
    const mod = u.protocol === 'https:' ? https : http;
    const method = req.method || 'GET';
    const headers = Object.assign({}, req.headers || {});
    const body = req.body || null;
    const hasLen = Object.keys(headers).some((k) => k.toLowerCase() === 'content-length');
    if (body && !hasLen) headers['content-length'] = String(body.length);

    const fs = require('fs');
    let written = 0;
    const base = sink.position || 0;

    const r = mod.request(u, { method, headers, timeout: req.timeoutMs || 30000 }, (res) => {
      // 重定向：这一段还没写过任何字节，直接换地址重来
      const loc = res.headers.location;
      if (redirectsLeft > 0 && res.statusCode >= 300 && res.statusCode < 400 && loc) {
        res.resume();
        let m = method;
        if (res.statusCode === 303 || m === 'POST') m = 'GET';
        const nextUrl = new URL(loc, u).toString();
        const nh = Object.assign({}, headers);
        let nb = body;
        if (m === 'GET') {
          nb = null;
          for (const k of Object.keys(nh)) {
            const kl = k.toLowerCase();
            if (kl === 'content-length' || kl === 'content-type') delete nh[k];
          }
        }
        resolve(downloadToOnce({ ...req, method: m, url: nextUrl, body: nb, headers: nh },
          sink, redirectsLeft - 1));
        return;
      }
      // 非 2xx：不写盘，让调用方按状态码决定
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        resolve({ status: res.statusCode, bytes: 0, headers: res.headers });
        return;
      }
      // 边收边写：写盘是异步的，写完这一块再 resume。同步写会把事件循环卡住
      // （四路并发互相等，整体慢三成），而「不收 backpressure 就异步写」又会让
      // 未来的数据在堆里堆起来——所以是「收到一块 → 暂停 → 异步落盘 → 继续」。
      let pending = 0;
      let ended = false;
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        resolve({ status: res.statusCode, bytes: written, headers: res.headers });
      };
      res.on('data', (chunk) => {
        res.pause();
        pending++;
        try {
          fs.write(sink.fd, chunk, 0, chunk.length, base + written, (err) => {
            if (err) {
              r.destroy(err);
              return;
            }
            written += chunk.length;
            pending--;
            if (typeof sink.onProgress === 'function') sink.onProgress(written);
            // 收尾要等最后一块真的落盘：'end' 可能比 write 回调先到，
            // 先 resolve 会少算最后一块的字节数
            if (ended && pending === 0) settle();
            res.resume();
          });
        } catch (e) {
          r.destroy(e);
        }
      });
      res.on('error', reject);
      res.on('end', () => {
        ended = true;
        if (pending === 0) settle();
      });
    });
    r.on('timeout', () => r.destroy(new Error('请求超时')));
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

/** 与 JS encodeURIComponent 等价（保留 A-Za-z0-9 - _ . ! ~ * ' ( )）。 */
function urlencode(s) {
  return encodeURIComponent(String(s));
}

function urldecode(s) {
  try {
    return decodeURIComponent(String(s).replace(/\+/g, ' '));
  } catch (e) {
    return String(s);
  }
}

/** 解析查询串为对象（对齐 URLSearchParams：重复键取最后一个）。 */
function parseQuery(qs) {
  const out = {};
  if (qs === null || qs === undefined || qs === '') return out;
  for (const pair of String(qs).split('&')) {
    if (pair === '') continue;
    const i = pair.indexOf('=');
    if (i < 0) {
      out[urldecode(pair)] = '';
    } else {
      out[urldecode(pair.slice(0, i))] = urldecode(pair.slice(i + 1));
    }
  }
  return out;
}

/** 把多行文本按逗号切分成去空白列表；null/空返回 null。 */
function splitCsv(v) {
  if (v === null || v === undefined || v === '') return null;
  const out = [];
  for (const s of String(v).split(',')) {
    const t = s.trim();
    if (t !== '') out.push(t);
  }
  return out;
}

module.exports = { Resp, send, downloadTo, urlencode, urldecode, parseQuery, splitCsv };
