package com.mflixtv.app

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.util.Collections
import kotlin.concurrent.thread

/**
 * 片源体检 / 测速 / 自愈。
 *
 * 三件事：
 *  1) 测速：并发打每个源的列表接口，记下耗时、返回条数、失败次数；
 *     首页和搜索按这个结果排序取源，快的先上，避免首屏被慢源拖住。
 *  2) 维护：缓存 30 分钟过期，后台线程重测；连续失败 3 次的源不进源池，
 *     但留在列表里（源站偶尔抽风，别一失败就删）。
 *  3) 自愈：一个可用源都没有的时候，去远端拉最新源清单（多个镜像轮着试），
 *     合并去重、写回本地，再重测一遍——这就是「没源了自己把源找回来」。
 */
object SourceHealth {

    data class H(
        val base: String,
        val name: String,
        val ok: Boolean,
        val ms: Int,
        val items: Int,
        val fails: Int,
        val ts: Long,
        val err: String
    )

    private const val K_JSON = "health_json"
    private const val K_TS = "health_ts"
    private const val K_FIX = "health_autofix_ts"

    /** 体检结果多久算过期（超了就后台重测一次） */
    private const val TTL = 30 * 60 * 1000L
    /** 两次自动维护之间至少隔这么久，免得反复打源站 */
    private const val MAINTAIN_GAP = 3 * 60 * 60 * 1000L
    /** 连续失败这么多次，就先不进源池 */
    private const val DEAD_FAILS = 3

    /**
     * 远端源清单。挨个试，第一个成功的就用。
     * jsDelivr 是国内能直连的 CDN，放第一位；GitHub 直链常被墙，留作后备。
     */
    private val REMOTE_LISTS = listOf(
        "https://cdn.jsdelivr.net/gh/MDorin1/MFlixTV@main/sources.json",
        "https://fastly.jsdelivr.net/gh/MDorin1/MFlixTV@main/sources.json",
        "https://raw.githubusercontent.com/MDorin1/MFlixTV/main/sources.json",
        "https://ghproxy.net/https://raw.githubusercontent.com/MDorin1/MFlixTV/main/sources.json"
    )

    @Volatile private var sp: android.content.SharedPreferences? = null
    @Volatile private var map: MutableMap<String, H> = LinkedHashMap()
    @Volatile private var lastProbeAt: Long = 0L
    @Volatile private var running = false

    fun init(ctx: Context) {
        if (sp != null) return
        val p = ctx.applicationContext.getSharedPreferences("mflixtv", Context.MODE_PRIVATE)
        sp = p
        lastProbeAt = p.getLong(K_TS, 0L)
        load(p.getString(K_JSON, null))
        /* 启动后在后台补一次体检：不阻塞网页服务，源站慢也不影响首页先出缓存 */
        thread(name = "src-health-warm") {
            try { maintain() } catch (_: Exception) {}
        }
    }

    private fun load(text: String?) {
        if (text.isNullOrBlank()) return
        try {
            val arr = JSONArray(text)
            val m = LinkedHashMap<String, H>()
            for (i in 0 until arr.length()) {
                val o = arr.optJSONObject(i) ?: continue
                val base = o.optString("base")
                if (base.isBlank()) continue
                m[base] = H(
                    base, o.optString("name"), o.optBoolean("ok"), o.optInt("ms"),
                    o.optInt("items"), o.optInt("fails"), o.optLong("ts"), o.optString("err")
                )
            }
            map = m
        } catch (_: Exception) {
        }
    }

    private fun persist() {
        val p = sp ?: return
        val arr = JSONArray()
        map.values.forEach {
            arr.put(
                JSONObject().put("base", it.base).put("name", it.name).put("ok", it.ok)
                    .put("ms", it.ms).put("items", it.items).put("fails", it.fails)
                    .put("ts", it.ts).put("err", it.err)
            )
        }
        p.edit().putString(K_JSON, arr.toString()).putLong(K_TS, lastProbeAt).apply()
    }

    /** 一次体检：并发打所有源，合并上次的失败次数。 */
    fun probe(timeoutMs: Int = 5000): List<H> {
        val list = Sources.ALL
        val prev = map
        val out = Collections.synchronizedList(ArrayList<H>())
        val workers = list.map { s ->
            thread(name = "src-probe") {
                val t0 = System.currentTimeMillis()
                var ok = false
                var items = 0
                var err = ""
                try {
                    val txt = Sources.get(s.base + "?ac=videolist&pg=1", timeoutMs)
                    val o = JSONObject(txt)
                    val arr = o.optJSONArray("list")
                    items = arr?.length() ?: 0
                    ok = arr != null
                    if (!ok) err = "返回不是列表（可能被拦截或换了接口）"
                } catch (e: Exception) {
                    err = Net.shortErr(e)
                }
                val ms = (System.currentTimeMillis() - t0).toInt()
                val oldFails = prev[s.base]?.fails ?: 0
                out.add(
                    H(
                        s.base, s.name, ok, if (ok) ms else 0, items,
                        if (ok) 0 else oldFails + 1,
                        System.currentTimeMillis(), err
                    )
                )
            }
        }
        workers.forEach { it.join((timeoutMs + 4000).toLong()) }
        val done = out.toList()
        val m = LinkedHashMap<String, H>()
        /* 没测到的（线程被超时截断）保留上一次结论，不要直接判死 */
        list.forEach { s -> (done.firstOrNull { it.base == s.base } ?: prev[s.base])?.let { m[s.base] = it } }
        map = m
        lastProbeAt = System.currentTimeMillis()
        persist()
        Sources.invalidateProbe()
        return done
    }

