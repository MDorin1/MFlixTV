package com.mflixtv.app

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.util.Collections
import kotlin.concurrent.thread

/**
 * 点播源（苹果 CMS v10 接口）。
 *
 * 源可以在手机上改：设置页把列表存进 SharedPreferences，
 * 服务端每次搜索/首页都读当前列表，所以改完立刻生效、重启也还在。
 */
object Sources {

    data class Src(val key: String, val name: String, val base: String)

    /** 出厂源：实测能返回 JSON 列表的采集站。用户删光了也不会真的空着。 */
    val BUILTIN: List<Src> = listOf(
        Src("bdzy", "百度云", "https://api.apibdzy.com/api.php/provide/vod"),
        Src("modu", "魔都", "https://caiji.moduapi.cc/api.php/provide/vod"),
        Src("hhzy", "豪华", "https://hhzyapi.com/api.php/provide/vod"),
        Src("bfzy", "暴风", "https://bfzyapi.com/api.php/provide/vod"),
        Src("lzi", "量子", "https://cj.lziapi.com/api.php/provide/vod"),
        Src("wujin", "无尽", "https://api.wujinapi.me/api.php/provide/vod"),
        Src("ffzy", "非凡", "https://api.ffzyapi.com/api.php/provide/vod"),
        Src("zuid", "最大", "https://api.zuidapi.com/api.php/provide/vod"),
        // 下面是备选：有些地区前几个会被拦，多几个能提高命中；自检不通的可以一键删掉
        Src("wolong", "卧龙", "https://wolongzyw.com/api.php/provide/vod"),
        Src("rycj", "如意", "https://cj.rycjapi.com/api.php/provide/vod"),
        Src("ikun", "iKun", "https://ikunzyapi.com/api.php/provide/vod"),
        Src("360zy", "360", "https://360zy.com/api.php/provide/vod")
    )

    val UA: String get() = Net.UA

    private const val SP = "mflixtv"
    private const val KEY_SOURCES = "sources_json"

    @Volatile private var sp: android.content.SharedPreferences? = null
    @Volatile private var current: List<Src>? = null

    /** 进程启动时调用一次：读出用户存过的源，没有就写入出厂源。 */
    fun init(ctx: Context) {
        if (sp != null) return
        val p = ctx.applicationContext.getSharedPreferences(SP, Context.MODE_PRIVATE)
        sp = p
        if (!p.contains(KEY_SOURCES)) p.edit().putString(KEY_SOURCES, toJson(BUILTIN)).apply()
        current = parse(p.getString(KEY_SOURCES, null))
    }

    val ALL: List<Src> get() = current ?: BUILTIN

    fun byKey(key: String): Src? = ALL.firstOrNull { it.key == key }

    fun byBase(base: String): Src? = ALL.firstOrNull { it.base == base }

    fun toJson(list: List<Src>): String {
        val arr = JSONArray()
        list.forEach { s ->
            arr.put(JSONObject().put("key", s.key).put("name", s.name).put("base", s.base))
        }
        return arr.toString()
    }

    private fun parse(text: String?): List<Src> {
        if (text.isNullOrBlank()) return BUILTIN
        return try {
            val arr = JSONArray(text)
            val out = ArrayList<Src>()
            for (i in 0 until arr.length()) {
                val o = arr.optJSONObject(i) ?: continue
                val base = o.optString("base").trim().trimEnd('/')
                if (!base.startsWith("http")) continue
                if (out.any { it.base == base }) continue
                out.add(
                    Src(
                        o.optString("key").ifBlank { keyOf(base) },
                        o.optString("name").ifBlank { hostOf(base) },
                        base
                    )
                )
            }
            if (out.isEmpty()) BUILTIN else out
        } catch (_: Exception) {
            BUILTIN
        }
    }

    /** 保存用户编辑后的源列表（JSON 数组字符串）。返回保存后的条数，-1 表示格式不对。 */
    fun save(json: String): Int {
        val list = try {
            parseStrict(json)
        } catch (_: Exception) {
            return -1
        }
        if (list.isEmpty()) return -1
        sp?.edit()?.putString(KEY_SOURCES, toJson(list))?.apply()
        current = list
        return list.size
    }

    fun reset(): Int {
        sp?.edit()?.putString(KEY_SOURCES, toJson(BUILTIN))?.apply()
        current = BUILTIN
        return BUILTIN.size
    }

