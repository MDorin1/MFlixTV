'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { setHandlers, start } from '@/lib/remote-engine';

/**
 * 让「扫码当遥控器」的接收端在全站任意路由都醒着，自己不渲染任何东西。
 *
 * 以前只有顶栏里的 <RemoteHost /> 会调用 start()，而详情页 / 演员页 / 片名页
 * 不渲染顶栏 —— 用户在这几页刷新一下，手机上已经连上的遥控器就再也控制不动
 * 这一页（会话在模块里活着，是引擎压根没启动）。这几页又恰恰是「躺沙发上
 * 用手机挑季、挑集、看演员」最常待的地方，所以把它提到 Providers 层。
 *
 * start() 有幂等守卫、installNav() 只提供 move/ok 而不抢占键盘，重复挂载无副作用。
 */
export function RemoteBoot() {
  const router = useRouter();
  useEffect(() => {
    start();
    // 顶栏的 RemoteHost 挂载时也会设一次，两边指向同一个 router，覆盖没有副作用
    setHandlers({
      back: () => router.back(),
      home: () => router.push('/'),
      search: (q: string) => router.push(`/?s=${encodeURIComponent(q)}`),
    });
  }, [router]);
  return null;
}