    fun snapshot(): JSONObject {
        prune()
        val arr = JSONArray()
        map.values.sortedWith(compareByDescending<H> { it.ok }.thenBy { if (it.ms == 0) 999999 else it.ms })
            .forEach {
                arr.put(
                    JSONObject().put("name", it.name).put("base", it.base)
                        .put("ok", it.ok).put("ms", it.ms).put("items", it.items)
                        .put("fails", it.fails).put("err", it.err)
                )
            }
        val okList = map.values.filter { it.ok }
        val fastest = okList.filter { it.ms > 0 }.minByOrNull { it.ms }
        return JSONObject()
            .put("list", arr)
            .put("total", Sources.ALL.size)
            .put("ok", okList.size)
            .put("fastest", if (fastest == null) "—" else fastest.name + " " + fastest.ms + "ms")
            .put("checkedAt", lastProbeAt)
            .put("stale", System.currentTimeMillis() - lastProbeAt > TTL)
    }

    /** 按体检结果排好序的源：通的、快的在前；一个都不通就退回全部（让业务自己再试）。 */
    fun ranked(): List<Sources.Src> {
        val all = Sources.ALL
        if (map.isEmpty()) return all
        val ok = ArrayList<Sources.Src>()
        val unknown = ArrayList<Sources.Src>()
        val dead = ArrayList<Sources.Src>()
        all.forEach { s ->
            val h = map[s.base]
            when {
                h == null -> unknown.add(s)
                h.ok -> ok.add(s)
                h.fails >= DEAD_FAILS -> dead.add(s)
                else -> unknown.add(s)
            }
        }
        /* 延迟记在体检结果里，Src 本身不带；快的排前面，没测出耗时的排最后 */
        ok.sortWith(compareBy({ s ->
            val h = map[s.base]
            if (h == null || h.ms <= 0) Int.MAX_VALUE else h.ms
        }))
        val out = ArrayList<Sources.Src>(ok.size + unknown.size + dead.size)
        out.addAll(ok); out.addAll(unknown); out.addAll(dead)
        return if (out.isEmpty()) all else out
    }

    fun okCount(): Int = map.values.count { it.ok }

    /**
     * 用户在设置里删掉源以后，体检记录里还留着它 —— 列表里就会一直挂着一个「不通」的死条目。
     * 每次取快照前按当前源列表裁一遍。
     */
    private fun prune() {
        val alive = Sources.ALL.map { it.base }.toSet()
        if (map.keys.any { it !in alive }) {
            map = LinkedHashMap(map.filterKeys { it in alive })
            persist()
        }
    }

    /**
     * 维护：缓存过期就跑一次体检；体检完一个源都不通，就自动去远端把源清单更新回来再测一遍。
     * 串行执行，不会同时开两轮。
     */
    fun maintain(force: Boolean = false) {
        if (running) return
        val fresh = System.currentTimeMillis() - lastProbeAt < TTL
        if (!force && fresh && map.isNotEmpty()) return
        running = true
        try {
            probe()
            if (okCount() == 0) {
                val added = autoFix()
                if (added > 0) probe()
            }
        } finally {
            running = false
        }
    }

    fun maintainAsync(force: Boolean = false) {
        if (running) return
        if (!force) {
            val fresh = System.currentTimeMillis() - lastProbeAt < TTL
            if (fresh && map.isNotEmpty()) return
            if (System.currentTimeMillis() - lastProbeAt < MAINTAIN_GAP / 30) return
        }
        thread(name = "src-health") { try { maintain(force) } catch (_: Exception) {} }
    }

    /**
     * 没源了：从远端拉最新清单，合并去重写回本地。返回新增了几个源。
     * 远端拉不到就返回 0，本地源原样保留（绝不把用户手里的源清空）。
     */
    fun autoFix(): Int {
        val p = sp
        p?.edit()?.putLong(K_FIX, System.currentTimeMillis())?.apply()
        for (url in REMOTE_LISTS) {
            try {
                val txt = Net.getText(url, 8000).trim()
                /* 远端清单两种格式都认：裸数组，或者 {"sources":[...]} */
                val arr = if (txt.startsWith("[")) {
                    JSONArray(txt)
                } else {
                    JSONObject(txt).optJSONArray("sources") ?: continue
                }
                val remote = ArrayList<Sources.Src>()
                for (i in 0 until arr.length()) {
                    val o = arr.optJSONObject(i) ?: continue
                    val base = o.optString("base").trim().trimEnd('/')
                    if (!base.startsWith("http")) continue
                    remote.add(
                        Sources.Src(
                            o.optString("key").ifBlank { Sources.keyOf(base) },
                            o.optString("name").ifBlank { "源" + (remote.size + 1) },
                            base
                        )
                    )
                }
                if (remote.isEmpty()) continue
                val added = Sources.mergeRemote(remote)
                Net.log("源自愈：从 " + url.substringAfter("//").take(32) + " 拿到 " + remote.size + " 个候选，新增 " + added)
                return added
            } catch (e: Exception) {
                Net.log("源自愈失败（" + url.substringAfter("//").take(24) + "）：" + Net.shortErr(e))
            }
        }
        return 0
    }
}
