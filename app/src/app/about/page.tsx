'use client';

import { Header } from '@/components/header';
import { SiteFooter } from '@/components/site-footer';
import { LanBadge } from '@/components/lan-badge';
import { ParentalSettings } from '@/components/parental-settings';

/** 一条说明：Netflix 那种「标题一行、正文一段、下面一条淡线」的节奏 */
function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-white/10 pb-7 last:border-0 last:pb-0">
      <h2 className="mb-2.5 text-lg font-bold text-white">{title}</h2>
      <div className="space-y-3 text-sm leading-relaxed text-white/70">{children}</div>
    </section>
  );
}

export default function AboutPage() {
  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8">
          <div className="mx-auto max-w-3xl space-y-7 pb-10 pt-2 sm:pt-6">
            <header>
              <h1 className="text-2xl font-bold text-white sm:text-3xl">关于 MFlixTV</h1>
              <p className="mt-2 text-sm leading-relaxed text-white/60">
                自建的影视资源聚合播放器，界面与服务都跑在本机。输入片名即可在你自己配置的多个接口中检索并播放。
              </p>
            </header>

            <Block title="快捷键">
              <ul className="grid gap-2 sm:grid-cols-2">
                {[
                  ['空格', '播放 / 暂停'],
                  ['← / →', '快退 / 快进 5 秒'],
                  ['双击左 / 右侧', '后退 / 快进 10 秒'],
                  ['长按画面', '临时 2 倍速，松开恢复'],
                  ['↑ / ↓', '音量调节'],
                  ['F', '切换全屏'],
                  ['Alt + ←/→', '上一集 / 下一集'],
                ].map(([key, desc]) => (
                  <li key={key} className="flex items-center gap-2">
                    <code className="rounded bg-white/10 px-1.5 py-0.5 text-xs font-medium text-white">{key}</code>
                    <span className="text-white/60">{desc}</span>
                  </li>
                ))}
              </ul>
            </Block>

            <Block title="同一网络下用手机 / 平板 / 电视看">
              <p>
                服务跑在这台电脑上，同一个 WiFi（同一个局域网）里的手机、平板、电视，
                用浏览器打开下面这个地址，就是一个完整的网页版：片源、搜索、播放器、短剧都在，不用装 App、不用投屏。
              </p>
              <p>
                点一下这个地址会弹出<strong className="text-white/85">二维码</strong>，手机相机扫一下直接打开；也可以手动输入。
                第一次打开要输这台电脑上设的访问密码，之后同一个浏览器会记住。电脑上的 MFlixTV 关掉，这个地址就打不开了。
              </p>
              <LanBadge showOnMobile className="px-0 text-sm" />
            </Block>

            <Block title="片源健康">
              <p>
                每个源现在通不通、快不快，看一页就知道；停用的源不参与搜索（随时能恢复）。
                整套源地址可以导出成一段 JSON 带到别的设备，不用手抄。
              </p>
              <a className="text-accent hover:underline" href="/sources">
                打开片源健康
              </a>
            </Block>

            <Block title="家长控制">
              <ParentalSettings />
            </Block>

            <Block title="隐私与数据">
              <p>
                搜索历史、观看进度等数据保存在本机（浏览器 IndexedDB 与本机服务端），不上报给项目作者，本项目不含任何遥测。
                访问第三方接口的请求由本机服务转发；这些第三方仍会看到你本机的请求信息，这属于你与它们之间的直接关系。
              </p>
            </Block>

            <Block title="免责声明">
              <p className="text-white/50">
                本项目不存储、不制作、不分发任何影视内容，仅提供本机播放能力；内容来自你自行配置的第三方接口，其合法性由你与对应来源负责。
                文中出现的第三方名称与商标归其各自所有者，本项目与其无隶属、合作或授权关系。仅供个人学习与技术研究，请勿用于商业用途或公开传播。
              </p>
            </Block>

            <Block title="开源许可">
              <p>本项目以 AGPL-3.0 许可开源（派生自 LibreTV），完整源码与第三方许可见仓库：</p>
              <a
                className="text-accent hover:underline"
                href="https://github.com/MDorin1/MFlixTV"
                target="_blank"
                rel="noreferrer"
              >
                github.com/MDorin1/MFlixTV
              </a>
            </Block>
          </div>
      </main>
      <SiteFooter />
    </div>
  );
}
