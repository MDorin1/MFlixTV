'use client';

import { Header } from '@/components/header';
import { SiteFooter } from '@/components/site-footer';
import { LanBadge } from '@/components/lan-badge';

export default function AboutPage() {
  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1 max-w-2xl w-full mx-auto px-4 py-10 space-y-8">
        <section>
          <h1 className="text-xl font-bold text-content mb-3">关于 lihongguotv</h1>
          <p className="text-sm text-muted leading-relaxed">
            lihongguotv 是一个自建的影视资源聚合播放器，界面与服务都运行在本机。
            输入片名即可在你自己配置的多个接口中检索并播放，本项目不提供、不索引、不托管任何影视内容。
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-content mb-2.5">快捷键</h2>
          <ul className="text-sm text-muted space-y-1.5 list-disc list-inside">
            <li><code className="text-accent">空格</code> 播放 / 暂停</li>
            <li><code className="text-accent">←</code> / <code className="text-accent">→</code> 快退 / 快进 5 秒</li>
            <li><code className="text-accent">↑</code> / <code className="text-accent">↓</code> 音量调节</li>
            <li><code className="text-accent">F</code> 切换全屏</li>
            <li><code className="text-accent">Alt + ←/→</code> 上一集 / 下一集</li>
            <li>移动端长按视频可 3 倍速播放</li>
          </ul>
        </section>

        <section>
          <h2 className="text-base font-semibold text-content mb-2.5">同一 WiFi 下其它设备</h2>
          <p className="text-sm text-muted leading-relaxed">
            服务跑在本机，手机 / 平板 / 电视连同一个 WiFi，用浏览器打开下面这个地址就能看（点一下复制）。服务没开着时这个地址打不开。
          </p>
          <div className="mt-2">
            <LanBadge showOnMobile className="px-0 text-sm" />
          </div>
        </section>

        <section>
          <h2 className="text-base font-semibold text-content mb-2.5">隐私与数据</h2>
          <p className="text-sm text-muted leading-relaxed">
            你的搜索历史、观看进度等数据保存在本机（浏览器 IndexedDB 与本机服务端），不上报给项目作者，本项目不含任何遥测。
            访问第三方接口的请求由本机服务转发；这些第三方仍会看到你本机的请求信息，这属于你与它们之间的直接关系。
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-content mb-2.5">免责声明</h2>
          <p className="text-sm text-faint leading-relaxed">
            本项目不存储、不制作、不分发任何影视内容，仅提供本机播放能力；内容来自你自行配置的第三方接口，其合法性由你与对应来源负责。
            文中出现的第三方名称与商标归其各自所有者，本项目与其无隶属、合作或授权关系。
            仅供个人学习与技术研究，请勿用于商业用途或公开传播。
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-content mb-2.5">开源许可</h2>
          <p className="text-sm text-muted leading-relaxed">
            本项目以 AGPL-3.0 许可开源（派生自 LibreTV），完整源码与第三方许可见仓库：
          </p>
          <p className="text-sm mt-2">
            <a className="text-accent hover:underline" href="https://github.com/MDorin1/lihongguotv-desktop" target="_blank" rel="noreferrer">
              github.com/MDorin1/lihongguotv-desktop
            </a>
          </p>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
