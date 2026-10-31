package com.mflixtv.app

import android.content.Context
import fi.iki.elonen.NanoHTTPD
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.util.Collections
import java.util.concurrent.ConcurrentHashMap
import kotlin.concurrent.thread

/**
 * 手机上的服务端（NanoHTTPD，绑 0.0.0.0:8080）。
 *
 * 路由：
 *  - GET  /                     内置前端 assets/index.html（Netflix 风格首页）
 *  - GET  /hls.min.js           HLS 播放内核（离线内置，不依赖 CDN）
 *  - GET  /api/home             首页片单（10 分钟缓存；?force=1 强制重建）
 *  - GET  /api/search?wd=       多源搜索（片名 / 演员都命中）
 *  - GET  /api/detail?src=&id=  详情 + 全部播放组
 *  - GET  /api/series?name=     同名的其它季/部（资料页「同系列」）
 *  - GET  /api/lines?name=&src=&id=  跨源线路汇总（详情页线路、播放器切源）
 *  - GET  /api/hero?name=&type=      首页大图轮播的 5–8 部（有观看记录就推同类，否则最近更新）
 *  - GET  /api/calendar?week=&day=&kind=&watch=&limit=  追剧日历周表（10 分钟快照）
 *  - GET  /api/proxy?url=       转发（图片 / m3u8 / 分片，Range 透传、m3u8 重写）
 *  - GET  /api/sources          当前源列表
 *  - POST /api/sources/save     保存源列表（body: JSON 数组）
 *  - POST /api/sources/reset    恢复出厂源
 *  - GET  /api/status           版本与状态
 */
class WebServer(context: Context, port: Int = 8080) : NanoHTTPD(port) {
    private val ctx = context
    private val portNum = port

    companion object {
        const val VERSION = "android-1.1"
    }

    /** 跨源线路缓存：name|src|id -> (json, 时间)。同一部片来回看不用重复拉。 */
    private val lineCache = ConcurrentHashMap<String, Pair<String, Long>>()

    /** 首页 hero 推荐缓存：like|type -> (json, 时间)。 */
    private val heroCache = ConcurrentHashMap<String, Pair<String, Long>>()

