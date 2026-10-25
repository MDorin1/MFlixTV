'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

/**
 * Netflix 式左侧类型导航。
 *
 * - 桌面（lg 以上）：左侧固定竖排导航，内容区在右侧
 * - 平板/手机：变成一行可横滑的胶囊导航（不占竖向空间）
 *
 * 选中态不画色块：Netflix 的侧栏是靠「白色粗体 + 左侧红条」表达当前位置，
 * 画成实心胶囊会把整列变成按钮墙，反而看不清层级。
 */

export interface NavItem {
  key: string;
  label: string;
  href: string;
}

const MAIN: NavItem[] = [
  { key: 'home', label: '首页', href: '/' },
  { key: 'movie', label: '电影', href: '/?tab=movie' },
  { key: 'tv', label: '剧集', href: '/?tab=tv' },
  { key: 'hongguo', label: '短剧专区', href: '/hongguo' },
  { key: 'live', label: '直播', href: '/live' },
  { key: 'about', label: '关于', href: '/about' },
];

const CATS: NavItem[] = [
  { key: '热门', label: '热门推荐', href: '/?cat=热门' },
  { key: '最新', label: '最新上线', href: '/?cat=最新' },
  { key: '经典', label: '经典老片', href: '/?cat=经典' },
  { key: '高分好评', label: '高分好评', href: '/?cat=高分好评' },
  { key: '冷门佳片', label: '冷门佳片', href: '/?cat=冷门佳片' },
  { key: '华语', label: '华语', href: '/?cat=华语' },
  { key: '欧美', label: '欧美', href: '/?cat=欧美' },
  { key: '韩国', label: '韩国', href: '/?cat=韩国' },
  { key: '日本', label: '日本', href: '/?cat=日本' },
  { key: '动画', label: '动画', href: '/?cat=动画' },
];

function SideItem({ it, active }: { it: NavItem; active: boolean }) {
  return (
    <Link
      href={it.href}
      className={cn(
        'relative block truncate rounded-md py-2 pl-3 pr-2 text-sm transition-colors',
        active ? 'font-semibold text-white' : 'text-white/60 hover:text-white'
      )}
      aria-current={active ? 'page' : undefined}
    >
      {active && <span aria-hidden className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded bg-accent" />}
      {it.label}
    </Link>
  );
}

function PillItem({ it, active }: { it: NavItem; active: boolean }) {
  return (
    <Link
      href={it.href}
      className={cn(
        'shrink-0 whitespace-nowrap rounded-full px-3.5 py-1.5 text-[13px] transition-colors',
        active ? 'bg-white font-semibold text-black' : 'bg-chip text-muted hover:text-content'
      )}
      aria-current={active ? 'page' : undefined}
    >
      {it.label}
    </Link>
  );
}

export function NetflixNav({
  activeTab,
  activeCat,
}: {
  /** 首页用：当前影视类型（?tab=）与分类（?cat=）；其他页面不用传 */
  activeTab?: 'movie' | 'tv' | null;
  activeCat?: string | null;
} = {}) {
  const pathname = usePathname();
  const isHome = pathname === '/';
  const cur = !isHome
    ? pathname.replace(/^\//, '').split('/')[0]
    : activeTab === 'movie' || activeTab === 'tv'
      ? activeTab
      : 'home';

  return (
    <>
      {/* 桌面/大平板：左侧竖排 */}
      <aside className="hidden w-48 shrink-0 lg:block">
        <div className="sticky top-16 max-h-[calc(100vh-4rem)] overflow-y-auto pb-6 pt-2 pr-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <nav className="space-y-0.5">
            {MAIN.map((it) => (
              <SideItem key={it.key} it={it} active={cur === it.key} />
            ))}
          </nav>
          {/* 分类是首页筛选（?cat=），直播/短剧页上没有对应语义，别放一排点了没用的链接 */}
          {isHome && (
            <>
              <p className="mb-1 mt-5 px-3 text-[11px] font-semibold uppercase tracking-wider text-faint">分类</p>
              <nav className="space-y-0.5">
                {CATS.map((it) => (
                  <SideItem key={it.key} it={it} active={activeCat === it.key} />
                ))}
              </nav>
            </>
          )}
        </div>
      </aside>

      {/* 手机/平板：顶部横滑胶囊 */}
      <div className="-mx-4 mb-4 flex gap-2 overflow-x-auto px-4 pb-1 lg:hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {MAIN.map((it) => (
          <PillItem key={it.key} it={it} active={cur === it.key} />
        ))}
      </div>
    </>
  );
}
