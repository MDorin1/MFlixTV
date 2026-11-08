# P0 四项 · 落地状态表（谁说、哪版、哪一行）

这张表只回答一个问题：**某一项到底有没有进包、进的是哪一版、代码在第几行。**
每次再被问“这项做了没有”，先看这里，再跑 `tools\verify-p0.ps1`（它会打印当版实测数字），不要拿旧版本的包或旧 commit 下结论。

查表前先确认两件事：

```
git log --oneline -1          # 当前 HEAD
powershell -NoProfile -ExecutionPolicy Bypass -File tools\verify-p0.ps1
```

| # | 事项 | 进了哪版 | commit | 代码位置 |
| --- | --- | --- | --- | --- |
| 1 | 两端搜索排序：标题精确度 → `recencyYear` → 片名/源名 | **1.21** | `657e244` | PC：`app/src/lib/search-sort.ts:19 titleRank()` / `:30 sortYear()` / `:35 sortSearchResults()`，由 `app/src/app/api/search/route.ts:173` 调用；安卓：`Sources.kt:461-463`，`Freshness.kt:118 titleRank()` |
| 2 | 安卓搜索页「最近搜索」（`localStorage`） | **1.18** | `f4f7efe` 起 | `tv.html:2222 recentWords()`、`:2231` 写入、`:2236` 删单条；键名 `mfl:recent`，最多 8 条 |
| 3 | 安卓第二块改名「最近更新」（取 `/api/home` 前 10 条片名） | **1.22** | `738767b` | `tv.html:2194 var HOT_LABEL = '最近更新'`；片单为空时 `:2205` 标题与胶囊整块 `display:none` |
| 4 | 安卓补新鲜度 / 连载综艺年份 / 归档 | **1.20** | `9623664` | `Freshness.kt:47 latestEpisodeDate()`、`:88 recencyYear()`、`:155 isArchived()`（`ARCHIVE_DAYS=90`，只认 remarks）、`:137 latestInRaw()`；显示层 `SourceDetail.kt:41/49`、`SourceHealth.kt:178-179/198-202`；路由 `WebServer.kt:248` |

## 各项的验证方式（本机可复现）

| 判据 | 命令 | 通过标准 |
| --- | --- | --- |
| 源码命中 | `tools\verify-p0.ps1` 第 1 段 | `dateSource` / `archived` / `recencyYear` / `latestEpisodeDate` 均非 0 |
| 包里有没有 | `tools\verify-p0.ps1` 第 2 段（解 `classes.dex` 搜字符串） | 全部 HIT |
| 运行态字段 | 设备上 `curl http://127.0.0.1:8080/api/sources/health` | 每个源带 `dateSource` 与 `archived` |
| 两端顺序一致 | `D:\Build\_tvtest\search-order.js sweep` + `diff` | 同一关键词两端顺序相同（需 PC 服务与设备同时在线） |

## 为什么会有“做了但被判定没做”

2026-11-09 那天连着三次被判定“四项一件没进”，三次的取证对象都是 **1.16 / 1.17 的包与 `4b54dda`**，而当时 HEAD 已经是 1.20–1.22。四项其实分三版落地：

- 1.20（`9623664`）第 4 项
- 1.21（`657e244`）第 1 项
- 1.22（`738767b`）第 3 项

教训：**验收前先 `git pull` + 认当前 `versionCode`**，再用 `tools\verify-p0.ps1` 打印当版数字。拿旧包 grep 只能证明旧包没有这项，不能证明现在没有。