    override fun serve(session: IHTTPSession): Response {
        val uri = session.uri ?: "/"
        val p = session.parameters
        // 每条请求都续一下 CPU 唤醒锁：锁屏后别的设备来拉分片也能被立刻应答
        KeepAlive.touch(ctx)
        return try {
            when {
                uri == "/api/status" -> json(status())
                // 息屏常驻开关：?on=1 / ?on=0，不带参数就只读当前状态
                uri == "/api/wakelock" -> {
                    val on = p["on"]?.firstOrNull()
                    if (on != null) KeepAlive.setAlwaysOn(ctx, on == "1" || on == "true")
                    json(
                        "{\"wakeAlways\":" + KeepAlive.alwaysOn(ctx) +
                            ",\"wake\":" + KeepAlive.isHeld() + "}"
                    )
                }
                uri == "/api/home" -> home(session, p["force"]?.firstOrNull() == "1")
                // 追剧日历（周表）：week=current|prev|next|YYYY-MM-DD，day=YYYY-MM-DD 定选哪天，
                // kind=all|series|...，watch=片名清单（只看我追的）
                uri == "/api/calendar" -> json(
                    CalendarWeek.json(
                        p["week"]?.firstOrNull(),
                        p["kind"]?.firstOrNull(),
                        p["watch"]?.firstOrNull(),
                        (p["limit"]?.firstOrNull() ?: "6").toIntOrNull() ?: 6,
                        p["day"]?.firstOrNull()
                    )
                )
                uri == "/api/search" -> json(Sources.search(p["wd"]?.firstOrNull() ?: ""))
                uri == "/api/series" -> json(series(p["name"]?.firstOrNull() ?: ""))
                uri == "/api/lines" -> json(
                    lines(
                        p["name"]?.firstOrNull() ?: "",
                        p["src"]?.firstOrNull() ?: "",
                        p["id"]?.firstOrNull() ?: ""
                    )
                )
                uri == "/api/hero" -> {
                    val name = p["name"]?.firstOrNull() ?: ""
                    val type = p["type"]?.firstOrNull() ?: ""
                    val ck = name.trim().lowercase() + "|" + type.trim().lowercase()
                    val hit = heroCache[ck]
                    if (hit != null && System.currentTimeMillis() - hit.second < 10 * 60 * 1000L) {
                        json(hit.first)
                    } else {
                        val body = Sources.hero(name, type)
                        heroCache[ck] = body to System.currentTimeMillis()
                        json(body)
                    }
                }
                uri == "/api/detail" -> {
                    // 前端传的是源 key（如 zuid），这里必须换成接口地址；以前直接当域名用，
                    // 结果是 Unable to resolve host "zuid"，所有片子都拿不到分集。
                    val key = p["src"]?.firstOrNull().orEmpty()
                    val id = p["id"]?.firstOrNull().orEmpty()
                    val base = Sources.byKey(key)?.base ?: key
                    json(SourceDetail.detail(base, id, key))
                }
                uri == "/api/sources" -> json(
                    "{\"list\":" + Sources.toJson(Sources.ALL) +
                        ",\"builtin\":" + Sources.toJson(Sources.BUILTIN) + "}"
                )
                uri == "/api/sources/save" -> saveSources(session, p["json"]?.firstOrNull())
                uri == "/api/sources/reset" -> json("{\"ok\":true,\"count\":" + Sources.reset() + "}")
                // 停用 / 启用单个源（片源体检列表里点一下）
                // on=1 表示「启用这个源」，on=0 表示「停用」；也接受 off=1 的反向写法
                uri == "/api/sources/toggle" -> {
                    val key = p["key"]?.firstOrNull().orEmpty()
                    val useOff = p["on"]?.firstOrNull() == null && p["off"]?.firstOrNull() != null
                    val raw = (p["on"]?.firstOrNull() ?: p["off"]?.firstOrNull() ?: "1")
                        .trim().lowercase()
                    val truth = raw == "1" || raw == "true" || raw == "on" || raw == "yes"
                    val enable = if (useOff) !truth else truth
                    json(
                        "{\"ok\":" + Sources.setOff(key, !enable) +
                            ",\"on\":" + enable +
                            ",\"off\":" + Sources.offKeys().size + "}"
                    )
                }
                // 片源配置导出 / 导入：换设备时把这段 JSON 粘过去就能还原（含停用清单）
                uri == "/api/sources/export" -> json(Sources.exportJson())
                uri == "/api/sources/import" -> {
                    val n = Sources.importJson(p["json"]?.firstOrNull().orEmpty())
                    json(if (n >= 0) "{\"ok\":true,\"count\":" + n + "}" else "{\"ok\":false,\"error\":\"格式不对\"}")
                }
                // 手机遥控：手机 push，电视 poll（只在局域网内走，不外发）
                uri == "/api/remote/push" -> json(
                    "{\"ok\":true,\"id\":" + Remote.push(
                        p["cmd"]?.firstOrNull().orEmpty(),
                        p["arg"]?.firstOrNull().orEmpty(),
                        p["to"]?.firstOrNull().orEmpty(),
                        p["from"]?.firstOrNull().orEmpty()
                    ) + "}"
                )
                uri == "/api/remote/poll" -> json(
                    Remote.poll(
                        (p["since"]?.firstOrNull() ?: "0").toLongOrNull() ?: 0L,
                        p["role"]?.firstOrNull() ?: "tv",
                        p["who"]?.firstOrNull().orEmpty()
                    )
                )
                uri == "/api/diag" -> json(Sources.probeJson(useCache = p["force"]?.firstOrNull() != "1"))
                // 「扫一扫当遥控器」（会话级）：每个打开页面的标签页各领一个 token，
                // 二维码里的 /rc?t=TOKEN 只控制发起的那一个页面，不影响别处。
                uri == "/api/rs/create" -> remoteCreate(p)
                uri == "/api/rs/host" -> remoteHost(p)
                uri == "/api/rs/ctl" -> remoteCtl(p)
                uri == "/api/rs/cmd" -> remoteCmd(p)
                uri == "/api/rs/state" -> remoteState(p)
                uri == "/api/rs/info" -> remoteInfo(p)
                // 片源测速 / 维护：force=1 当场重测（设置页点「重新测速」），否则给缓存并在后台补测
                uri == "/api/sources/health" -> json(healthJson(p["force"]?.firstOrNull() == "1"))
                // 没源了：去远端拉最新源清单，合并后重测
                uri == "/api/sources/autofix" -> json(autofixJson())
                uri == "/api/netcfg" -> netcfg(p["proxy"]?.firstOrNull())
                uri == "/api/proxy" -> proxy(session)
                // 外部播放器用的整条线路播放列表（连播不断，切集不用回 App）
                uri == "/api/list.m3u" -> playlist(p)
                uri == "/" || uri == "/index.html" -> asset("index.html", "text/html; charset=utf-8")
                // 电视版（10 英尺界面，遥控器导航）：盒子上 8080/tv 也能直接用浏览器开
                uri == "/tv" || uri == "/tv.html" -> asset("tv.html", "text/html; charset=utf-8")
                // 扫码后手机打开的就是这一页（和 index.html / tv.html 共用同一套 /api/rs 接口）
                uri == "/rc" || uri == "/rc.html" -> asset("rc.html", "text/html; charset=utf-8")
                uri == "/hls.min.js" -> asset("hls.min.js", "application/javascript; charset=utf-8")
                // 自写的二维码生成器 + 扫码遥控的被控端（index.html / tv.html 共用）
                uri == "/qr.js" -> asset("qr.js", "application/javascript; charset=utf-8")
                uri == "/rc-host.js" -> asset("rc-host.js", "application/javascript; charset=utf-8")
                uri == "/favicon.ico" -> newFixedLengthResponse(Response.Status.NO_CONTENT, MIME_PLAINTEXT, "")
                else -> newFixedLengthResponse(Response.Status.NOT_FOUND, MIME_PLAINTEXT, "not found")
            }
        } catch (e: Exception) {
            json("{\"error\":\"" + esc(e.message ?: "server error") + "\"}")
        }
    }

