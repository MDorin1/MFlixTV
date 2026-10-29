# iOS 与 Apple TV（tvOS）端开发研究

> 调研日期：2026-10-30 · 面向 MFlixTV（现有 Android / 电视 / PC / 网页端）
> 结论先行，后面才是细节与依据。

## 0. 三句话结论

1. **iOS 端能复用现有网页**：做一个 `WKWebView` 壳 + 原生桥（页面已经在调 `window.MFlixNative.*`），播放沿用 Safari 那套原生 HLS 硬解。工作量 2–3 天，体验接近原生 App。
2. **Apple TV 必须原生重写界面**：tvOS **没有 WebKit**，`WKWebView` 在 Apple 文档里的平台列表是 iOS / iPadOS / Mac Catalyst / macOS / visionOS，**不含 tvOS**。所以现有 `tv.html` 搬不过去，10 英尺界面要用 SwiftUI 重新实现，播放用 `AVPlayer`。MVP（能浏览 + 能看）估 1–2 周。
3. **Apple TV 的"服务端"继续跑在 PC 或安卓手机上**：`nodejs-mobile` 只发 Android / iOS 二进制，tvOS 也禁止 JIT，把 Node 塞进 Apple TV 这条路不通。想让 Apple TV 完全独立（不依赖别的设备），得把服务端移植成 Swift —— 第二阶段的事，估 2–3 周。

## 1. 硬约束（已核实，不是猜）

