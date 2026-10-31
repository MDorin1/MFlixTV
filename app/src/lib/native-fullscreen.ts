/**
 * 原生窗口全屏（真全屏）—— 走 Android WebView 里注入的 `MFlixNative.fullscreen()`。
 *
 * 为什么需要这个文件：
 * 遥控指令来自 `fetch` 轮询，**没有用户手势**，浏览器据此拒绝 `requestFullscreen()`；
 * 连脚本去点页面上的「全屏」按钮也一样，合成 click 不算激活。
 * 结果就是遥控点全屏只能走网页全屏（CSS 铺满视口）：视频是大了，但**窗口本身没变**——
 * 浏览器还带着地址栏/标签栏，Android 还留着系统栏，看着就是「只是网页全屏」。
 *
 * 原生桥不受手势限制：它直接改 Activity 的窗口状态（沉浸式 + 转横屏 + 常亮），
 * 那才是真正的全屏。桌面浏览器没有这个桥，`setNativeFullscreen()` 返回 false，
 * 调用方退回网页全屏（桌面安装版已经用全屏窗口打开页面，网页全屏铺满的正是整块屏幕）。
 */

type NativeBridge = {
  fullscreen?: (on: boolean) => void;
  wide?: () => boolean;
};

function bridge(): NativeBridge | null {
  if (typeof window === 'undefined') return null;
  const b = (window as unknown as { MFlixNative?: NativeBridge }).MFlixNative;
  return b && typeof b.fullscreen === 'function' ? b : null;
}

/** 这台设备有没有「能真正改窗口状态」的原生桥。 */
export function canNativeFullscreen(): boolean {
  return bridge() !== null;
}

/**
 * 请求原生全屏 / 退出。返回 true 表示桥存在且已下发（不代表系统一定执行，
 * 但那一边是本地调用，不经过浏览器手势检查）。
 */
export function setNativeFullscreen(on: boolean): boolean {
  const b = bridge();
  if (!b) return false;
  try {
    b.fullscreen!(on);
    return true;
  } catch {
    return false;
  }
}

/** 页面有没有处在「原生全屏」里（Android 侧看当前是否横屏，仅作参考）。 */
export function nativeWide(): boolean {
  const b = bridge();
  if (!b || typeof b.wide !== 'function') return false;
  try {
    return b.wide() === true;
  } catch {
    return false;
  }
}

/**
 * 一键切成「真全屏」或退出，调用方不用自己判断先后。
 *
 * - 有原生桥：先改窗口状态（真全屏），true。
 * - 没有桥但当前是 HTML5 全屏（用户自己按 F 进去的）：退出原生全屏，true。
 * - 都没有：返回 false，让调用方用网页全屏兜底。
 */
export function toggleNativeFullscreen(want: boolean): boolean {
  if (canNativeFullscreen()) {
    setNativeFullscreen(want);
    return true;
  }
  if (typeof document !== 'undefined' && document.fullscreenElement) {
    void document.exitFullscreen().catch(() => {});
    return true;
  }
  return false;
}

/* ------------------------------------------------------- 遥控全屏缺的那一下手势
   遥控指令来自 `fetch` 轮询，浏览器不认它是用户激活，`requestFullscreen()` 必被拒；
   伪全屏只是把画面铺满窗口，窗口本身一点没变——浏览器还压着地址栏和标签栏，
   看着就是「只是网页全屏」。这一步绕不过去，但可以缩短：挂一个待办，
   把这台电脑上的**下一次真实点击 / 按键**当成手势，把整块屏幕的全屏补上。
   进入整屏之后再按一次照样能退（退出不需要手势）。 */

let fsArmUntil = 0;

function fsHintEl(): HTMLElement | null {
  if (typeof document === 'undefined' || !document.body) return null;
  const old = document.getElementById('mfl-fs-hint');
  if (old) return old;
  const n = document.createElement('div');
  n.id = 'mfl-fs-hint';
  n.style.cssText =
    'position:fixed;left:50%;top:16px;transform:translateX(-50%);z-index:2147483000;' +
    'padding:10px 20px;border-radius:999px;white-space:nowrap;pointer-events:none;' +
    'background:rgba(20,20,22,.9);border:1px solid rgba(255,255,255,.18);color:#fff;' +
    'font-size:13px;font-weight:600;letter-spacing:.01em;opacity:0;' +
    'backdrop-filter:blur(26px);-webkit-backdrop-filter:blur(26px);' +
    'box-shadow:0 12px 34px rgba(0,0,0,.55);transition:opacity .16s linear';
  n.innerHTML = '<b>点一下画面</b>或按任意键，进入整屏全屏';
  document.body.appendChild(n);
  return n;
}

function hideFsHint(): void {
  const n = typeof document !== 'undefined' ? document.getElementById('mfl-fs-hint') : null;
  if (n) n.style.opacity = '0';
}

/**
 * 遥控按了全屏、但这台设备还缺一次用户手势时调用。
 * 之后的第一次真实点击 / 按键会立刻补成 HTML5 整屏全屏（不是铺满窗口）。
 */
export function armRealFullscreen(ms = 15000): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (document.fullscreenElement) return;
  if (Date.now() < fsArmUntil) {
    const n = fsHintEl();
    if (n) n.style.opacity = '1';
    return;
  }
  fsArmUntil = Date.now() + ms;
  const hint = fsHintEl();
  if (hint) hint.style.opacity = '1';

  const el = document.documentElement;
  const go = () => {
    cleanup();
    if (!document.fullscreenElement) {
      const fn = el.requestFullscreen?.bind(el);
      if (fn) void fn({ navigationUI: 'hide' }).catch(() => {});
    }
  };
  const cleanup = () => {
    fsArmUntil = 0;
    hideFsHint();
    window.removeEventListener('pointerdown', go, true);
    window.removeEventListener('keydown', go, true);
  };
  window.addEventListener('pointerdown', go, true);
  window.addEventListener('keydown', go, true);
  window.setTimeout(cleanup, ms);
}