    /* ---------------- 「扫一扫当遥控器」（会话级，见 RemoteSession.kt） ---------------- */

    private fun lanUrl(path: String): String {
        val ip = LanIp.ip().ifBlank { "127.0.0.1" }
        return "http://$ip:$portNum$path"
    }

    private fun remoteCreate(p: Map<String, List<String>>): Response {
        val o = RemoteSession.create(p["name"]?.firstOrNull().orEmpty())
        val token = o.optString("token")
        o.put("url", lanUrl("/rc?t=$token"))
        return json(o.toString())
    }

    private fun remoteHost(p: Map<String, List<String>>): Response {
        val t = (p["t"]?.firstOrNull() ?: "").uppercase()
        val since = (p["since"]?.firstOrNull() ?: "0").toLongOrNull() ?: 0L
        val waitMs = (p["wait"]?.firstOrNull() ?: "0").toLongOrNull()?.coerceIn(0L, 700L) ?: 0L
        var body = RemoteSession.hostPoll(t, since) ?: return json("{\"error\":\"会话已失效\"}")
        // 长轮询（wait=1）：没指令就把请求挂一会儿，有指令立刻返回，
        // 手机按一下到被控页真的动，从「最坏等一个轮询间隔」变成「几十毫秒」。
        if (waitMs > 0 && RemoteSession.seqOf(t) <= since) {
            val deadline = System.currentTimeMillis() + waitMs
            while (System.currentTimeMillis() < deadline) {
                try {
                    Thread.sleep(20)
                } catch (_: Throwable) {
                }
                val s = RemoteSession.seqOf(t)
                if (s < 0 || s > since) break
            }
            body = RemoteSession.hostPoll(t, since) ?: return json("{\"error\":\"会话已失效\"}")
        }
        return json(body)
    }

    private fun remoteCtl(p: Map<String, List<String>>): Response {
        val t = (p["t"]?.firstOrNull() ?: "").uppercase()
        val body = RemoteSession.ctlPoll(t, p["who"]?.firstOrNull().orEmpty())
            ?: return json("{\"error\":\"会话已失效\"}")
        return json(body)
    }

