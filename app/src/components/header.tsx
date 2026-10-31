'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { ThemeToggle } from './theme';
import { SourceManagerDrawer } from './source-manager';
import { HistoryPanel } from './history-panel';
import { requestShowDownloadManager } from './download-manager';
import { LanBadge } from '@/components/lan-badge';
import { RemoteHost } from '@/components/remote-host';
import { Icon } from './icon';
import { SearchHistoryDropdown, useSearchHistory } from './search-history';
import { cn } from '@/lib/utils';

/** 顶部导航：Logo、搜索框（首页外）、历史、设置 */
export function Header({ showSearch = false }: { showSearch?: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Netflix 顶栏：向下滚动隐藏、向上滚动回来；滚过 8px 后加底色和阴影
  const [hidden, setHidden] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const lastYRef = useRef(0);
  useEffect(() => {
    const onScroll = () => {
      const y = window.scrollY || 0;
      setScrolled(y > 8);
      const last = lastYRef.current;
      // 顶部 80px 内始终显示；只在明显位移时才切换，避免抖动
      if (y < 80) setHidden(false);
      else if (y - last > 12) setHidden(true);
      else if (last - y > 12) setHidden(false);
      lastYRef.current = y;
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [query, setQuery] = useState('');
  // 与首页搜索框共用同一套「最近搜索」下拉逻辑
  const searchHistory = useSearchHistory(query);

  const submitSearch = (text: string) => {
    const q = text.trim().slice(0, 100);
    if (!q) return;
    searchHistory.close();
    router.push(`/?s=${encodeURIComponent(q)}`, { scroll: false });
    // 顶栏搜索一并写入最近搜索（此前只有首页会记录）
    searchHistory.record(q);
  };

  const pickHistory = (text: string) => {
    setQuery(text);
    submitSearch(text);
  };

  // 手机遥控点「设置」：电脑端没有独立的设置页，直接把顶栏的设置抽屉拉起来
  useEffect(() => {
    const onRc = () => setSettingsOpen(true);
    window.addEventListener('mfl:rc-settings', onRc);
    return () => window.removeEventListener('mfl:rc-settings', onRc);
  }, []);

  return (
    <>
      <header
        className={
          'sticky top-0 z-40 transition-[transform,background-color,box-shadow] duration-300 will-change-transform ' +
          (hidden ? '-translate-y-full' : 'translate-y-0') + ' ' +
          (scrolled ? 'bg-page/95 backdrop-blur border-b border-line shadow-[0_10px_30px_-18px_rgba(0,0,0,.9)]' : 'bg-gradient-to-b from-black/70 to-transparent')
        }
      >
        <div className="max-w-[1240px] mx-auto px-4 sm:px-6 h-16 flex items-center gap-3">
          <Link href="/" aria-label="MFlixTV 首页" className="flex items-center shrink-0">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/icons/icon-512.png" alt="MFlixTV" className="w-8 h-8 rounded-lg" />
          </Link>

          {showSearch && (
            <form
              className="flex-1 max-w-xl hidden sm:block"
              onSubmit={(e) => {
                e.preventDefault();
                submitSearch(query);
              }}
            >
              <div ref={searchHistory.containerRef} className="relative">
                <input
                  className={cn(
                    'input w-full h-10',
                    // 展开时：上圆角与外框沿用聚焦样式，底边改为内部分隔线，与下拉拼成同一面板
                    searchHistory.visible &&
                      'rounded-b-none border-accent border-b-line bg-surface-raised focus-visible:ring-0'
                  )}
                  aria-label="搜索影片"
                  placeholder="搜索影片 / 演员…"
                  value={query}
                  maxLength={100}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    searchHistory.resetActive();
                  }}
                  onFocus={searchHistory.onFocus}
                  onKeyDown={(e) => searchHistory.onKeyDown(e, pickHistory)}
                  role="combobox"
                  aria-expanded={searchHistory.visible}
                  aria-controls="header-search-history"
                  aria-autocomplete="list"
                  aria-activedescendant={
                    searchHistory.visible && searchHistory.activeIndex >= 0
                      ? `header-search-history-${searchHistory.activeIndex}`
                      : undefined
                  }
                />
                {searchHistory.visible && (
                  <SearchHistoryDropdown
                    id="header-search-history"
                    matches={searchHistory.matches}
                    activeIndex={searchHistory.activeIndex}
                    onPick={pickHistory}
                    onRemove={searchHistory.remove}
                    onClearAll={searchHistory.clearAll}
                  />
                )}
              </div>
            </form>
          )}

          <div className="flex-1 sm:hidden" />

          <nav className="flex items-center gap-0.5 sm:gap-1 ml-auto shrink-0">
            <HeaderLink href="/hongguo" active={pathname === '/hongguo'}>
              <span className="brand-gradient font-medium">MFlixTV短剧</span>
            </HeaderLink>
            <HeaderLink href="/live" active={pathname === '/live'}>
              直播
            </HeaderLink>
            {/* 追剧日历：手机宽度放不下，首页「本周追剧」模块里有同一个入口 */}
            <span className="hidden sm:block">
              <HeaderLink href="/calendar" active={pathname === '/calendar'}>
                追剧日历
              </HeaderLink>
            </span>
            {/* 手机宽度下这一行放不下「关于」，先收起来：关于页仍可从页脚进入 */}
            <span className="hidden sm:block">
              <HeaderLink href="/about" active={pathname === '/about'}>
                关于
              </HeaderLink>
            </span>
            <LanBadge />
            <RemoteHost />
            <ThemeToggle />
            <IconButton label="观看历史" onClick={() => setHistoryOpen(true)}>
              <Icon name="clock" />
            </IconButton>
            <IconButton label="下载管理" onClick={requestShowDownloadManager}>
              <Icon name="download" />
            </IconButton>
            <IconButton label="设置" onClick={() => setSettingsOpen(true)}>
              <Icon name="gear" />
            </IconButton>
          </nav>
        </div>
      </header>

      <SourceManagerDrawer open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <HistoryPanel open={historyOpen} onClose={() => setHistoryOpen(false)} />
    </>
  );
}

function HeaderLink({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className={cn(
        'px-2 sm:px-3 py-2 rounded-lg text-[13.5px] sm:text-[15px] font-medium whitespace-nowrap shrink-0 transition-colors',
        active ? 'text-content bg-hover' : 'text-muted hover:text-content'
      )}
    >
      {children}
    </Link>
  );
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      className="p-2 sm:p-2.5 rounded-lg text-muted hover:text-content hover:bg-hover transition-colors"
      title={label}
      aria-label={label}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
