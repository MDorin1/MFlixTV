# hongguo-web 内核补丁：透传 `content_type`

MFlixTV 的短剧专区页用 [sunnysky123/hongguo-web](https://github.com/sunnysky123/hongguo-web) 作为取流内核，它本身是独立仓库（MIT），**不随本仓库分发**。本仓库只提供一行补丁：让内核把上游的体裁标识 `content_type` 透出到 API 结果里。

## 为什么需要

上游（字节系）的剧集数据里，`content_type` 是**唯一可靠的体裁信号**：

| 值 | 含义 |
| --- | --- |
| `1` | 真人短剧（真实拍摄） |
| `1004` | 漫剧 / AI 短剧（合成画面） |

hongguo-web 在解析时把这个字段丢掉了。缺了它，前端只能靠标题/封面/标签猜，结果就是「点真人剧进去 99% 都是 AIGC 漫剧」。

补上之后，短剧页按 `content_type` 精确筛：

- 真人剧：`content_type === 1`
- AI短剧：`content_type === 1004` 且排除官方漫剧榜里的条目
- 漫剧：走官方三个榜单接口（`recommend` / `hot` / `new`）

## 补哪里

`server/src/service/client.js`，两处解析函数，各加一行：

| 位置 | 函数 | 加的内容 |
| --- | --- | --- |
| 搜索结果 / 剧集详情解析 | `parseSearchCell` 附近，`out.duration` 之后 | `out.content_type = num(vdata, 'content_type');` |
| 榜单分页解析 | 榜单 `row.abstract` 之后 | `row.content_type = num(v, 'content_type');` |

`num()` 是文件里已有的取值助手，不用新增函数。

## 怎么打

```powershell
powershell -ExecutionPolicy Bypass -File hongguo\patch-content-type.ps1 -Target .\hongguo-web\server\src\service\client.js
```

脚本是**幂等**的：已经打过就报「已是最新」直接退出，不会重复插入；打之前留一份 `.bak-content-type` 备份。

macOS / Linux 上不用跑脚本，手改两行即可（`grep -n "out.duration\|row.abstract" client.js` 定位）：

```diff
   out.duration = num(vdata, 'duration');
+  out.content_type = num(vdata, 'content_type');
```

```diff
   row.abstract = strip(str(v, 'video_desc'), 50);
+  row.content_type = num(v, 'content_type');
```

## 注意：升级内核要重打

`node server/src/main.js` 的内核是上游仓库的源码，`tools/update.ps1 -Part kernel` 拉新版时会覆盖 `server/src`（旧版备份成 `src.bak-时间戳`），补丁因此丢失。更新脚本里已经内置重打逻辑（`Update-ContentTypePatch`），手动升级的话记得自己跑一遍上面的命令。

补丁本质上是 `num()` 一行，上游哪天自己透出 `content_type` 了，补丁脚本会检测到已有该字段并跳过。

---

# 内核补丁二：下载不再整块进内存（1.9）

同一套内核，`server/src/util/http.js` 与 `server/src/service/stream.js` 换成 [`patched/`](patched/) 里的版本。

## 为什么需要

内核下载一集分 4 段 Range 并发，老实现是每段各自把整个响应体攒成 Buffer、再顺次落到磁盘；单连接回退分支直接 `writeFileSync` 一整个 body；`Http.send` 本身也是攒全量再 `Buffer.concat`。

一集 100–200MB、预取并发 4 路，峰值内存能顶到几百 MB 到 GB 级。

## 改成什么

- `http.js` 新增 `downloadTo()` / `downloadToOnce()`：跟随重定向，非 2xx 不写盘只回状态；收到一块就 `pause()` → 异步 `fs.write`（按 `base + written` 绝对位置）→ `resume()`，最后一块真正落盘后才返回。
- `stream.js` 的 `downloadParallel()` 在同一个 fd 上按各自 `position` 并发写，不再各自攒 Buffer；慢路 `download()` 同样流式写，失败回滚删 `.part`。

160MB / 4 段并发实测：**431–605ms / +215~+291MB → 382–387ms / +36~+37MB**。正确性用 40MB 随机文件比对 sha256，两条路径都逐字节一致（顺带修掉单连接路径少算最后 65536 字节的老 bug）。

## 怎么打

不用手改。`packaging/build-portable.ps1` 复制完内核源码后会直接用 `hongguo/patched/` 覆盖这两个文件；`tools/update.ps1` 升级内核时也会先把这两个文件留一份、换完源码再放回去。

手动升级内核的话，复制过去即可：

```powershell
Copy-Item hongguo\patched\http.js   .\hongguo-web\server\src\util\http.js    -Force
Copy-Item hongguo\patched\stream.js .\hongguo-web\server\src\service\stream.js -Force
```

> 这两个文件是**基于当时上游版本的完整副本**。上游要是大改了下载逻辑（换了接口协议），直接覆盖可能不兼容，那时要按上面对照着重做一次，而不是无脑覆盖。
