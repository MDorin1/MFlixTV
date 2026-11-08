# 双端实现对照（安卓 / PC）

> 为什么要这份表：同一个功能在安卓端（Kotlin，`android/`）和 PC 端（Next.js，`app/`）**各写了一遍**。
> 2026-11 出过一次事故：[片源新鲜度] 与 [连载综艺年份排序] 只在 PC 端实现，安卓端一条没有，
> 用户在电视上拿到的是旧行为。这份表用来在每次改动后逐项检查，而不是靠"记得两边都改"。

**判定口径**（三项都过才算"一致"）：

1. **行为**：同样的输入，两端用户看到的结果一样；
2. **文案**：同一件事的数字/措辞一样（例：`2016起`、`更新至 2025-10-20`、`最新一集 2025-10-20 · 源 12 个月前更新`）；
3. **排序**：同样的候选集合，两端排列顺序一样。

**证据级别**：`已核` = 读过代码并取过关键行号；`抽检` = 看过结构与排序，未逐条对拍；`待对拍` = 只确认了入口存在。

---

## 一、必须保持一致（八项）

| # | 功能 | 安卓端位置 | PC 端位置 | 是否一致 | 证据 |
| --- | --- | --- | --- | --- | --- |
| 1 | 首页片单 | `WebServer.kt:153` `/api/home` → `home()` `:420`；片单骨架 `Sources.kt:485 HOME_ROWS` | `api/category/route.ts`（`?tab=movie\|tv&cat=`）+ `api/douban/route.ts` | **结构不一致** | 已核。安卓返回 `{rows:[{title,items}]}`；PC 返回 `{items[],sources,failures,complete}`。两端前端各自消费，**不能互相替换** |
| 2 | 搜索 | `WebServer.kt:165` → `Sources.search()` `Sources.kt:437-463` | `api/search/route.ts`（每源 `{sourceKey,ok,list}`） | **P0 · 排序口径不一致，两端都缺统一规则** | 已核。安卓 `:456-458` 按 `year` 降序 + `remarks` 含「更新」；PC `:169-176` 的 `list.sort` 三键是「`normalizeTitle` 精确度（`:170`）→ `name` 的 `localeCompare`（`:173`）→ `sourceName`（`:175`）」，**没有"最新一期"这一键**。两端都不符合新规则，见下 |
| 3 | 详情与多线路 | `WebServer.kt:187` `/api/detail` → `SourceDetail.kt`；`:167` `/api/lines` | `api/detail/route.ts`（`groups` 自带多线路，无独立 lines 接口） | 功能一致，接口拆分不同 | 抽检。安卓拆两个接口是给 `tv.html` 直接调；PC 合在 detail 里 |
| 4 | 片源列表与新鲜度、归档 | `WebServer.kt:195` `/api/sources`、`:248` `/api/sources/health` → `SourceHealth.kt` | `api/sources/health/route.ts` + `lib/source-freshness.ts`（`ARCHIVE_DAYS=90`） | **不一致：安卓端零实现** | 已核。安卓三个源文件搜 `dateSource`/`archived`/`latestDate` **命中 0 / 0 / 0**；PC 命中 25 / 17 / 15 |
| 5 | 连载综艺年份与最新一期排序 | `Sources.kt:456-458`（仅 `year` + `remarks` 含更新）、`:609` | `lib/remarks.ts:45 latestEpisodeDate`、`:69 formatRemarks`、`:114 recencyYear`；唯一调用点 `app/page.tsx:193` | **不一致：安卓端零实现** | 已核。安卓搜 `latestEpisodeDate`/`recencyYear`/`formatRemarks` **命中 0 / 0 / 0**；PC 命中 21 / 11 / 39 |
| 6 | 日历 | `WebServer.kt:156` `/api/calendar` → `Calendar.kt` | `api/calendar/route.ts` + `lib/calendar.ts` | 两端都有，未对拍 | 待对拍 |
| 7 | 弹幕 | `WebServer.kt:269` `/api/danmaku` → `Danmaku.kt` | `api/danmaku/route.ts` + `lib/danmaku.ts` | 两端都有，未对拍 | 待对拍 |
| 8 | 代理与遥控 | `WebServer.kt:265` `/api/proxy` → `proxy()` `:821`；`:223/:231` remote push/poll；`:241-246` `/api/rs/*` → `Net.kt` / `Remote.kt` / `RemoteSession.kt` | `api/proxy/*`、`api/remote/*`、`api/rs/[action]` + `lib/proxy-handlers.ts` / `lib/remote-*.ts` | 两端都有，未对拍 | 待对拍 |

