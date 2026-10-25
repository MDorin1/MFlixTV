# LibreTV Desktop

把开源的影视聚合站点 [LibreTV](https://github.com/LibreSpark/LibreTV) 做成**能在 Windows 上双击安装、在 macOS 上解压即用的桌面应用**，并接入了**红果短剧**专区（体裁分类 / 观看历史 / 换源续播）。

> 本项目是 LibreTV 的桌面封装与二次开发分支，遵循上游 **AGPL-3.0** 许可。
> 软件只做「聚合与播放」，**不存储、不托管、不分发任何影视内容**，所有资源来自用户自行配置的第三方接口。

---

## 目录

- [功能](#功能)
- [截图](#截图)
- [快速开始](#快速开始)
- [红果短剧专区](#红果短剧专区)
- [点播源与自动补源](#点播源与自动补源)
- [更新机制](#更新机制)
- [从源码运行](#从源码运行)
- [打包](#打包)
- [项目结构](#项目结构)
- [已知限制](#已知限制)
- [许可与致谢](#许可与致谢)

---

## 功能

**影视聚合**
- 多采集站（苹果CMS）并行搜索，同名影片自动合并成一张卡片，可展开比较各源
- 播放内核 ArtPlayer + hls.js，广告分片过滤、跳过片头片尾、倍速、快捷键
- 直播（M3U / IPTV），带分组、搜索、EPG 节目单
- 首页推荐：豆瓣分类 / 影视榜单

**红果短剧专区（本项目新增）**
- **两层导航**：真人剧 / 漫剧 / AI短剧 → 各自的推荐 / 热播 / 新剧
- **观看历史**：按「剧 + 集」双维度记录进度，切回任意一集都接着上次的秒数
- **继续观看**：首页横排卡片，一键回到上次位置
- **换源续播**：同名剧换源后回到同一集，进度**只往前挪 10 秒**（不同源码率不同，往后挪必然漏剧情）
- **收藏 / 已看标记 / 连播倒计时 / 倍速记忆**
- 播放器快捷键（空格、←→、F、Esc），手机端双击暂停、左右滑动、长按 3 倍速
- 服务端历史同步：换浏览器、换设备登录同一站点，历史自动合并

**桌面体验**
- Windows：自带 Node 运行时与 ffmpeg，安装后双击即用，托盘常驻
- macOS：解压后双击 `.command` 启动
- 每天/按需检查更新：拉取红果内核新版、自动从公开列表补充可用点播源

---

## 截图

| 首页（豆瓣推荐） | 搜索结果（跨源合并） |
| --- | --- |
| ![首页](docs/images/home.png) | ![搜索](docs/images/search.png) |

| 影片详情 | 播放器（选集 / 换源在控制条） |
| --- | --- |
| ![详情](docs/images/detail.png) | ![播放器](docs/images/player-episodes.png) |

| 红果短剧 · 漫剧榜 | 红果短剧 · 真人剧 |
| --- | --- |
| ![红果漫剧](docs/images/hongguo-comic.png) | ![红果真人剧](docs/images/hongguo-real.png) |

| 继续观看（历史） | 手机端播放器 |
| --- | --- |
| ![历史](docs/images/history.png) | ![手机](docs/images/mobile-player.png) |

---

## 快速开始

### Windows（推荐）

1. 打开 [Releases](../../releases) 下载 `LibreTV-Setup-x.y.z.exe`
2. 安装（可选桌面快捷方式），双击 **LibreTV**
3. 浏览器自动打开 `http://localhost:8080`，默认密码 **`libretv`**
4. 退出：托盘图标右键 →「退出」

> 未做代码签名，首次运行 Windows 会提示「未知发布者」，点「更多信息 → 仍要运行」。

### macOS

1. 下载 `LibreTV-macOS-arm64.zip`（Apple 芯片）或 `x64` 版本
2. 解压后双击 `启动LibreTV.command`
3. 首次可能被 Gatekeeper 拦：右键 → 打开，或执行 `xattr -dr com.apple.quarantine ./LibreTV-macOS`

### 改密码

编辑 `app/.env`（Windows 安装版在 `%LOCALAPPDATA%\Programs\LibreTV\app\.env`）里的 `PASSWORD=`，重启应用。

---

## 红果短剧专区

入口：顶栏「红果短剧」，或首页的入口卡片。

**数据来源说明**

上游（字节系）的接口里，只有「漫剧」开放了官方榜单接口；真人剧与 AI 短剧的目录接口目前返回空。因此：

| 体裁 | 数据来源 |
| --- | --- |
| 漫剧 | 官方三榜（推荐 / 热播 / 新剧） |
| 真人剧 | 关键词聚合搜索 + 上游 `content_type=1` 精确过滤（真实拍摄） |
| AI短剧 | 上游 `content_type=1004` 且排除官方漫剧榜条目（合成画面） |

> `content_type` 这个字段是上游返回的体裁标识，最初的复刻项目把它丢弃了，本项目打补丁透传（见 `hongguo/PATCH.md`）。

**播放链路**

```
LibreTV 页面 → /hg-api/* → 本机 hongguo-web 服务(127.0.0.1:8000)
                ↓
             签名 → 取直链 → 下载 → CENC 解密 → ffmpeg 转 H.264 → 直出 mp4
```

- 同源转发：浏览器只跟 8080 打交道，不开额外端口、不撞 CORS
- 首播需 10–20 秒（下载 + 解密 + 转码），之后同一集命中缓存秒开
- 缓存上限 120 集，自动淘汰最旧的

---

## 点播源与自动补源

内置一批苹果CMS 采集站，另外每次体检会**从公开的 TVBox 配置里抓新的直连接口**：

```
内置候选池(24) + 当前配置 + 远程列表(qist/tvbox、gaotianliuyun/gao)
   ↓ 分批并发探活（关键词「庆余年」+ 校验标题真的命中，防止"假搜索站"）
   ↓ 已知快源优先（按实测拉流速度白名单）
   ↓ 只保留 6 个 → 写回 .env
```

**为什么是 6 个、为什么按拉流速度排**：搜索快 ≠ 播放快。实测中有的站搜索 600ms 但拉流只有 18KB/s，播起来必卡。白名单在 `tools/update.ps1` 的 `$FAST_HOSTS`。

手动体检：托盘菜单 →「检查更新（红果内核 + 点播源）」；或命令行

```powershell
powershell -ExecutionPolicy Bypass -File tools\update.ps1 -Part sources
```

测自己的源速度：

```powershell
powershell -ExecutionPolicy Bypass -File tools\bench-sources.ps1
```

---

## 更新机制

`tools/update.ps1` 支持三种模式：

| 参数 | 作用 |
| --- | --- |
| `-Part kernel` | 拉取 [hongguo-web](https://github.com/sunnysky123/hongguo-web) 最新源码，备份旧内核（`src.bak-时间戳`），重新打 `content_type` 补丁，重启红果服务 |
| `-Part sources` | 点播源体检 + 从公开列表补新源，写回 `.env` |
| `-Part all` | 两者都做（默认） |

- 下载走 4 个镜像（codeload / gh-proxy / ghfast / ghproxy.net）
- 源列表没实质变化时不写盘、不重启，避免打断观看
- 日志：`logs/update.log`

> ⚠️ 红果内核是第三方逆向项目，上游一改签名算法就会失效，只能等对方更新。这是这条路线的固有风险。

---

## 从源码运行

需要 Node.js 20+ 与本机可用的 `ffmpeg`（红果转码用）。

```bash
# 1) 主站
cd app
npm install
cp .env.example .env      # 填 PASSWORD
npm run build
npm start                 # http://localhost:8080

# 2) 红果服务（另开一个终端）
git clone https://github.com/sunnysky123/hongguo-web hongguo-web
cd hongguo-web
# 打补丁：透传 content_type
powershell -ExecutionPolicy Bypass -File ../hongguo/patch-content-type.ps1 -Target ./server/src/service/client.js
PORT=8000 BIND_HOST=127.0.0.1 HG_TRANSCODE=1 node server/src/main.js
```

`app/next.config.ts` 里把 `/hg-api/*` 转发到 `http://127.0.0.1:8000`，可用环境变量 `HONGGUO_API` 覆盖。

---

## 打包

### Windows 安装包

```powershell
# 1) 组装便携目录（node/ffmpeg/app/hongguo/launcher）
powershell -ExecutionPolicy Bypass -File packaging\build-portable.ps1 -Out D:\Build\LibreTV\stage

# 2) 编译启动器（需要 .NET Framework 的 csc）
csc /target:winexe /out:stage\LibreTV.exe /win32icon:packaging\app.ico `
    /r:System.Windows.Forms.dll /r:System.Drawing.dll packaging\Launcher.cs

# 3) 用 Inno Setup 6 编译 packaging\LibreTV.iss
ISCC.exe packaging\LibreTV.iss
```

### macOS

发布物是**解压即用的便携目录**（不是 `.app`/`.dmg`：那需要 Apple 开发者签名与公证）。目录结构、运行时来源、`.command` 的换行符坑、压缩命令，都写在 [packaging/README.md](packaging/README.md) 的「macOS 便携包」一节。当前只出 Apple 芯片（arm64）版。

CI（[.github/workflows/build.yml](.github/workflows/build.yml)）只做 `next build` + `.ps1` 语法校验，**不出安装包** —— 安装包要内置 Node 运行时和 ffmpeg，体积上百 MB，放本地打更省事。

---

## 项目结构

```
.
├── app/                     Next.js 应用（LibreTV 源码 + 红果专区 + 桌面对接）
│   └── src/app/hongguo/     红果短剧页面
│   └── src/app/api/history/ 观看历史同步接口
├── packaging/               Windows 启动器(C#)、Inno Setup 脚本、便携目录组装脚本
├── tools/                   update.ps1（热更新）、bench-sources.ps1（源测速）
├── hongguo/                 上游内核补丁说明与补丁脚本
├── docs/                    架构、FAQ、截图
└── .github/workflows/       构建校验（next build + ps1 语法）
```

---

## 已知限制

1. **没有代码签名**：Windows SmartScreen 会提示未知发布者；macOS 需手动放行。
2. **红果首播慢**：单集需下载 + 解密 + 转码，约 10–20 秒；命中缓存后秒开。
3. **红果依赖上游逆向**：签名或接口一变就失效，要等 hongguo-web 跟进。
4. **播放器未统一到 ArtPlayer**：红果页用原生 `<video>`（保留画中画/全屏），红果该有的倍速记忆、快捷键、手势已用原生方式补齐。
5. **只支持 x64（Windows）**，ARM64 Windows 未打包。

---

## 许可与致谢

- 本项目：**AGPL-3.0-or-later**（继承上游 LibreTV）
- [LibreSpark/LibreTV](https://github.com/LibreSpark/LibreTV)：影视聚合站点本体，AGPL-3.0
- [sunnysky123/hongguo-web](https://github.com/sunnysky123/hongguo-web)：红果短剧网页版内核，MIT
- [ArtPlayer](https://github.com/zhw2590582/ArtPlayer)、[hls.js](https://github.com/video-dev/hls.js)：播放内核
- Node.js、FFmpeg：运行时与转码（FFmpeg 二进制遵循其各自许可）

完整第三方声明见 [NOTICE.md](NOTICE.md)。版本变更见 [CHANGELOG.md](CHANGELOG.md)。

---

## 免责声明

本项目仅供**个人学习与技术研究**使用，不提供、不存储、不分发任何影视内容。

所有影视资源均来自用户自行配置的第三方接口，与本项目无关。请遵守你所在地区的法律法规与内容服务条款，不要用于商业用途或大规模传播。因使用本软件产生的任何后果由使用者自行承担。
