#!/usr/bin/env node
/**
 * MFlixTV LAN Proxy Bridge
 * ------------------------------------------------------------------
 * 把本机 MMC（127.0.0.1:7890，HTTP+SOCKS 混合口）以 HTTP 代理的形式
 * 暴露给局域网（默认 0.0.0.0:7891），给电视 / 盒子 / 手机填系统代理用。
 *
 * 为什么不直接开 MMC 的 allow-lan：
 *   那要改 MMC 自己的配置文件，按约定一律不碰。这里做一层纯转发，
 *   MMC 保持只监听 127.0.0.1，外部流量从这条桥进来。
 *
 * 用法：
 *   node tools/lan-proxy.js
 *   node tools/lan-proxy.js --port 7891 --upstream 7890 --verbose
 *
 * 电视端填：主机 = 本机局域网 IP（如 192.168.2.201），端口 = 7891
 * 自检地址：http://<本机IP>:7891/health
 */

'use strict';

const http = require('http');
const net = require('net');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return def;
}

const LISTEN_HOST = arg('host', '0.0.0.0');
const LISTEN_PORT = Number(arg('port', '7891'));
const UP_HOST = arg('upstream-host', '127.0.0.1');
const UP_PORT = Number(arg('upstream', '7890'));
const VERBOSE = process.argv.includes('--verbose');

const started = Date.now();
const stats = { requests: 0, tunnels: 0, errors: 0 };
const HOP_BY_HOP = new Set([
  'proxy-connection',
  'proxy-authorization',
  'proxy-authenticate',
  'connection',
  'keep-alive',
  'upgrade',
]);

function log(...a) {
  const t = new Date().toISOString().slice(11, 19);
  console.log(`[${t}]`, ...a);
}

function healthPayload() {
  return JSON.stringify(
    {
      ok: true,
      bridge: `http://${LISTEN_HOST}:${LISTEN_PORT}`,
      upstream: `http://${UP_HOST}:${UP_PORT}`,
      uptimeSec: Math.round((Date.now() - started) / 1000),
      requests: stats.requests,
      tunnels: stats.tunnels,
      errors: stats.errors,
    },
    null,
    2
  );
}

function sendText(res, code, text) {
  if (res.headersSent) return;
  try {
    res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(text);
  } catch (_) {}
}

const server = http.createServer((req, res) => {
  // ---- 自检 / 首页 ----
  if (req.url === '/health' || req.url === '/__mflixtv_bridge__' || req.url === '/') {
    if (res.headersSent) return;
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(healthPayload());
    return;
  }

  // ---- 代理请求必须是绝对 URI ----
  const isAbsolute = /^https?:\/\//i.test(req.url || '');
  if (!isAbsolute) {
    sendText(
      res,
      400,
      'This is an HTTP proxy bridge for MFlixTV.\nSet your device proxy to this host:port, then open /health to verify.\n'
    );
    return;
  }

  stats.requests++;
  if (VERBOSE) log('HTTP', req.method, req.url);

  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    headers[k] = v;
  }

  const up = http.request(
    {
      host: UP_HOST,
      port: UP_PORT,
      method: req.method,
      path: req.url,
      headers,
      setHost: false,
    },
    (ur) => {
      if (res.headersSent) {
        ur.destroy();
        return;
      }
      const outHeaders = {};
      for (const [k, v] of Object.entries(ur.headers)) {
        if (HOP_BY_HOP.has(k.toLowerCase())) continue;
        outHeaders[k] = v;
      }
      try {
        res.writeHead(ur.statusCode || 502, outHeaders);
      } catch (e) {
        stats.errors++;
        sendText(res, 502, 'header write failed: ' + e.message);
        ur.destroy();
        return;
      }
      ur.pipe(res);
      ur.on('error', () => {
        stats.errors++;
        try {
          res.destroy();
        } catch (_) {}
      });
    }
  );

  up.on('error', (e) => {
    stats.errors++;
    if (VERBOSE) log('upstream error(HTTP)', e.message);
    sendText(res, 502, 'upstream error: ' + e.message);
  });

  req.on('error', () => up.destroy());
  req.pipe(up);
});

server.on('connect', (req, clientSocket, head) => {
  stats.tunnels++;
  const target = req.url || '';
  if (!target || target.indexOf(':') < 0) {
    try {
      clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    } catch (_) {}
    return;
  }
  if (VERBOSE) log('CONNECT', target);

  const up = net.connect(UP_PORT, UP_HOST, () => {
    up.write(
      `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Connection: keep-alive\r\n\r\n`
    );
  });

  let pending = Buffer.alloc(0);
  let established = false;

  up.on('data', (chunk) => {
    if (established) {
      if (!clientSocket.destroyed) clientSocket.write(chunk);
      return;
    }
    pending = Buffer.concat([pending, chunk]);
    const idx = pending.indexOf('\r\n\r\n');
    if (idx < 0) return;
    const headText = pending.slice(0, idx).toString('latin1');
    const rest = pending.slice(idx + 4);
    if (/^HTTP\/1\.[01]\s+200/i.test(headText)) {
      established = true;
      if (!clientSocket.destroyed) {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (rest.length) clientSocket.write(rest);
      }
      if (head && head.length) up.write(head);
    } else {
      stats.errors++;
      if (VERBOSE) log('upstream refused tunnel', target, headText.split('\r\n')[0]);
      try {
        clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      } catch (_) {}
      up.destroy();
    }
  });

  clientSocket.on('data', (chunk) => {
    if (established && !up.destroyed) up.write(chunk);
  });
  clientSocket.on('error', () => up.destroy());
  clientSocket.on('close', () => up.destroy());
  up.on('error', () => {
    stats.errors++;
    try {
      clientSocket.destroy();
    } catch (_) {}
  });
  up.on('close', () => {
    try {
      clientSocket.destroy();
    } catch (_) {}
  });
  clientSocket.setTimeout(15 * 60 * 1000, () => {
    try {
      clientSocket.destroy();
    } catch (_) {}
  });
});

server.on('clientError', (e, sock) => {
  try {
    sock.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  } catch (_) {}
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  log(`LAN proxy bridge listening on ${LISTEN_HOST}:${LISTEN_PORT} -> ${UP_HOST}:${UP_PORT}`);
  log(`health check: http://<this-pc-ip>:${LISTEN_PORT}/health`);
});

server.on('error', (e) => {
  log('listen error:', e.code === 'EADDRINUSE' ? `port ${LISTEN_PORT} already in use` : e.message);
  process.exit(1);
});

process.on('uncaughtException', (e) => {
  log('uncaught:', e && e.message);
});
process.on('SIGINT', () => {
  log('shutting down');
  server.close(() => process.exit(0));
});
