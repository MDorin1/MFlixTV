import { NextResponse } from 'next/server';
import os from 'node:os';
import { guardRequest } from '@/lib/api-guard';

export const runtime = 'nodejs';

/**
 * 本机可用的局域网访问地址。
 *
 * 用途：安装版是「本机跑服务 + 浏览器看片」，同一 WiFi 下的手机/平板也能连。
 * 但用户不知道地址，所以界面右上角显示实际 IP。
 *
 * 取址优先级：私有网段（192.168 / 10. / 172.16-31）优先，其次其它非回环 IPv4；
 * 排除 APIPA（169.254）与虚拟网卡常见的 zerotier/tailscale 之外不做推断——
 * 猜错比不显示更糟，所以符合条件的全部返回，前端默认用第一条。
 */
export async function GET(req: Request) {
  const denied = guardRequest(req);
  if (denied) return denied;

  // 端口从请求头取：安装版固定 8080，但允许用户改了端口后仍显示正确值
  const host = req.headers.get('host') || '';
  const port = host.includes(':') ? host.split(':').pop() : '80';

  const list: { name: string; ip: string; private: boolean }[] = [];
  try {
    const ifaces = os.networkInterfaces();
    for (const [name, addrs] of Object.entries(ifaces)) {
      for (const a of addrs || []) {
        if (a.family !== 'IPv4' || a.internal) continue;
        if (a.address.startsWith('169.254.')) continue;
        const isPrivate =
          a.address.startsWith('192.168.') ||
          a.address.startsWith('10.') ||
          /^172\.(1[6-9]|2\d|3[01])\./.test(a.address);
        list.push({ name, ip: a.address, private: isPrivate });
      }
    }
  } catch {
    /* 取不到网卡就当没有局域网地址 */
  }

  list.sort((x, y) => Number(y.private) - Number(x.private));

  return NextResponse.json({
    port,
    addresses: list,
    // 前端直接可用的地址（没有局域网地址时为 null）
    url: list.length > 0 ? `http://${list[0].ip}:${port}` : null,
  });
}