    private fun remoteCmd(p: Map<String, List<String>>): Response {
        val t = (p["t"]?.firstOrNull() ?: "").uppercase()
        val cmd = (p["cmd"]?.firstOrNull() ?: "").trim()
        if (cmd.isEmpty()) return json("{\"error\":\"缺少 cmd\"}")
        val id = RemoteSession.push(t, cmd, p["arg"]?.firstOrNull().orEmpty())
            ?: return json("{\"error\":\"会话已失效\"}")
        return json("{\"ok\":true,\"id\":" + id + "}")
    }

    private fun remoteState(p: Map<String, List<String>>): Response {
        val t = (p["t"]?.firstOrNull() ?: "").uppercase()
        val o = JSONObject()
        p["title"]?.firstOrNull()?.let { o.put("title", it) }
        p["sub"]?.firstOrNull()?.let { o.put("sub", it) }
        p["playing"]?.firstOrNull()?.let { o.put("playing", it == "1") }
        p["pos"]?.firstOrNull()?.let { o.put("pos", it.toIntOrNull() ?: 0) }
        p["dur"]?.firstOrNull()?.let { o.put("dur", it.toIntOrNull() ?: 0) }
        p["page"]?.firstOrNull()?.let { o.put("page", it) }
        p["eps"]?.firstOrNull()?.let { o.put("eps", it) }
        p["lines"]?.firstOrNull()?.let { o.put("lines", it) }
        // 音量 / 倍速 / 静音：遥控器上要能看见自己按到了多少
        p["vol"]?.firstOrNull()?.let { o.put("vol", it.toIntOrNull() ?: 100) }
        p["rate"]?.firstOrNull()?.let { o.put("rate", it.toIntOrNull() ?: 100) }
        p["muted"]?.firstOrNull()?.let { o.put("muted", it == "1") }
        if (!RemoteSession.setState(t, o)) return json("{\"error\":\"会话已失效\"}")
        return json("{\"ok\":true}")
    }

    private fun remoteInfo(p: Map<String, List<String>>): Response {
        val t = (p["t"]?.firstOrNull() ?: "").uppercase()
        val body = RemoteSession.info(t) ?: return json("{\"error\":\"会话已失效\"}")
        return json(body)
    }

    /**
     * 片源体检：force=true 当场重测（12 个源并发，几秒），否则先给上次结果、
     * 同时在后台补测一份，页面不用等。
     */
    private fun healthJson(force: Boolean): String {
        try {
            if (force) SourceHealth.maintain(true) else SourceHealth.maintainAsync()
        } catch (_: Throwable) {
        }
        return SourceHealth.snapshot().toString()
    }

    /** 没源了：去远端拉最新源清单，合并去重，再重测一次。 */
    private fun autofixJson(): String {
        var added = 0
        try {
            added = SourceHealth.autoFix()
            if (added > 0) SourceHealth.maintain(true)
        } catch (_: Throwable) {
        }
        return SourceHealth.snapshot().put("added", added).toString()
    }

    /**
     * 首页：有缓存先给缓存；客户端点「重新载入」时强制重建。
     * 重建很慢（多源并发抓），所以这里从不阻塞太久的重复请求。
     */
    private fun home(session: IHTTPSession, force: Boolean): Response {        if (!force) {
            HomeFeed.cached(ctx)?.let { return json(it.toString()) }
            HomeFeed.stale(ctx)?.let {
                HomeFeed.refreshAsync(ctx)
                return json(it)
            }
        }
        return json(HomeFeed.home(ctx, force))
    }

    /** 同名的其它季：把「第 3 季」「Season 2」这类后缀去掉，再跨源搜基名。 */
    private fun series(name: String): String {
        val base = baseName(name)
        val out = JSONObject()
        val arr = JSONArray()
        if (base.length >= 2) {
            try {
                val found = JSONObject(Sources.search(base)).optJSONArray("list") ?: JSONArray()
                val seen = HashSet<String>()
                for (i in 0 until found.length()) {
                    val o = found.optJSONObject(i) ?: continue
                    val n = o.optString("name").trim()
                    if (n.length < base.length) continue
                    if (!n.startsWith(base) && !n.contains(base)) continue
                    val key = n + "|" + o.optString("year")
                    if (!seen.add(key)) continue
                    arr.put(o)
                }
            } catch (_: Exception) {
            }
        }
        out.put("base", base)
        out.put("list", arr)
        return out.toString()
    }

