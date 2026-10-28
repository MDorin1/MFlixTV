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

    /** 首页/搜索用的源池：优先用自检通过的；一个都不通时退回全部（让首页自己再试一次）。 */
    fun usableSources(): List<Src> {
        val probes = readProbeCache() ?: return ALL
        val okBases = probes.filter { it.ok }.map { it.base }.toSet()
        val picked = ALL.filter { it.base in okBases }
        return if (picked.isEmpty()) ALL else picked
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

    data class Row(val key: String, val title: String, val type: String, val srcCount: Int)

    /** 首页每一行要打哪几个源：优先用自检通过的源。 */
    private fun pick(row: Row): List<Src> = usableSources().take(row.srcCount)

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

    /** 首页片单：每行只打 2–4 个源，避免首屏几十个请求把手机拖死。 */
    private val HOME_ROWS = listOf(
        Row("latest", "最近更新", "", 4),
        Row("movie", "电影", "1", 3),
        Row("tv", "剧集", "2", 3),
        Row("show", "综艺", "3", 3),
        Row("anime", "动漫", "4", 2)
    )

    fun homeRows(): List<Row> = HOME_ROWS

    fun fetchRow(row: Row): JSONArray {
        val items = Collections.synchronizedList(ArrayList<JSONObject>())
        val workers = pick(row).map { src ->
            thread {
                try {
                    val q = StringBuilder(src.base).append("?ac=videolist")
                    if (row.type.isNotEmpty()) q.append("&t=").append(row.type)
                    q.append("&pg=1")
                    val text = get(q.toString(), 9000)
                    val arr = JSONObject(text).optJSONArray("list") ?: return@thread
                    val limit = minOf(arr.length(), 24)
                    for (i in 0 until limit) {
                        val o = arr.optJSONObject(i) ?: continue
                        if (o.optString("vod_name").isBlank()) continue
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
}