### 已确认的不一致（按优先级）

**P0 — 第 2 项：搜索排序（两端都缺，规则统一）**

排序规则（2026-11-08 定，两端同一套，不许各自保留一套）：

1. **标题完全相同置顶**：`normalizeTitle` 归一（去空白 / 中英标点与符号 / 英文小写）后完全相等排最前，其余一律平等；
2. **同档内按最新一期日期排**：用 `recencyYear`（已解析出 `latestEpisodeDate` 的用那一年），日期新的在前；
3. **再相同按原始标题**，保证同一输入两次结果一致（稳定排序，不能随源返回顺序抖动）。

**两档，不是三档**（2026-11-08 定稿）：不做"前缀档 / 包含档"。整条排序里精确命中是用户唯一看得出的区别（搜「小明星大跟班」时正主必须在第一张），前缀与包含的先后在电视上分辨不出来，两端各写一遍反而容易写出偏差。

落点（按工区现状，1.20 补丁 v2）：

- 安卓：`Sources.kt:458-462` 现在已是 `compareByDescending { optInt("recencyYear", year) }` + `thenByDescending { latestDate }` + `thenByDescending { remarks 含"更新" }`（新鲜度那批活已完成，不回滚）。还要**在它前面补精确置顶键、后面补片名 / 源名两键**，并加 `normTitle`；`search(wd: String)` 在 `:437`，`fun item(` 在 `:471`，源名字段叫 `srcName`（`:493`）。
- PC：`api/search/route.ts:172-175` 现在是「精确度 → 片名 → 源名」三键，缺的正是第 2 键；在 `:172` 与 `:173` 之间插入 `recencyYear` 比较，片名与源名留作兜底。`recencyYear`（`lib/remarks.ts:114`）与 `latestEpisodeDate`（`:45`）都是现成的，不加字段——**`recencyYear` 此前唯一调用点是 `app/page.tsx:193`（首页分组排序），搜索接口一次都没用过**。

为什么是 P0：`vod_year=2016` 的《小明星大跟班》，安卓按 `year` 降序会被 2024/2025 的无关结果压到后面；PC 虽然精确匹配在前，同档内也没有"最新一期"这把尺。用户最初那条「没有 2026」的问题，一半是第 4 项新鲜度没实现，另一半就是这里。

验收：搜「小明星大跟班」，两端第一条都是它；搜一个精确片名 + 若干近似标题，精确匹配必须在第 1 位；同一输入连跑两次顺序完全一致。

验收命令（A 组，1.20）：

```powershell
Select-String -Path app\src\app\api\search\route.ts -Pattern "recencyYear"                      # 期望 >= 2
Select-String -Path android\app\src\main\java\com\mflixtv\app\Sources.kt -Pattern "normTitle"   # 期望 >= 2
Select-String -Path android\app\src\main\assets\tv.html -Pattern "热门搜索"                      # 期望 0
```

**搜索页热词：两端实现方式不同，但文案各自诚实，不需要对齐**（2026-11-08 定，不进 P0）

| | 第二块数据来源 | 界面文案 | 为什么这么定 |
| --- | --- | --- | --- |
| 安卓 / TV | `WebServer.kt` `/api/home` 已拉到的数据取前 10 条片名 | **「最近更新」** | 数据本来就在本地，不增请求；文案与数据对得上 |
| PC | `api/hot-list/route.ts`（必带 `id`，`isHotListId` 校验后走 `lib/douban-weekly` 的 60s API：豆瓣五个周榜 + 百度热搜，服务端转发 + 缓存） | **「热搜」** | 本来就是真榜单 |

不补安卓 `/api/hot-list` 的理由：那要为搜索页一行热词在 Kotlin 里再写一遍第三方网络依赖和一整套缓存，不值得。

**第一块「最近搜索」两端都做**，`localStorage` 本地存，零成本——这才是遥控器用户最需要的：打完一次「小明星大跟班」，下次直接点。

**真正的问题从来不是"用了首页片名"，而是把片名标成了"热词"。** 文案改成「最近更新」就没人会误会；这条同时也是"文案必须与数据来源一致"的第一个实例。

**P0 — 第 4 项：新鲜度与归档（安卓端为零）**

安卓端需要补：