    /**
     * 跨源线路汇总。
     *
     * 采集站的每条线路只在自己的源里有效，所以一部片只有在同一个源里才有几条线路。
     * 想要「线路够多」，只能把其它源里的同名片也拉出来，把它们的线路并到一张表上：
     *   1. 已知的 (src, id) 排第一，保证用户当前在看的源一定在里面；
     *   2. 再用片名跨源搜一遍，同名条目按源去重，最多补 4 个源；
     *   3. 对这些源并发拉 detail，把 groups 全并起来，每条标上 src/srcName。
     * 结果缓存 10 分钟。
     */
    private fun lines(name: String, src: String, id: String): String {
        val q = baseName(name)
        val cacheKey = q.lowercase() + "|" + src + "|" + id
        lineCache[cacheKey]?.let {
            if (System.currentTimeMillis() - it.second < 10 * 60 * 1000L) return it.first
        }

        val out = JSONObject()
        val groups = JSONArray()
        val cands = ArrayList<Triple<String, String, String>>() // srcKey / vodId / 源里那片名
        val usedSrc = HashSet<String>()
        if (src.isNotEmpty() && id.isNotEmpty()) {
            usedSrc.add(src)
            cands.add(Triple(src, id, name.trim()))
        }
        if (q.length >= 2) {
            try {
                val found = JSONObject(Sources.search(q)).optJSONArray("list") ?: JSONArray()
                val usedId = HashSet<String>()
                for (i in 0 until found.length()) {
                    if (cands.size >= 5) break
                    val o = found.optJSONObject(i) ?: continue
                    val n = o.optString("name").trim()
                    if (n.isEmpty()) continue
                    // 同名（忽略大小写/空格），或者一方包含另一方（如带副标题）
                    val same = n.equals(name.trim(), true) || n.equals(q, true) ||
                        n.contains(q, true) || q.contains(n, true)
                    if (!same) continue
                    val ks = o.optString("src")
                    val ki = o.optString("vodId")
                    if (ks.isEmpty() || ki.isEmpty()) continue
                    if (!usedId.add(ks + "|" + ki)) continue
                    if (usedSrc.contains(ks)) continue // 同一个源只取一条，避免同名重复刷
                    usedSrc.add(ks)
                    cands.add(Triple(ks, ki, n))
                }
            } catch (_: Exception) {
            }
        }

        val parts = Collections.synchronizedList(ArrayList<JSONObject>())
        val workers = cands.map { c ->
            thread {
                val s = Sources.byKey(c.first) ?: return@thread
                try {
                    val d = JSONObject(SourceDetail.detail(s.base, c.second, s.key))
                    if (d.has("error")) return@thread
                    val gs = d.optJSONArray("groups") ?: return@thread
                    for (j in 0 until gs.length()) {
                        val g = JSONObject(gs.getJSONObject(j).toString())
                        g.put("src", s.key)
                        g.put("srcName", s.name)
                        g.put("vodId", c.second)
                        parts.add(g)
                    }
                } catch (_: Exception) {
                }
            }
        }
        workers.forEach { it.join(14000) }

        // m3u8 直链线路排前面，分享页排后面；同源同首集只留一个
        val seen = HashSet<String>()
        val ordered = parts.sortedBy { rankOfGroup(it) }
        for (g in ordered) {
            val eps = g.optJSONArray("episodes") ?: continue
            if (eps.length() == 0) continue
            val first = eps.optJSONObject(0)?.optString("url").orEmpty()
            val sig = g.optString("src") + "|" + first
            if (!seen.add(sig)) continue
            groups.put(g)
        }

        out.put("groups", groups)
        out.put("count", groups.length())
        val text = out.toString()
        lineCache[cacheKey] = text to System.currentTimeMillis()
        return text
    }