    private fun parseStrict(text: String): List<Src> {
        val arr = JSONArray(text)
        val out = ArrayList<Src>()
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            val base = o.optString("base").trim().trimEnd('/')
            if (!base.startsWith("http")) continue
            if (out.any { it.base == base }) continue
            out.add(
                Src(
                    o.optString("key").ifBlank { keyOf(base) },
                    o.optString("name").ifBlank { hostOf(base) },
                    base
                )
            )
        }
        return out
    }

    fun keyOf(base: String): String = hostOf(base).replace(Regex("[^a-z0-9]"), "").take(12).ifBlank { "src" }

    private fun hostOf(base: String): String = try {
        URL(base).host.ifBlank { "src" }
    } catch (_: Exception) {
        "src"
    }

    /**
     * GET。https 失败自动退回同域 http：
     * 有些采集站证书链不完整或只配了 http，Android 上 https 会直接失败，换 http 往往就通。
     */
    fun get(url: String, timeoutMs: Int = 6000): String {
        return try {
            Net.getText(url, timeoutMs)
        } catch (e: Exception) {
            if (url.startsWith("https://")) {
                Net.getText("http://" + url.removePrefix("https://"), timeoutMs)
            } else throw e
        }
    }

    /* ---------------- 源自检 ---------------- */

    private const val K_PROBE = "probe_json"
    private const val K_PROBE_TS = "probe_ts"
    private const val PROBE_TTL = 20 * 60 * 1000L

    @Volatile private var probeCache: List<Probe>? = null

    data class Probe(val base: String, val name: String, val ok: Boolean, val ms: Int, val err: String)

    private fun readProbeCache(): List<Probe>? {
        probeCache?.let { return it }
        val p = sp ?: return null
        if (System.currentTimeMillis() - p.getLong(K_PROBE_TS, 0L) > PROBE_TTL) return null
        return try {
            val arr = JSONArray(p.getString(K_PROBE, "[]"))
            val out = ArrayList<Probe>()
            for (i in 0 until arr.length()) {
                val o = arr.optJSONObject(i) ?: continue
                out.add(
                    Probe(
                        o.optString("base"), o.optString("name"), o.optBoolean("ok"),
                        o.optInt("ms"), o.optString("err")
                    )
                )
            }
            if (out.isEmpty()) null else out.also { probeCache = it }
        } catch (_: Exception) {
            null
        }
    }

    private fun writeProbeCache(list: List<Probe>) {
        probeCache = list
        val p = sp ?: return
        val arr = JSONArray()
        list.forEach {
            arr.put(
                JSONObject().put("base", it.base).put("name", it.name)
                    .put("ok", it.ok).put("ms", it.ms).put("err", it.err)
            )
        }
        p.edit().putString(K_PROBE, arr.toString())
            .putLong(K_PROBE_TS, System.currentTimeMillis()).apply()
    }

    /** 逐个源打一次轻量请求（只要列表接口），拿回「通 / 不通 + 耗时 + 错误」。 */
    fun probeAll(timeoutMs: Int = 6000, useCache: Boolean = false): List<Probe> {
        if (useCache) readProbeCache()?.let { return it }
        val out = Collections.synchronizedList(ArrayList<Probe>())
        val workers = ALL.map { s ->
            thread {
                val t0 = System.currentTimeMillis()
                var ok = false
                var err = ""
                try {
                    val txt = get(s.base + "?ac=videolist&pg=1", timeoutMs)
                    ok = txt.contains("\"list\"") || txt.contains("\\\"list\\\"")
                    if (!ok) err = "返回不是列表（可能被拦截或换了接口）"
                } catch (e: Exception) {
                    err = Net.shortErr(e)
                }
                out.add(Probe(s.base, s.name, ok, (System.currentTimeMillis() - t0).toInt(), err))
            }
        }
        workers.forEach { it.join((timeoutMs + 4000).toLong()) }
        val list = out.toList().sortedBy { it.name }
        writeProbeCache(list)
        return list
    }

    /** 首页/搜索用的源池：按体检结果排序（通的、快的在前）；没有体检数据就按原顺序。 */
    fun usableSources(): List<Src> {
        val ranked = try {
            SourceHealth.ranked()
        } catch (_: Throwable) {
            ALL
        }
        return if (ranked.isEmpty()) ALL else ranked
    }

    /** 让老的 probeAll 缓存作废（体检结果更新后调用）。 */
    fun invalidateProbe() {
        probeCache = null
    }

    /**
     * 把远端拉回来的候选源合并进本地列表：按 base 去重，已有的保留原来的 key / 名字。
     * 返回新增了几个。源站换了域名的时候靠这个自动补回来。
     */
    fun mergeRemote(remote: List<Src>): Int {
        val cur = ArrayList(ALL)
        var added = 0
        remote.forEach { s ->
            if (cur.none { it.base == s.base }) {
                val k = if (cur.any { it.key == s.key }) keyOf(s.base) + (cur.size) else s.key
                cur.add(Src(k, s.name, s.base))
                added++
            }
        }
        if (added > 0) {
            sp?.edit()?.putString(KEY_SOURCES, toJson(cur))?.apply()
            current = cur
        }
        return added
    }

    fun probeJson(useCache: Boolean = true): String {
        val list = try {
            probeAll(useCache = useCache)
        } catch (_: Exception) {
            emptyList()
        }
        val arr = JSONArray()
        list.forEach {
            arr.put(
                JSONObject().put("name", it.name).put("base", it.base)
                    .put("ok", it.ok).put("ms", it.ms).put("err", it.err)
            )
        }
        val okCount = list.count { it.ok }
        return JSONObject()
            .put("sources", arr)
            .put("total", list.size)
            .put("ok", okCount)
            .put("proxy", Net.proxyString())
            .toString()
    }

    fun enc(s: String): String = URLEncoder.encode(s, "UTF-8")

    data class Row(val key: String, val title: String, val names: List<String>, val type: String, val srcCount: Int)

    /** 首页每一行要打哪几个源：优先用自检通过的源。 */
    private fun pick(row: Row): List<Src> = usableSources().take(row.srcCount)

    /**
     * 分类名 → type_id 映射。
     * CMS 的 `t` 参数只认数字 id，而各家 id 完全不一样（同一个「短剧」在 A 站是 30、在 B 站是 5），
     * 所以先拿一次 `?ac=list` 的 class 表，按分类名找 id；查不到再退回写死的老 id。
     */
    private val catCache = java.util.concurrent.ConcurrentHashMap<String, Pair<Map<String, Int>, Long>>()

    private fun catMap(base: String): Map<String, Int> {
        val now = System.currentTimeMillis()
        catCache[base]?.let { if (now - it.second < 30 * 60 * 1000L) return it.first }
        val map = HashMap<String, Int>()
        try {
            val json = JSONObject(get(base + "?ac=list", 8000))
            val arr = json.optJSONArray("class") ?: json.optJSONArray("list") ?: JSONArray()
            for (i in 0 until arr.length()) {
                val o = arr.optJSONObject(i) ?: continue
                val id = o.optInt("type_id", -1)
                val nm = o.optString("type_name").trim()
                if (id > 0 && nm.isNotEmpty()) map[nm] = id
            }
        } catch (_: Exception) {
        }
        catCache[base] = map to now
        return map
    }

    private fun typeIdFor(src: Src, row: Row): String {
        if (row.names.isEmpty()) return row.type
        val map = catMap(src.base)
        for (want in row.names) map.entries.firstOrNull { it.key == want }?.let { return it.value.toString() }
        for (want in row.names) map.entries.firstOrNull { it.key.contains(want) }?.let { return it.value.toString() }
        return row.type
    }

    /**
     * 搜索：并发查所有源，合并后按年份倒序（新片在前）。
     * 片名和演员都参与命中判断，所以搜演员名也能出片。
     */
    fun search(wd: String): String {
        if (wd.isBlank()) return JSONObject().put("list", JSONArray()).toString()
        val out = Collections.synchronizedList(ArrayList<JSONObject>())
        val workers = usableSources().map { s ->
            thread {
                try {
                    val text = get(s.base + "?ac=videolist&wd=" + enc(wd), 7000)
                    val json = JSONObject(text)
                    val arr = json.optJSONArray("list") ?: return@thread
                    for (i in 0 until arr.length()) {
                        val o = arr.optJSONObject(i) ?: continue
                        out.add(item(s, o))
                    }
                } catch (_: Exception) {
                }
            }
        }
        workers.forEach { it.join(10000) }

        val sorted = out.sortedWith(
            compareByDescending<JSONObject> { it.optString("year").toIntOrNull() ?: 0 }
                .thenByDescending { it.optString("remarks").contains("更新") }
        )
        val root = JSONObject()
        val arr = JSONArray()
        sorted.forEach { arr.put(it) }
        root.put("list", arr)
        root.put("count", arr.length())
        return root.toString()
    }

    fun item(src: Src, o: JSONObject): JSONObject = JSONObject().apply {
        put("name", o.optString("vod_name"))
        put("pic", o.optString("vod_pic"))
        put("year", o.optString("vod_year"))
        put("remarks", o.optString("vod_remarks"))
        put("typeName", o.optString("type_name"))
        put("actor", o.optString("vod_actor"))
        put("vodId", o.optString("vod_id"))
        put("src", src.key)
        put("srcName", src.name)
        put("sourceUrl", src.base)
    }

    /**
     * 首页片单：每行只打 2–4 个源，避免首屏几十个请求把手机拖死。
     * 顺序对齐电脑端：最近更新 → 电影 → 剧集 → 短剧 → 综艺（→ 动漫）。
     */
    private val HOME_ROWS = listOf(
        Row("latest", "最近更新", emptyList(), "", 4),
        Row("movie", "电影", listOf("电影", "片"), "1", 3),
        Row("tv", "剧集", listOf("电视剧", "连续剧", "剧集", "国产剧", "欧美剧"), "2", 3),
        Row("short", "短剧", listOf("短剧", "微短剧", "短剧场", "竖屏剧"), "", 3),
        Row("show", "综艺", listOf("综艺", "真人秀"), "3", 3),
        Row("anime", "动漫", listOf("动漫", "动画"), "4", 2)
    )

    fun homeRows(): List<Row> = HOME_ROWS

    fun fetchRow(row: Row): JSONArray {
        val items = Collections.synchronizedList(ArrayList<JSONObject>())
        val workers = pick(row).map { src ->
            thread {
                try {
                    val t = typeIdFor(src, row)
                    // 短剧这类新分类不一定在所有源里建了分类，那就退回按关键词搜
                    val byKeyword = t.isEmpty() && row.key == "short"
                    val url = if (byKeyword) {
                        src.base + "?ac=videolist&wd=" + enc("短剧")
                    } else {
                        val q = StringBuilder(src.base).append("?ac=videolist")
                        if (t.isNotEmpty()) q.append("&t=").append(t)
                        q.append("&pg=1")
                        q.toString()
                    }
                    val text = get(url, 9000)
                    val arr = JSONObject(text).optJSONArray("list") ?: return@thread
                    val limit = minOf(arr.length(), 24)
                    for (i in 0 until limit) {
                        val o = arr.optJSONObject(i) ?: continue
                        if (o.optString("vod_name").isBlank()) continue
                        if (byKeyword) {
                            val nm = o.optString("type_name")
                            if (!nm.contains("短剧") && !o.optString("vod_name").contains("短剧")) continue
                        }
                        items.add(item(src, o))
                    }
                } catch (_: Exception) {
                }
            }
        }
        workers.forEach { it.join(11000) }

        val dedup = LinkedHashMap<String, JSONObject>()
        items.forEach {
            val n = it.optString("name").trim()
            if (n.isNotEmpty() && !dedup.containsKey(n)) dedup[n] = it
        }
        val arr = JSONArray()
        dedup.values.forEach { arr.put(it) }
        return arr
    }

    /**
     * 首页顶部大图轮播（5–8 部）。
     *
     * 有观看记录时按「最近看的那部」推同类：先按片名搜同系列/同类型，同类型的排前面，
     * 自己不算推荐；凑不满 5 部就用最近更新补足。没有观看记录就直接给最近更新。
     */
    fun hero(name: String, type: String): String {
        val arr = JSONArray()
        val seen = LinkedHashMap<String, Boolean>()
        val want = name.trim()
        val wantType = type.trim()

        fun push(o: JSONObject?): Boolean {
            if (o == null) return false
            val n = o.optString("name").trim()
            if (n.isEmpty()) return false
            if (seen.containsKey(n)) return false
            seen[n] = true
            arr.put(o)
            return arr.length() >= 8
        }

        if (want.length >= 2) {
            try {
                val found = JSONObject(search(want)).optJSONArray("list") ?: JSONArray()
                val pool = ArrayList<JSONObject>()
                for (i in 0 until found.length()) {
                    val o = found.optJSONObject(i) ?: continue
                    val n = o.optString("name").trim()
                    // 自己（同名）不算推荐
                    if (n.equals(want, true) || n.startsWith(want) || want.startsWith(n)) continue
                    pool.add(o)
                }
                // 同类型的排前面，再按年份从新到旧
                pool.sortWith(
                    compareByDescending<JSONObject> {
                        if (wantType.isNotBlank() && it.optString("typeName").contains(wantType)) 1 else 0
                    }.thenByDescending { it.optString("year").toIntOrNull() ?: 0 }
                )
                for (o in pool) {
                    if (push(o)) break
                }
            } catch (_: Exception) {
            }
        }

        if (arr.length() < 5) {
            try {
                val latest = fetchRow(Row("latest", "最近更新", emptyList(), "", 4))
                for (i in 0 until latest.length()) {
                    if (push(latest.optJSONObject(i))) break
                }
            } catch (_: Exception) {
            }
        }

        return JSONObject()
            .put("list", arr)
            .put("from", if (want.length >= 2 && arr.length() > 0) "like" else "latest")
            .put("like", want)
            .toString()
    }
}
