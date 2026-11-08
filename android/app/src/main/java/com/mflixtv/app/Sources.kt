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
        // 海外向片库：日韩综艺 / 欧美综艺更新最快的一批。
        // 字幕标注不写进源名了（国产剧也被打上「熟肉」是错的）：
        // 改成详情页 / 播放页按影片地区判断，只有境外内容才显示「熟肉」。
        Src("sony", "索尼", "https://suoniapi.com/api.php/provide/vod"),
        Src("tyys", "天涯", "https://tyyszy.com/api.php/provide/vod"),
        Src("dytt", "电影天堂", "https://caiji.dyttzyapi.com/api.php/provide/vod"),
        // 下面是备选：有些地区前几个会被拦，多几个能提高命中；自检不通的可以一键删掉
        Src("wolong", "卧龙", "https://wolongzyw.com/api.php/provide/vod"),
        Src("rycj", "如意", "https://cj.rycjapi.com/api.php/provide/vod"),
        Src("ikun", "iKun", "https://ikunzyapi.com/api.php/provide/vod"),
        Src("360zy", "360", "https://360zy.com/api.php/provide/vod"),
        // 海外专库：库里专门有「海外剧 / 日韩剧 / 港台剧」这些分类，
        // 实测是全场更新最快的一批（日韩综艺、海外剧都能到当天深夜），
        // 国产剧/国内片子也照常齐全，所以直接当常驻源用。
        Src("haiwai", "海外影院", "https://lovedan.net/api.php/provide/vod"),
        Src("gszy", "光速", "https://api.guangsuapi.com/api.php/provide/vod")
    )

    val UA: String get() = Net.UA

    private const val SP = "mflixtv"
    private const val KEY_SOURCES = "sources_json"
    private const val KEY_OFF = "sources_off"
    private const val KEY_BUILTIN_VER = "sources_builtin_ver"

    /**
     * 出厂源版本号。每次往 [BUILTIN] 里加源、或改了源名就 +1：
     * 升级时把新内置源补进用户已存的列表，并按 base 刷新同名源的显示名
     * （1.4 里那批「量子·熟肉」就是靠这里改回「量子」的），
     * 用户自己加的源与增删顺序都不动。
     */
    private const val BUILTIN_VER = 4

    @Volatile private var sp: android.content.SharedPreferences? = null
    @Volatile private var current: List<Src>? = null
    @Volatile private var offCache: MutableSet<String>? = null

    /** 进程启动时调用一次：读出用户存过的源，没有就写入出厂源。 */
    fun init(ctx: Context) {
        if (sp != null) return
        val p = ctx.applicationContext.getSharedPreferences(SP, Context.MODE_PRIVATE)
        sp = p
        if (!p.contains(KEY_SOURCES)) {
            p.edit().putString(KEY_SOURCES, toJson(BUILTIN)).putInt(KEY_BUILTIN_VER, BUILTIN_VER).apply()
        } else if (p.getInt(KEY_BUILTIN_VER, 1) < BUILTIN_VER) {
            // 出厂源升级：补新源、刷新同名源的名字，不动用户自己加的那些
            val cur = parse(p.getString(KEY_SOURCES, null)).toMutableList()
            for (b in BUILTIN) {
                val i = cur.indexOfFirst { it.base == b.base }
                if (i < 0) cur.add(b) else if (cur[i].name != b.name) cur[i] = cur[i].copy(name = b.name)
            }
            p.edit().putString(KEY_SOURCES, toJson(cur)).putInt(KEY_BUILTIN_VER, BUILTIN_VER).apply()
        }
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
        val base = if (ranked.isEmpty()) ALL else ranked
        // 停用的源不参与搜索与首页取数；全被停用时退回全集，别让用户自己把自己锁死
        val alive = base.filter { !isOff(it.key) }
        return if (alive.isEmpty()) base else alive
    }

    // ===== 停用清单（片源体检里手动关掉，或连续失败自动关掉）=====

    private fun offSet(): MutableSet<String> {
        offCache?.let { return it }
        val cur = try {
            (sp?.getString(KEY_OFF, "") ?: "").split(',').filter { it.isNotBlank() }.toMutableSet()
        } catch (_: Exception) {
            mutableSetOf()
        }
        offCache = cur
        return cur
    }

    fun isOff(key: String): Boolean = offSet().contains(key)

    fun offKeys(): Set<String> = offSet().toSet()

    fun setOff(key: String, value: Boolean): Boolean {
        if (key.isBlank()) return false
        val s = offSet()
        if (value) s.add(key) else s.remove(key)
        try {
            sp?.edit()?.putString(KEY_OFF, s.joinToString(","))?.apply()
        } catch (_: Exception) {
        }
        return true
    }

    /** 导出配置：源清单 + 停用清单。换设备时把这段 JSON 粘过去就能还原。 */
    fun exportJson(): String = JSONObject()
        .put("version", 1)
        .put("sources", JSONArray(toJson(ALL)))
        .put("off", JSONArray(offSet().toList()))
        .toString()

    /** 导入配置：替换源清单并恢复停用清单。返回导入后的源条数，-1 表示格式不对。 */
    fun importJson(text: String): Int {
        val o = try {
            JSONObject(text)
        } catch (_: Exception) {
            return -1
        }
        val arr = o.optJSONArray("sources") ?: return -1
        val n = save(arr.toString())
        if (n < 0) return -1
        val s = mutableSetOf<String>()
        val offs = o.optJSONArray("off")
        if (offs != null) for (i in 0 until offs.length()) s.add(offs.optString(i))
        try {
            sp?.edit()?.putString(KEY_OFF, s.joinToString(","))?.apply()
        } catch (_: Exception) {
        }
        offCache = s
        invalidateProbe()
        return n
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

    /**
     * 一个源在一行里要取哪几个分类（最多 [max] 个）。
     *
     * 为什么不是一个：采集站的顶级分类常常是空壳——量子 lziapi 的「连续剧」只有 3 部、
     * 「电影片」只有 1 部，真正的片全挂在「国产剧 / 欧美剧 / 动作片」这些叶子分类下。
     * 只取第一个命中的分类，首页「电影 / 剧集」就会只剩两三张卡，看着像坏了。
     * 这里按 row.names 里的顺序挑（叶子分类排在前面），取几个分类的结果再合并去重。
     */
    private fun typeIdsFor(src: Src, row: Row, max: Int): List<String> {
        val out = ArrayList<String>()
        if (row.names.isNotEmpty()) {
            val map = catMap(src.base)
            for (want in row.names) {
                if (out.size >= max) break
                val hit = map.entries.firstOrNull { it.key == want }
                    ?: map.entries.firstOrNull { it.key.contains(want) }
                val id = hit?.value?.toString() ?: continue
                if (!out.contains(id)) out.add(id)
            }
        }
        if (out.isEmpty() && row.type.isNotBlank()) out.add(row.type)
        return out
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

        /* 排序按「新旧年份」而不是 vod_year：连载综艺的 vod_year 是首播年，
           拿它排会把今天还在更新的节目压到十年前那一档（口径同电脑端 recencyYear）。 */
        val sorted = out.sortedWith(
            compareByDescending<JSONObject> { it.optInt("recencyYear", it.optString("year").toIntOrNull() ?: 0) }
                .thenByDescending { it.optString("latestDate") }
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
        val rawRemarks = o.optString("vod_remarks")
        /* 内容新鲜度（和电脑端同一套口径，见 Freshness）：
           latestDate 是备注里的最新一期日期，yearLabel 跨年时写「2016起」，
           freshLabel 是详情页那一行「最新一集 … · 源 N 个月前更新」。
           以前这些只在 Next.js 里算，安卓端一条都没有，电视上永远是老样子。 */
        val latest = Freshness.latestEpisodeDate(rawRemarks)
        put("name", o.optString("vod_name"))
        put("pic", o.optString("vod_pic"))
        put("year", o.optString("vod_year"))
        put("remarks", Freshness.formatRemarks(rawRemarks) ?: rawRemarks)
        put("latestDate", latest ?: "")
        put("yearLabel", Freshness.yearLabel(o.optString("vod_year"), latest))
        put("recencyYear", Freshness.recencyYear(o.optString("vod_year"), latest))
        put(
            "freshLabel",
            if (latest == null) "" else Freshness.freshnessLabel(Freshness.Latest(latest, "remarks"))
        )
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
        // 分类名按「叶子优先」排：顶级分类（电影片/连续剧/综艺片）多半是空壳，
        // 真片都在动作片、国产剧、大陆综艺这些子分类下
        Row("movie", "电影", listOf("电影", "片", "动作片", "剧情片", "喜剧片", "科幻片", "爱情片", "犯罪片", "战争片"), "1", 3),
        Row("tv", "剧集", listOf("电视剧", "连续剧", "剧集", "国产剧", "欧美剧", "韩剧", "日剧", "港台剧"), "2", 3),
        // 海外专库行：各源谁有「海外剧 / 日韩剧 / 欧美剧 / 日韩综艺 …」就取谁的这几个分类，
        // 四源合起来就是一排海外新片。没有这些细分类的源直接跳过，不拿「全站最新」来凑数。
        Row(
            "haiwai", "海外热播",
            listOf("海外剧", "日韩剧", "欧美剧", "韩剧", "日剧", "美剧", "泰剧", "日韩综艺", "欧美综艺", "港台综艺", "海外动漫"),
            "", 4
        ),
        Row("short", "短剧", listOf("短剧", "微短剧", "短剧场", "竖屏剧"), "", 3),
        Row("show", "综艺", listOf("综艺", "真人秀", "大陆综艺", "日韩综艺", "欧美综艺"), "3", 3),
        Row("anime", "动漫", listOf("动漫", "动画", "国产动漫", "日韩动漫"), "4", 2)
    );

    /** 一行里每个源最多取几个分类（分类的片合起来再截断，够填满一排） */
    private const val ROW_CATS_PER_SOURCE = 3

    /** 预告片 / 花絮 / 解说这类非正片：采集站会把它们塞进电影分类里 */
    private fun isFiller(name: String, remarks: String): Boolean {
        val t = name + " " + remarks
        return t.contains("预告片") || t.contains("花絮") || t.contains("抢先看") ||
            t.contains("解说") || t.contains("片花")
    }

    fun homeRows(): List<Row> = HOME_ROWS

    fun fetchRow(row: Row): JSONArray {
        val items = Collections.synchronizedList(ArrayList<JSONObject>())
        val workers = pick(row).map { src ->
            thread {
                try {
                    val ids = typeIdsFor(src, row, ROW_CATS_PER_SOURCE)
                    // 短剧这类新分类不一定在所有源里建了分类，那就退回按关键词搜
                    val byKeyword = ids.isEmpty() && row.key == "short"
                    // 有分类名却一个都没命中（海外剧/日韩综艺这种细分类常有的情况）：
                    // 宁可这一行少一个源，也不要拿「全站最新」的国产片填进去
                    if (ids.isEmpty() && row.names.isNotEmpty() && !byKeyword) return@thread
                    val urls = if (byKeyword) {
                        listOf(src.base + "?ac=videolist&wd=" + enc("短剧"))
                    } else if (ids.isEmpty()) {
                        listOf(src.base + "?ac=videolist&pg=1")
                    } else {
                        ids.map { src.base + "?ac=videolist&t=" + it + "&pg=1" }
                    }
                    // 一个源几个分类合起来最多留 24 条，别让第一个分类把整行占满
                    val perUrl = maxOf(6, 24 / urls.size)
                    for (url in urls) {
                        val text = try {
                            get(url, 9000)
                        } catch (_: Exception) {
                            continue
                        }
                        val arr = JSONObject(text).optJSONArray("list") ?: continue
                        val limit = minOf(arr.length(), perUrl)
                        for (i in 0 until limit) {
                            val o = arr.optJSONObject(i) ?: continue
                            val nm = o.optString("vod_name").trim()
                            if (nm.isEmpty()) continue
                            // 预告片/花絮/解说这类短片会把整排挤满，首页只要正片
                            if (isFiller(nm, o.optString("vod_remarks"))) continue
                            if (byKeyword) {
                                val tn = o.optString("type_name")
                                if (!tn.contains("短剧") && !nm.contains("短剧")) continue
                            }
                            items.add(item(src, o))
                        }
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
                    }.thenByDescending {
                        it.optInt("recencyYear", it.optString("year").toIntOrNull() ?: 0)
                    }
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