    private fun rankOfGroup(g: JSONObject): Int {
        val first = g.optJSONArray("episodes")?.optJSONObject(0)?.optString("url").orEmpty().lowercase()
        return when {
            first.contains("/share/") -> 30
            first.contains(".m3u8") -> 0
            first.contains(".mp4") -> 10
            else -> 20
        }
    }

    /**
     * /api/list.m3u —— 把「一条线路的全部集」做成一个 m3u 播放列表。
     *
     * 为什么要有它：外部播放器一次只能接一个地址，一集一个 intent 的话，每看完一集都要
     * 退回 MFlixTV 再点下一集，跳来跳去看得人心烦。实测 MX Player 认 #EXTM3U 播放列表
     * （会把它当播放队列，自己续下一集），所以这里把整条线路一次性交出去，连播由播放器完成。
     *
     * 条目一律走本机 /api/proxy：Referer 与 m3u8 分片重写在服务端做，外部播放器不用管防盗链。
     * start=N 表示从第 N 集开始（用户点第 8 集，列表就从第 8 集往后排）。
     */
    private fun playlist(p: Map<String, List<String>>): Response {
        val key = p["src"]?.firstOrNull().orEmpty()
        val id = p["id"]?.firstOrNull().orEmpty()
        val gi = (p["g"]?.firstOrNull() ?: "0").toIntOrNull() ?: 0
        val start = ((p["start"]?.firstOrNull() ?: "0").toIntOrNull() ?: 0).coerceAtLeast(0)
        // 列表长度上限：外部播放器打开时会先把条目探一遍，整条 80 集会明显拖慢起播，
        // 所以默认只给「这一集 + 往后 9 集」，够连看好几小时，再来点下一批。
        val max = ((p["max"]?.firstOrNull() ?: "10").toIntOrNull() ?: 10).coerceIn(1, 30)
        val sb = StringBuilder("#EXTM3U\n")
        var n = 0
        try {
            val base = Sources.byKey(key)?.base ?: key
            val d = JSONObject(SourceDetail.detail(base, id, key))
            val gs = d.optJSONArray("groups")
            if (gs != null && gs.length() > 0) {
                val g = gs.optJSONObject(gi.coerceIn(0, gs.length() - 1))
                val eps = g?.optJSONArray("episodes")
                if (eps != null) {
                    for (i in start until eps.length()) {
                        if (n >= max) break
                        val e = eps.optJSONObject(i) ?: continue
                        val u = e.optString("url")
                        if (u.isEmpty()) continue
                        val raw = e.optString("label").ifEmpty { "第" + (i + 1) + "集" }
                        // EXTINF 的标题里不能带逗号/换行，否则播放器会把整张列表解析坏
                        val label = raw.replace(',', ' ').replace('\n', ' ').replace('\r', ' ').trim()
                        sb.append("#EXTINF:-1,").append(label).append('\n')
                        sb.append("http://127.0.0.1:").append(portNum).append("/api/proxy?url=")
                            .append(URLEncoder.encode(u, "UTF-8")).append('\n')
                        n++
                    }
                }
            }
        } catch (_: Exception) {
        }
        if (n == 0) {
            // 兜不住线路（源临时抽风 / 分享页线路）时，至少把前端手里那一集放进列表：
            // 外部播放器拿到一条也能正常播，不会只看到「转圈」。
            val single = p["u"]?.firstOrNull().orEmpty()
            if (single.isNotEmpty()) {
                sb.append("#EXTINF:-1,继续播放\n")
                sb.append("http://127.0.0.1:").append(portNum).append("/api/proxy?url=")
                    .append(URLEncoder.encode(single, "UTF-8")).append('\n')
            } else {
                sb.append("# 这条线路没有可用分集\n")
            }
        }
        return newFixedLengthResponse(Response.Status.OK, "audio/x-mpegurl; charset=utf-8", sb.toString())
    }