| # | 限制 | 事实 | 对项目的直接影响 |
|---|---|---|---|
| 1 | tvOS 没有 WebKit | Apple 文档 `WKWebView` 的 `platforms` 只有 iOS / iPadOS / Mac Catalyst / macOS / visionOS | `tv.html` 一行都用不上，界面必须原生重写 |
| 2 | tvOS 不能跑 Node | [nodejs-mobile](https://github.com/nodejs-mobile/nodejs-mobile) README：*Binaries for Android and iOS* | Android 那套"内嵌 Node 20 服务端"方案在 tvOS 上不可复制 |
| 3 | tvOS / iOS 禁止 JIT | 只有 JavaScriptCore 能 JIT，V8 必须 `--jitless` | 就算硬编出 V8，性能也撑不住 Next 15；这条路直接否掉 |
| 4 | ATS 拦明文 HTTP | `http://192.168.x.x:8080` 默认被 App Transport Security 拒绝 | Info.plist 必须加例外（见 §3.4） |
| 5 | 本地网络需授权 | iOS / tvOS 14+ 首次访问局域网会弹"本地网络"授权；不填 `NSLocalNetworkUsageDescription` 会静默失败 | 弹窗文案、被拒后的引导都要做 |
| 6 | 分发成本 | 免费 Apple ID 侧载：**7 天过期**；付费开发者（99 美元/年）：1 年；TestFlight 构建 **90 天过期** | 长期自用建议直接上付费账号 |
| 7 | tvOS 侧载只有 Xcode | AltStore / SideStore / TrollStore 都是 iOS 的；Apple TV 只能 Xcode 配对安装或 TestFlight | 需要一台 Mac（或 CI 出包 + 一台 Mac 装机） |
| 8 | 硬件档次 | Apple TV HD（2015 / A8）已边缘化；4K 1st（A10X）/ 2nd（A12）/ 3rd（A15）是主力 | 目标机型按 4K 起；AVPlayer 硬解 HLS，比安卓 WebView 软解省一个数量级 |

## 2. 三条路线对比

| 方案 | 界面 | 服务端 | 工作量 | 依赖 | 风险 |
|---|---|---|---|---|---|
| **A. 局域网客户端**（推荐先做） | iOS 复用网页；tvOS 原生 SwiftUI | 继续跑在 PC / 安卓手机 | iOS 2–3 天；tvOS MVP 1–2 周 | 局域网里必须有一台开着的服务器 | 断网 / 服务器没开就用不了（真机实测里这是最常见的投诉点） |
| **B. 端内自带服务端** | 同上 | iOS 里塞 Node | iOS 需要 jitless V8 移植，数月级；tvOS 不可行 | — | 投入产出比极差 |
| **C. 全原生 + Swift 服务端** | tvOS 原生 | 端口到 Swift（自带 HTTP 服务） | 2–3 周（服务端）+ 1–2 周（界面） | 无 | 源站反爬、HLS 重写坑多 |

现有 Kotlin 服务端规模（移植时的工作量基准）：

```
WebServer.kt      444 行   ← 15 条路由 + 代理 + 播放列表
Sources.kt        452 行   ← 源站解析 / 缓存 / 测活
Calendar.kt       385 行
HomeFeed.kt       124 行
Net.kt            138 行   ← Referer/UA/超时/重试
SourceDetail.kt   102 行
M3u8Rewriter.kt    47 行   ← 分片/子列表/AES key 重写到 /api/proxy
```

服务端可移植部分约 **1700 行 Kotlin → 约 2000–2500 行 Swift**。

## 3. iOS 端设计（方案 A）

### 3.1 两种加载模式

- **远端模式（先做这个）**：`WKWebView.load(URLRequest(url: http://<服务器>:8080))`。页面、接口、代理全在远端，App 只负责壳、全屏、画中画、后台音频。
- **内嵌模式（可选）**：把 `index.html` + `hls.min.js` 打进 bundle，注册自定义 scheme（`WKURLSchemeHandler` 处理 `mfl://`），页面里的 `/api/*` 相对路径由 handler 转发到远端服务器。好处是首屏不依赖服务器页面、能加离线"最近看过"，代价是要改 `fetch` 的 base。

### 3.2 原生桥（前端已经在调，不需要改页面）

```js
// index.html 里现成的调用点
native('fullscreen', true)     // 全屏
native('landscape', true)      // 强制横屏
window.MFlixNative.battery()   // 允许屏幕常亮 / 播完恢复
window.MFlixNative.batteryOk() // 问一句这个能力有没有
```

iOS 侧只要注入同名对象即可：

```swift
final class Bridge: NSObject, WKScriptMessageHandler { /* … */ }

let ucc = WKUserContentController()
ucc.addUserScript(WKUserScript(source: """
window.MFlixNative = {
  fullscreen(on) { window.webkit.messageHandlers.mfl.postMessage({fn:'fullscreen', arg:!!on}); },
  landscape(on)  { window.webkit.messageHandlers.mfl.postMessage({fn:'landscape',  arg:!!on}); },
  battery()      { window.webkit.messageHandlers.mfl.postMessage({fn:'battery'}); },
  batteryOk()    { return true; }
};
""", injectionTime: .atDocumentStart, forMainFrameOnly: false))
```

### 3.3 播放增强（iOS 相比 Safari 的实际提升）

- 画中画：`WKWebViewConfiguration.allowsPictureInPictureMediaPlayback = true`；
- 后台音频 / 锁屏控制：`AVAudioSession(.playback)` + `MPNowPlayingInfoCenter`（网页播放时拿不到时间轴，可退化成只显示标题，或改用原生 `AVPlayer` 播当前集）；
- AirPlay：`<video>` 已经允许（`x-webkit-airplay`），或在原生层用 `AVRoutePickerView`；
- 屏幕常亮：`UIApplication.shared.isIdleTimerDisabled = true`（对应前端的 `battery()`）。

### 3.4 Info.plist 关键项

```xml
<key>NSAppTransportSecurity</key>
<dict>
  <key>NSAllowsArbitraryLoads</key><true/>   <!-- 自用侧载，局域网明文最省事 -->
</dict>
<key>NSLocalNetworkUsageDescription</key>
<string>MFlixTV 需要访问局域网内的片库服务器（手机 / 电脑上的 8080 端口）。</string>
<key>UIBackgroundModes</key>
<array><string>audio</string></array>
```

## 4. Apple TV（tvOS）端设计（方案 A）

### 4.1 界面结构（对齐现有 TV 版，10 英尺规范）

- `TabView` 顶部导航：首页 / 电影 / 剧集 / 综艺 / 搜索（与 `tv.html` 一致，入口少而精）；
- 首页：大图 billboard（焦点停止 240ms 才换，沿用现有逻辑）+ 若干横向 `LazyHGrid` 海报行；
- 详情页：背景大图 + 片名 + 简介 + 播放 / 播放第一集 / 外部播放器（tvOS 没有第三方播放器，这颗按钮换成"换线路"）+ 选集网格 + 相似影片；
- 播放页：`AVPlayer` + 自定义控制层，**对齐 0.29 的两个功能**：拖动进度条冒时间气泡、倍速面板（0.5–3.0，7 档）。`AVPlayer.rate` 变速必须配 `AVPlayerItem.audioTimePitchAlgorithm = .timeDomain`（变速不变调）。

### 4.2 遥控器（Siri Remote）

| 键 | 行为 |
|---|---|
| 触控板滑动 | 移动焦点（系统 focus engine 负责，无需自己实现） |
| 点按 | 确定 |
| 播放页 左右 | ±10 秒（按住连发） |
| 播放页 上 / 下 | 上一集 / 下一集 |
| 播放页 **长按确定** | 呼出按钮条（暂停 / 上集 / 下集 / 选集 / 倍速 / 换线路 / 退出）—— 与 Android 0.29 一致 |
| 返回（Menu） | 分层退：播放页 → 详情 → 首页 |

`pressesBegan/pressesEnded` + `UIPress.PressType`，长按用 `UILongPressGestureRecognizer(.allowedPressTypes = [.select])`。

### 4.3 数据层：沿用现有 /api 契约（tvOS 只当客户端）

| 路由 | 参数 | 用途 |
|---|---|---|
| `/api/status` | — | 版本、端口、局域网地址、设备信息（首屏探活） |
| `/api/home` | `force=1` | 首页各分类行 |
| `/api/search` | `wd` | 搜索 |
| `/api/detail` | `src&id` | 详情（简介、演员、相似） |
| `/api/lines` | `name&src&id` | 线路 / 剧集清单（含每集播放地址） |
| `/api/hero` | `name&type` | 大图区素材 |
| `/api/calendar` | `day/limit/week/kind/watch` | 追剧日历 |
| `/api/proxy` | `url` | m3u8 重写与分片转发（**必须走它**，直链会被源站 Referer 拦） |
| `/api/list.m3u` | `name&src&id&g&start&max&u` | 整条线路播放列表 |

> 关键：tvOS 的 `AVPlayer` 直接播 `/api/proxy?url=…` 这条地址即可，Referer 与分片重写在服务端做完了；**不能**把源站直链交给播放器（0.26 踩过：一直转圈）。

### 4.4 MVP 文件清单（约 12 个 Swift 文件、1800–2500 行）

```
MFlixTV-tvOS/
  App/MFlixTVApp.swift              入口 + TabView
  Net/APIClient.swift               URLSession + async/await
  Net/Models.swift                  Codable（对齐 §4.3 契约）
  Net/ImageLoader.swift             海报缓存（URLCache + 内存）
  UI/HomeView.swift                 大图 + 横向海报行
  UI/PosterCard.swift               焦点放大 / 白描边（对齐现有视觉）
  UI/DetailView.swift               详情 + 选集
  UI/SearchView.swift               搜索（tvOS 键盘）
  UI/PlayerView.swift               AVPlayer + 控制层
  UI/TimeBubble.swift               拖动时间气泡
  UI/SpeedPanel.swift               倍速面板（7 档）
  Store/Progress.swift              断点续播（本地 + 服务端）
```

## 5. 让 Apple TV 完全独立（方案 C，可选）

把 §2 里那 1700 行 Kotlin 移植成 Swift：

- HTTP 服务：`FlyingFox` / `Swifter`（轻量，够用）或 `SwiftNIO`（重）；
- 端口：绑定 8080（冲突则顺延，沿用现有逻辑）；
- m3u8 重写：分片、子播放列表、`EXT-X-KEY`、`EXT-X-MAP` 全部改写到本机 `/api/proxy`；
- 源站解析 + 缓存 + 测活：照 `Sources.kt` 的逻辑抄；
- 播放：同一个 `AVPlayer`，地址走 `http://127.0.0.1:8080/api/proxy?url=…`。

风险：源站反爬（Referer/UA/校验）、AES-128 分片、多码率子列表、缓存策略。这段最费时间，建议放到 M4。

## 6. 开发环境（现实问题）

本机是 Windows，**编译 iOS / tvOS 必须有 macOS + Xcode**。三条路：

1. **GitHub Actions 云端编**（推荐）：`macos-15` runner 自带 Xcode，公开仓库额度充足；产物 `.app` / `.ipa` 走 artifact 下载。缺点是签名要自己配（证书 + profile 存 secrets），tvOS 装到设备仍需一台 Mac 或 TestFlight。
2. **借 Mac**：朋友机器 / MacinCloud 按小时租。
3. 黑苹果 / macOS 虚拟机：不推荐，时间成本远超收益。

侧载工具与有效期：
- iOS：Sideloadly / AltStore（免费 ID 7 天重签一次），或付费账号 + 自签（1 年）。
- tvOS：只能 Xcode 直装，或付费账号 + TestFlight（90 天续一次）。

## 7. 里程碑

| 阶段 | 内容 | 估算 | 依赖 |
|---|---|---|---|
| M0 | 调研（本轮）+ Xcode 工程脚手架 + API 契约 Swift 化 | 0.5 天 | 无（Windows 可做） |
| M1 | iOS 壳：WKWebView + 桥 + 全屏/横屏/画中画 + 局域网授权 | 2–3 天 | 一台 Mac 或 CI |
| M2 | tvOS MVP：首页 / 详情 / 播放（AVPlayer） | 1–2 周 | Mac + Apple TV |
| M3 | 功能对齐 0.29：时间气泡、倍速面板、选集、跳过片头片尾、续播 | 3–5 天 | 同上 |
| M4 | 独立服务端（Swift 移植） | 2–3 周 | 同上 |

## 8. 风险与对策

| 风险 | 对策 |
|---|---|
| 免费 ID 7 天过期，装一次烦一次 | 上 99 美元开发者账号；或 TestFlight 90 天一续 |
| Apple TV 上服务器没开就白屏 | 首屏做"服务器地址"输入 + 记忆 + 局域网自动发现（Bonjour），连不上给明确引导 |
| ATS / 本地网络授权把请求全拦掉 | Info.plist 按 §3.4 配好；被拒时给"去设置里打开本地网络"的跳转 |
| 源站反爬导致代理失败 | 沿用现有 `Net.kt` 的 Referer/UA/重试策略；失败落到"换线路" |
| tvOS 没有外部播放器（安卓那套硬解兜底） | tvOS 的 AVPlayer 本身就是硬解，不需要兜底；反过来 Android 的"外部播放器"概念在 tvOS 上直接删掉 |
| 审核问题（默认源列表涉及版权内容） | 不走 App Store，只自用侧载 / TestFlight 内部测试 |

## 9. 现在就能在 Windows 上推进的部分

- Xcode 工程骨架（纯文本：`project.yml` + `Package.swift` + Sources 目录），推到仓库；
- 完整 Swift 代码（iOS 壳 + tvOS MVP），在 CI 里编译验证；
- GitHub Actions workflow：`xcodebuild -scheme … archive` → 导出 `.app`（tvOS）/`.ipa`（iOS）→ artifact；
- `APIClient` + Codable 模型（照 §4.3 契约）先用本地 mock 跑通（复用 `android-mock.cjs` 的 JSON）；
- 视觉稿：用现有 `tv.html` 的排版参数（导航字号、海报比例、焦点描边）作为 tvOS 端的设计基准。

---

### 参考

- Apple 文档 `WKWebView` 平台列表（无 tvOS）：<https://developer.apple.com/documentation/webkit/wkwebview>
- nodejs-mobile（仅 Android / iOS 二进制）：<https://github.com/nodejs-mobile/nodejs-mobile>
- Apple tvOS 开发首页（AVKit / UIKit / Metal / 焦点引擎）：<https://developer.apple.com/tvos/>
