import { NextResponse } from 'next/server';
import os from 'node:os';
import {
  createSession,
  getSession,
  hostPoll,
  pushCommand,
  setState,
  ctlPoll,
  dropSession,
  hostAlive,
  liveCtls,
} from '@/lib/remote-session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 「扫一扫当遥控器」的接口。
 *
 * 故意不走 guardRequest：扫码的那台手机没有密码 cookie，
 * token 本身就是凭证（6 位、30 分钟、只对本机内网有意义）。
 * 被控端（已有登录态的页面）来领 token 时才需要它自己已经登录过。
 */

/** 取一个扫码设备真的连得上的地址：优先私有网段，不用 127.0.0.1 */
function lanBase(req: Request): string {
  const host = req.headers.get('host') || '';
  const port = host.includes(':') ? host.split(':').pop() : '8080';
  const hostIp = host.split(':')[0];

  const privates: string[] = [];
  try {
    for (const addrs of Object.values(os.networkInterfaces())) {
      for (const a of addrs || []) {
        if (a.family !== 'IPv4' || a.internal) continue;
        if (a.address.startsWith('169.254.')) continue;
        if (a.address.startsWith('127.')) continue;
        privates.push(a.address);
      }
    }
  } catch {
    /* 取不到就退回请求里的 host */
  }

  // 发起方本来就是从局域网地址打开的，就用同一个网段的那个
  const prefix = hostIp.split('.').slice(0, 3).join('.');
  const sameSubnet = privates.find((ip) => ip.startsWith(prefix + '.')) || privates[0] || hostIp;

  return `http://${sameSubnet}:${port}`;
}

type Ctx = { params: Promise<{ action: string }> };

export async function GET(req: Request, ctx: Ctx) {
  const { action } = await ctx.params;
  const p = new URL(req.url).searchParams;
  const t = (p.get('t') || '').toUpperCase();

  if (action === 'host') {
    const since = Number(p.get('since') || 0) || 0;
    const out = hostPoll(t, since);
    if (!out) return NextResponse.json({ error: '会话已失效' }, { status: 404 });
    return NextResponse.json(out);
  }

  if (action === 'ctl') {
    const out = ctlPoll(t, p.get('who') || '');
    if (!out) return NextResponse.json({ error: '会话已失效' }, { status: 404 });
    return NextResponse.json(out);
  }

  if (action === 'info') {
    const v = getSession(t);
    if (!v) return NextResponse.json({ error: '会话已失效' }, { status: 404 });
    return NextResponse.json({
      name: v.name,
      state: v.state,
      hostAlive: hostAlive(v),
      ctls: liveCtls(v),
    });
  }

  // 下面三个也支持 GET：和安卓端（Kotlin WebServer）的接口保持一致，
  // 两边前端就能共用同一份调用代码，不用为了安卓再分一套 POST。
  if (action === 'create') {
    const v = createSession(p.get('name') || '');
    return NextResponse.json({ token: v.token, url: `${lanBase(req)}/rc?t=${v.token}` });
  }

  if (action === 'cmd') {
    const cmd = (p.get('cmd') || '').trim();
    if (!cmd) return NextResponse.json({ error: '缺少 cmd' }, { status: 400 });
    const id = pushCommand(t, cmd, p.get('arg') || '');
    if (id == null) return NextResponse.json({ error: '会话已失效' }, { status: 404 });
    return NextResponse.json({ ok: true, id });
  }

  if (action === 'state') {
    const g = (k: string) => p.get(k);
    if (!setState(t, {
      title: g('title') ?? undefined,
      sub: g('sub') ?? undefined,
      playing: g('playing') == null ? undefined : g('playing') === '1',
      pos: g('pos') == null ? undefined : Number(g('pos')),
      dur: g('dur') == null ? undefined : Number(g('dur')),
      page: g('page') ?? undefined,
    })) return NextResponse.json({ error: '会话已失效' }, { status: 404 });
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: 'unknown action' }, { status: 404 });
}

export async function POST(req: Request, ctx: Ctx) {
  const { action } = await ctx.params;
  const p = new URL(req.url).searchParams;
  const t = (p.get('t') || '').toUpperCase();

  if (action === 'create') {
    let body: { name?: string } = {};
    try {
      body = (await req.json()) as typeof body;
    } catch {
      body = {};
    }
    const v = createSession(body.name || '');
    const url = `${lanBase(req)}/rc?t=${v.token}`;
    return NextResponse.json({ token: v.token, url });
  }

  if (action === 'cmd') {
    let body: { cmd?: string; arg?: string } = {};
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return NextResponse.json({ error: '请求格式错误' }, { status: 400 });
    }
    const cmd = (body.cmd || '').trim();
    if (!cmd) return NextResponse.json({ error: '缺少 cmd' }, { status: 400 });
    const id = pushCommand(t, cmd, body.arg || '');
    if (id == null) return NextResponse.json({ error: '会话已失效' }, { status: 404 });
    return NextResponse.json({ ok: true, id });
  }

  if (action === 'state') {
    let body: Record<string, unknown> = {};
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: '请求格式错误' }, { status: 400 });
    }
    if (!setState(t, body)) return NextResponse.json({ error: '会话已失效' }, { status: 404 });
    return NextResponse.json({ ok: true });
  }

  if (action === 'close') {
    dropSession(t);
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: 'unknown action' }, { status: 404 });
}