    private fun baseName(name: String): String {
        var n = name.trim()
        n = n.replace(Regex("[（(]\\s*[^（()）]{0,8}(版|配音|国语|粤语|普通话|字幕)\\s*[)）]"), " ")
        n = n.replace(Regex("(第[一二三四五六七八九十0-9]{1,3}[季部期篇])"), " ")
        n = n.replace(Regex("(?i)\\bseason\\s*\\d{1,2}\\b"), " ")
        n = n.replace(Regex("(?i)\\bs\\d{1,2}\\b"), " ")
        n = n.replace(Regex("[\\s·\\-_:：]+$"), " ")
        return n.replace(Regex("\\s{2,}"), " ").trim()
    }

    /**
     * 状态 + 访问地址。
     * 页面自己跑在 127.0.0.1 上，读 location.host 只能拿到回环地址，
     * 所以局域网地址必须由这里查网卡后告诉它。
     */
    private fun status(): String {
        val ip = LanIp.ip()
        return JSONObject().apply {
            put("passwordRequired", false)
            put("verified", true)
            put("version", VERSION)
            put("sources", Sources.ALL.size)
            put("ip", ip)
            put("lan", if (ip.isEmpty()) "" else "http://$ip:$portNum")
            put("local", "http://127.0.0.1:$portNum")
            put("wifi", LanIp.wifiUp())
            // 端口不一定是 8080（被占时会自动换），页面与设置页都读这个值
            put("port", portNum)
            // 息屏常驻：wake=是否持着 CPU 唤醒锁，wakeAlways=用户选的策略
            put("wake", KeepAlive.isHeld())
            put("wakeAlways", KeepAlive.alwaysOn(ctx))
            // 局域网里最近 15 秒有过来的设备数（手机遥控、别的设备开着网页版都会算一台）
            put("devices", Remote.active())
            // 机型指纹 + 最近一次崩溃：别人反馈闪退时，让用户截设置页就能拿到真因
            put("device", CrashLog.deviceLine(ctx))
            put("lastCrash", CrashLog.lastSummary(ctx))
        }.toString()
    }

    /** 代理设置：GET 看当前值，带 proxy 参数就是设置（空字符串=清除）。 */
    private fun netcfg(proxy: String?): Response {
        if (proxy == null) {
            return json("{\"proxy\":\"" + esc(Net.proxyString()) + "\"}")
        }
        val ok = Net.setProxy(ctx, proxy)
        return json(
            "{\"ok\":" + ok + ",\"proxy\":\"" + esc(Net.proxyString()) + "\"" +
                (if (ok) "" else ",\"error\":\"格式要是 主机:端口\"") + "}"
        )
    }

    private fun saveSources(session: IHTTPSession, queryJson: String?): Response {
        val body = queryJson ?: try {
            val files = HashMap<String, String>()
            session.parseBody(files)
            files["postData"].orEmpty()
        } catch (_: Exception) {
            ""
        }
        if (body.isBlank()) return json("{\"ok\":false,\"error\":\"empty\"}")
        val n = Sources.save(body)
        return if (n < 0) json("{\"ok\":false,\"error\":\"bad json\"}")
        else json("{\"ok\":true,\"count\":$n}")
    }

    private fun asset(name: String, mime: String): Response = try {
        val bytes = ctx.assets.open(name).use { it.readBytes() }
        newFixedLengthResponse(Response.Status.OK, mime, ByteArrayInputStream(bytes), bytes.size.toLong())
    } catch (e: Exception) {
        newFixedLengthResponse(Response.Status.NOT_FOUND, MIME_PLAINTEXT, "asset missing: $name")
    }

    private fun json(body: String): Response =
        newFixedLengthResponse(Response.Status.OK, "application/json; charset=utf-8", body)

    private fun esc(s: String) = s.replace("\\", "\\\\").replace("\"", "'").replace("\n", " ").replace("\r", " ")

