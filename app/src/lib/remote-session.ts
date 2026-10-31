/**
 * 「扫一扫当遥控器」的会话总线。
 *
 * 和 remote-bus.ts 的区别：那个是「整台机器一条队列」，手机遥控的是电视 / 电脑这台机器；
 * 这里是**会话级**——每一个打开网页的标签页各自领一个 token，
 * 二维码里带的就是这个 token，扫它的设备只会控制那一个页面，互不串台。
 *
 * 例子：电脑浏览器开着 192.168.2.188:8080 在放片 → 点右上角遥控按钮 → 出二维码
 *      → 手机扫码打开 /rc?t=XXXXXX → 这台手机的方向键、播放键只作用于电脑那个标签页。
 *
 * 全程只在局域网内、只存在内存里：服务一停全部失效，不落盘、不外发。
 */

export interface RsCmd {
  id: number;
  cmd: string;
  arg: string;
  ts: number;
}

export interface RsState {
  title: string;
  sub: string;
  playing: boolean;
  pos: number;
  dur: number;
  page: string;
}

export interface RsSession {
  token: string;
  name: string;
  created: number;
  hostBeat: number;
  seq: number;
  cmds: RsCmd[];
  state: RsState;
  /** 遥控器心跳：key 是遥控器自己生成的 id，value 是最后活跃时间 */
  ctls: Map<string, number>;
}

interface Store {
  sessions: Map<string, RsSession>;
}

const MAX_CMDS = 48;
const HOST_ALIVE_MS = 45_000;
const CTL_ALIVE_MS = 20_000;
const TTL_MS = 30 * 60 * 1000;

// 去掉容易看错的 0/O/1/I/L，扫码后手抄也不会错
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

function store(): Store {
  const g = globalThis as typeof globalThis & { __mflRs?: Store };
  if (!g.__mflRs) g.__mflRs = { sessions: new Map() };
  return g.__mflRs;
}

function newToken(): string {
  const s = store();
  for (let attempt = 0; attempt < 40; attempt++) {
    let t = '';
    for (let i = 0; i < 6; i++) t += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    if (!s.sessions.has(t)) return t;
  }
  // 兜底：加时间戳后三位，几乎不可能撞
  return (Date.now().toString(36).slice(-6)).toUpperCase();
}

function sweep() {
  const s = store();
  const now = Date.now();
  for (const [k, v] of s.sessions) {
    if (now - v.created > TTL_MS) s.sessions.delete(k);
  }
}

export function createSession(name: string): RsSession {
  sweep();
  const s = store();
  const token = newToken();
  const sess: RsSession = {
    token,
    name: (name || '').slice(0, 40) || '未命名设备',
    created: Date.now(),
    hostBeat: Date.now(),
    seq: 0,
    cmds: [],
    state: { title: '', sub: '', playing: false, pos: 0, dur: 0, page: '' },
    ctls: new Map(),
  };
  s.sessions.set(token, sess);
  return sess;
}

export function getSession(token: string): RsSession | undefined {
  const s = store();
  const v = s.sessions.get(token);
  if (!v) return undefined;
  if (Date.now() - v.created > TTL_MS) {
    s.sessions.delete(token);
    return undefined;
  }
  return v;
}

export function dropSession(token: string) {
  store().sessions.delete(token);
}

/** 被控端（浏览器里的那个页面）每 1 秒来一次，顺带取走新指令 */
export function hostPoll(token: string, since: number) {
  const v = getSession(token);
  if (!v) return null;
  v.hostBeat = Date.now();
  const out = v.cmds.filter((c) => c.id > since);
  // 已经确认过的旧条目丢掉，长挂机不会越攒越多
  if (since > 0) v.cmds = v.cmds.filter((c) => c.id > since - 24);
  return {
    now: v.seq,
    cmds: out,
    state: v.state,
    ctls: liveCtls(v),
    name: v.name,
  };
}

export function pushCommand(token: string, cmd: string, arg: string): number | null {
  const v = getSession(token);
  if (!v) return null;
  const id = ++v.seq;
  v.cmds.push({ id, cmd: cmd.slice(0, 24), arg: arg.slice(0, 200), ts: Date.now() });
  while (v.cmds.length > MAX_CMDS) v.cmds.shift();
  return id;
}

export function setState(token: string, patch: Partial<RsState>): boolean {
  const v = getSession(token);
  if (!v) return false;
  v.state = {
    title: String(patch.title ?? v.state.title).slice(0, 120),
    sub: String(patch.sub ?? v.state.sub).slice(0, 60),
    playing: Boolean(patch.playing ?? v.state.playing),
    pos: Number.isFinite(Number(patch.pos)) ? Number(patch.pos) : v.state.pos,
    dur: Number.isFinite(Number(patch.dur)) ? Number(patch.dur) : v.state.dur,
    page: String(patch.page ?? v.state.page).slice(0, 200),
  };
  return true;
}

/** 遥控器每 1.2 秒来一次：拿被控端状态 + 报活 */
export function ctlPoll(token: string, who: string) {
  const v = getSession(token);
  if (!v) return null;
  const id = (who || 'x').slice(0, 16);
  v.ctls.set(id, Date.now());
  const now = Date.now();
  for (const [k, t] of v.ctls) if (now - t > CTL_ALIVE_MS) v.ctls.delete(k);
  return {
    ok: true as const,
    name: v.name,
    state: v.state,
    hostAlive: now - v.hostBeat < HOST_ALIVE_MS,
    ctls: v.ctls.size,
    cmds: v.seq,
  };
}

export function liveCtls(v: RsSession): number {
  const now = Date.now();
  let n = 0;
  for (const [, t] of v.ctls) if (now - t < CTL_ALIVE_MS) n++;
  return n;
}

export function hostAlive(v: RsSession): boolean {
  return Date.now() - v.hostBeat < HOST_ALIVE_MS;
}
