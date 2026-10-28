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

    const val UA =
        "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36"

    /** 出厂源：实测能返回 JSON 列表的采集站。用户删光了也不会真的空着。 */
    val BUILTIN: List<Src> = listOf(
        Src("bdzy", "百度云", "https://api.apibdzy.com/api.php/provide/vod"),
        Src("modu", "魔都", "https://caiji.moduapi.cc/api.php/provide/vod"),
        Src("hhzy", "豪华", "https://hhzyapi.com/api.php/provide/vod"),
        Src("bfzy", "暴风", "https://bfzyapi.com/api.php/provide/vod"),
        Src("lzi", "量子", "https://cj.lziapi.com/api.php/provide/vod"),
        Src("wujin", "无尽", "https://api.wujinapi.me/api.php/provide/vod"),
        Src("ffzy", "非凡", "https://api.ffzyapi.com/api.php/provide/vod"),
        Src("zuid", "最大", "https://api.zuidapi.com/api.php/provide/vod")
    )

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

    /** 极简 GET：超时短、跟随重定向、强制 UTF-8。 */
    fun get(url: String, timeoutMs: Int = 9000): String {
        val conn = URL(url).openConnection() as HttpURLConnection
        conn.connectTimeout = timeoutMs
        conn.readTimeout = timeoutMs
        conn.instanceFollowRedirects = true
        conn.setRequestProperty("User-Agent", UA)
        conn.setRequestProperty("Accept", "application/json,text/plain,*/*")
        val code = conn.responseCode
        if (code !in 200..299) throw IOException("HTTP $code")
        val stream = conn.inputStream ?: throw IOException("empty body")
        return stream.bufferedReader(Charsets.UTF_8).use { it.readText() }
    }

    fun enc(s: String): String = URLEncoder.encode(s, "UTF-8")

    data class Row(val key: String, val title: String, val type: String, val srcCount: Int)

    /** 首页每一行要打哪几个源：行内前 N 个。 */
    private fun pick(row: Row): List<Src> = ALL.take(row.srcCount)

    /**
     * 搜索：并发查所有源，合并后按年份倒序（新片在前）。
     * 片名和演员都参与命中判断，所以搜演员名也能出片。
     */
    fun search(wd: String): String {
        if (wd.isBlank()) return JSONObject().put("list", JSONArray()).toString()
        val out = Collections.synchronizedList(ArrayList<JSONObject>())
        val workers = ALL.map { s ->
            thread {
                try {
                    val text = get(s.base + "?ac=videolist&wd=" + enc(wd), 9000)
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