    /** 分片 / MP4 的返回类型：上游给了 video/audio 就照用，否则按扩展名推断（iOS 认这个） */
    private fun mediaType(target: String, upstream: String): String {
        val t = upstream.lowercase()
        if (t.startsWith("video/") || t.startsWith("audio/")) return upstream
        val path = target.substringBefore('?').substringBefore('#').lowercase()
        return when {
            path.endsWith(".ts") || path.endsWith(".m2ts") -> "video/mp2t"
            path.endsWith(".m4s") || path.endsWith(".mp4") || path.endsWith(".m4v") || path.endsWith(".cmfv") -> "video/mp4"
            path.endsWith(".aac") -> "audio/aac"
            path.endsWith(".mp3") -> "audio/mpeg"
            path.endsWith(".jpg") || path.endsWith(".jpeg") -> "image/jpeg"
            path.endsWith(".png") -> "image/png"
            path.endsWith(".webp") -> "image/webp"
            else -> if (t.isBlank()) "application/octet-stream" else upstream
        }
    }

    /**
     * 代理：图片、m3u8、分片全走这里。
     *  - Range / Content-Range 透传（拖动进度条、分片并发下载要靠它）
     *  - 内容是 m3u8 时把里面的 URI 重写成代理地址，跨域/防盗链都绕开
     */
    private fun proxy(session: IHTTPSession): Response {
        val raw = session.parameters["url"]?.firstOrNull()
            ?: return json("{\"error\":\"missing url\"}")
        val target = if (raw.startsWith("http")) raw else "https://" + raw
        val conn = try {
            // 统一走 Net：证书宽容（采集站常缺中间证书，Java 校验比浏览器严）+ 可选代理
            Net.open(target, 12000).also { it.readTimeout = 25000 }
        } catch (e: Exception) {
            return json("{\"error\":\"" + esc(e.message ?: "bad url") + "\"}")
        }
        return try {
            conn.instanceFollowRedirects = true
            session.headers["range"]?.let { conn.setRequestProperty("Range", it) }

            val code = conn.responseCode
            val contentType = conn.contentType ?: "application/octet-stream"
            val isM3u8 = target.contains(".m3u8", true) ||
                contentType.contains("mpegurl", true) ||
                contentType.contains("x-mpegURL", true)

            if (isM3u8) {
                val text = (if (code in 200..299) conn.inputStream else conn.errorStream)
                    ?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: ""
                if (!text.contains("#EXTM3U")) {
                    return json("{\"error\":\"not a manifest\",\"code\":" + code + "}")
                }
                val bytes = M3u8Rewriter.rewrite(text, target).toByteArray(Charsets.UTF_8)
                return newFixedLengthResponse(
                    Response.Status.OK, "application/vnd.apple.mpegurl", ByteArrayInputStream(bytes), bytes.size.toLong()
                ).apply {
                    addHeader("Access-Control-Allow-Origin", "*")
                    addHeader("Cache-Control", "no-cache")
                }
            }

            // 分片 / MP4 的类型按扩展名兜底：采集站常把 .ts 标成 octet-stream 甚至 text/plain，
            // hls.js 不在乎，但 iOS 的 AVFoundation 认类型——不对就整条流报「地址播不了」。
            val segType = mediaType(target, contentType)

            val stream = if (code in 200..299) conn.inputStream else conn.errorStream
                ?: return json("{\"error\":\"no body\",\"code\":" + code + "}")

            // 上游给 206 就必须原样回 206，否则拖动进度条会重新下载整个文件；
            // 有 Content-Length 时用定长响应，没有才退回 chunked。
            val status = when {
                code == 206 -> Response.Status.PARTIAL_CONTENT
                code in 200..299 -> Response.Status.OK
                else -> Response.Status.INTERNAL_ERROR
            }
            val declared = conn.getHeaderField("Content-Length")?.toLongOrNull()
                ?: conn.contentLengthLong.takeIf { it > 0 }
            val resp = if (declared != null && declared > 0) {
                newFixedLengthResponse(status, segType, stream, declared)
            } else {
                newChunkedResponse(status, segType, stream)
            }
            conn.getHeaderField("Content-Range")?.let { resp.addHeader("Content-Range", it) }
            resp.addHeader("Accept-Ranges", "bytes")
            resp.addHeader("Access-Control-Allow-Origin", "*")
            resp
        } catch (e: Exception) {
            json("{\"error\":\"" + esc(e.message ?: "proxy failed") + "\"}")
        }
    }
}