- `latestEpisodeDate(remarks)`：从备注里取最新一期日期（认 `20251020` / `2025-10-20` / 点号写法，纯年份与集数不误判）
- `recencyYear(year, latestDate)`：最新一期跨年时用那一年的年份参与排序
- `/api/sources/health` 每个源返回 `dateSource: "remarks" | "vod_time"`、`latestDate`、`ageDays`、`archived`
- 归档判定**只认 `remarks`**：备注里没有日期的一律不判归档（`vod_time` 是采集站上架时间，判不了"还更不更新"）

对齐基准：`app/src/lib/source-freshness.ts`（`ARCHIVE_DAYS=90`、`isArchivedSource`、`freshnessLabel`）。

**P1 — 第 5 项：年份显示与排序**

安卓端 `Sources.kt:456-458` 的排序要换成 PC 口径：

- 卡片年份：最新一期跨年显示 `2016起`，不显示 `2016`
- 备注：`更新至20251020期` → `更新至 2025-10-20`（`formatRemarks`）
- 排序：用 `recencyYear()` 的结果参与，而不是裸 `vod_year`

对齐基准：`app/src/lib/remarks.ts`。

**一个容易漏的点**：PC 端 `recencyYear` 目前只在 `app/page.tsx:193`（首页分组排序）里用，**搜索接口没用**。第 2 项要求的"同档内按最新一期排"就是这条的补法——两端都要接，不是安卓单方面缺。

### 结构差异不算缺陷（但要知道）

第 1 项与第 3 项：安卓是"一个接口一件事"（`/api/home`、`/api/lines`），PC 是"一个接口带多份数据"（`category` 带 `items` + `sources`；`detail` 带 `groups`）。
两端的**前端也是两套**（`tv.html` / `index.html` vs Next 页面），所以接口形状不同是正常的，**不要为了"看起来一致"去改形状**，那会把 `tv.html` 打断。

---

## 二、单端能力（不需要对齐）

这些是设备能力或桌面能力，另一端没有是设计如此，**不要当成缺口去补**：

| 端 | 独有能力 | 说明 |
| --- | --- | --- |
| 安卓 | `/api/wakelock`、`/api/netcfg`、`/api/cache`、`/api/speed`、`/api/warm`、`/api/diag`、`/api/list.m3u`、`/api/hero`、`/api/series`、`/api/sources/save\|reset\|import\|export\|autofix`、`/api/rs/*` | 电视/手机上跑在设备里：屏幕常亮、本机网络配置、本地缓存、测速、预暖、诊断、导出播放列表、本机片源增删改、扫码遥控会话 |
| PC | `/api/auth`、`/api/history`、`/api/lan(+qr)`、`/api/publish`、`/api/quality`、`/api/source-list`、`/api/hot-list`、`/api/bangumi`、`/api/category`、`/api/douban/*` | 桌面才有的：登录口令、观看历史、局域网地址与二维码、源清单发布与订阅、画质探测、豆瓣榜单与条目 |

判断某条属不属于"必须一致"的方法：**问用户会不会在两个端上看到同一个东西**。
看到同一个片单、同一个搜索结果、同一个集数日期 → 必须一致。只在自己那台设备上才有的功能 → 单端。

---

## 三、改动后怎么验（对拍流程）

1. 同一部片（建议用连载综艺，例：长期在更的台综）在两端各搜一次，抓 `/api/search` 原始响应，比 `year`、`remarks`、排序；**并核对第 2 项那三条排序规则**（精确度 → 最新一期 → 原始标题），同一输入连跑两次顺序必须一致；
2. 打开首页，比第一排的分组名与该组内顺序；
3. 打开片源健康页，比每个源的 `latestDate` / `ageDays` / `archived` / `dateSource` 是否有值；
4. 详情页标题下那两行：`2016 起 · 台 · 港台综艺 · 更新至 2025-10-20` 与 `最新一集 2025-10-20 · 源 12 个月前更新`，两端文案逐字比；
5. 差异写回本表第「是否一致」列，并把判定依据（文件:行号）补上。

---

## 四、维护规则

1. **凡是判定逻辑、显示文案、排序规则的改动，两边都要落，落一边算没做**（等同于没改）。
2. 改一端时，先在本表找到对应行，改完把「是否一致」改成 `待对拍`，验过再改回 `一致`。
3. 新增功能先判断它属于"必须一致"还是"单端能力"，判断依据写在这份表里，别在群里口头定。
4. 本表以**用户可见行为**为单位，不以接口路径为单位；接口路径不同但行为一致，算一致。
5. **文案必须与数据来源一致**：数据来自首页片单就不写"热搜"，来自真榜单才写"热搜"。来源不同、文案各自诚实的情况不算不一致（例：搜索页第二块，安卓「最近更新」vs PC「热搜」）。
