import { NextResponse } from 'next/server';
import QRCode from 'qrcode';
import { guardRequest } from '@/lib/api-guard';

export const runtime = 'nodejs';

/**
 * 局域网地址的二维码（SVG）。
 *
 * 用途：安装版左上角点一下地址就弹「同一网络观看」，手机扫这张码直接打开网页版，
 * 不用手抄 IP。服务端出图，客户端只放一个 <img>，不往浏览器包里塞二维码库。
 *
 * 只为本机/局域网地址出码：手抄错、或者把它当通用二维码生成器用，都返回 400。
 */
const cache = new Map<string, string>();

function looksLikeHostUrl(u: string): boolean {
  if (!u || u.length > 200) return false;
  if (!/^https?:\/\//.test(u)) return false;
  try {
    const parsed = new URL(u);
    // 只允许 IP 或本机名，避免变成任意字符串的二维码服务
    return /^(\d{1,3}\.){3}\d{1,3}$/.test(parsed.hostname) || parsed.hostname === 'localhost';
  } catch {
    return false;
  }
}

export async function GET(req: Request) {
  const u = new URL(req.url).searchParams.get('u') || '';

  // 「扫码当遥控器」的链接自带 6 位会话 token，本身就是凭证：
  // 电视端、没登录过的设备也要能出这张码，所以这类链接不走登录校验。
  const isRemoteLink = /\/rc\?t=[0-9A-Z]{6}$/i.test(u);
  if (!isRemoteLink) {
    const denied = guardRequest(req);
    if (denied) return denied;
  }

  if (!looksLikeHostUrl(u)) {
    return NextResponse.json({ error: 'bad url' }, { status: 400 });
  }

  let svg = cache.get(u);
  if (!svg) {
    const out = await QRCode.toString(u, {
      type: 'svg',
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#0a0a0d', light: '#ffffff' },
    });
    svg = typeof out === 'string' ? out : String(out);
    if (cache.size > 32) cache.clear();
    cache.set(u, svg);
  }

  return new NextResponse(svg, {
    status: 200,
    headers: {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': 'private, max-age=3600',
    },
  });
}
