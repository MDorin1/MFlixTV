package com.mflixtv.app

import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Calendar as JCal
import java.util.Collections
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import kotlin.concurrent.thread

/**
 * 追剧日历（周表）——电脑端 /api/calendar 的手机版。
 *
 * 数据来源只有一条：各采集源「最新更新」列表里的 vod_time。
 * 也就是「源站已经发生的更新」，不是我们编的排播表，所以文案必须实话说
 * 「按源站更新记录统计，实际会延迟」，不能承诺几点更新。
 *
 * 三条硬规则（来自 kanju.ai 周表的实测教训）：
 *  1. 日期条上的数字和下面列表用同一份数据现算，绝不两次查询分别取
 *     （否则「日期条 61 部、点进去 59 部」会被当成数据坏了）；
 *  2. 一部片按「日期 + 片名」去重，多个采集站同一天更新同一部只算一条；
 *  3. 全周快照缓存 10 分钟：切日期/切分类不再回头打源站。
 */
object CalendarWeek {

    private const val TTL_MS = 10 * 60 * 1000L
    private const val PAGES = 2
    private const val MAX_SOURCES = 5

    private val CN: TimeZone = TimeZone.getTimeZone("Asia/Shanghai")
    private val WEEKDAYS = arrayOf("周一", "周二", "周三", "周四", "周五", "周六", "周日")

    /** 接口/缓存按这三个入参区分 */
    private var cacheKey: String = ""
    private var cacheAt: Long = 0L
    private var cacheBody: String? = null

    data class Card(
        val name: String,
        val pic: String,
        val remarks: String,
        val year: String,
        val area: String,
        val typeName: String,
        val date: String,
        val at: String,
        val kind: String,
        val sourceKey: String,
        val sourceName: String,
        val sourceUrl: String,
        val vodId: String
    )

    /* --------------------------- 日期小工具 --------------------------- */

    private fun utc(): JCal = JCal.getInstance(TimeZone.getTimeZone("UTC"))

    private fun stamp(date: String): Long {
        val p = date.split("-")
        val c = utc()
        c.clear()
        c.set(p[0].toInt(), p[1].toInt() - 1, p[2].toInt(), 0, 0, 0)
        return c.timeInMillis
    }

    private fun fromStamp(ms: Long): String {
        val c = utc()
        c.timeInMillis = ms
        return String.format(Locale.US, "%04d-%02d-%02d", c.get(JCal.YEAR), c.get(JCal.MONTH) + 1, c.get(JCal.DAY_OF_MONTH))
    }

    private fun addDays(date: String, days: Int): String = fromStamp(stamp(date) + days * 86400000L)

    /** 1=周一 … 7=周日 */
    private fun weekdayOf(date: String): Int {
        val c = utc()
        c.timeInMillis = stamp(date)
        return ((c.get(JCal.DAY_OF_WEEK) + 5) % 7) + 1
    }

    private fun weekdayLabel(w: Int): String = WEEKDAYS[((w - 1) % 7 + 7) % 7]

    private fun dayLabel(date: String): String = date.substring(8, 10).trimStart('0') + "日"

    private fun today(): String {
        val f = SimpleDateFormat("yyyy-MM-dd", Locale.US)
        f.timeZone = CN
        return f.format(Date())
    }

    private fun mondayOf(date: String): String = addDays(date, 1 - weekdayOf(date))

    /** `2026-10-28 22:00:00` / `2026/10/28 22:00` / `2026-10-28` */
    private fun parseTime(raw: String): Pair<String, String>? {
        val m = Regex("^(\\d{4})[-/.](\\d{1,2})[-/.](\\d{1,2})(?:[ T](\\d{1,2}):(\\d{2}))?").find(raw.trim()) ?: return null
        val g = m.groupValues
        val date = String.format(Locale.US, "%s-%02d-%02d", g[1], g[2].toInt(), g[3].toInt())
        val at = if (g[4].isNotEmpty() && g[5].isNotEmpty()) String.format(Locale.US, "%02d:%s", g[4].toInt(), g[5]) else ""
        return date to at
    }

    private fun episodeOf(remarks: String): Int {
        val m = Regex("(?:更新至|更新到|第)?\\s*(\\d{1,4})\\s*集").find(remarks)
        if (m != null) return m.groupValues[1].toInt()
        val bare = Regex("^(\\d{1,4})$").find(remarks.trim())
        return bare?.groupValues?.get(1)?.toInt() ?: 0
    }

    /** 一部片只归一类：短剧最先判（很多源把短剧挂在国产剧下） */
    private fun kindOf(typeName: String, name: String): String {
        val t = typeName
        fun has(vararg w: String) = w.any { t.contains(it) }
        if (has("短剧", "微短剧", "竖屏剧", "短剧场") || name.contains("短剧")) return "short"
        if (has("动漫", "动画", "番剧", "国漫", "日漫")) return "anime"
        if (has("综艺", "真人秀", "脱口秀", "访谈", "晚会")) return "variety"
        if (has("电视剧", "连续剧", "剧集", "国产剧", "欧美剧", "韩剧", "日剧", "港剧", "台剧")) return "series"
        if (has("电影", "片")) return "movie"
        return "other"
    }

    private fun label(kind: String): String = when (kind) {
        "series" -> "电视剧"
        "movie" -> "电影"
        "anime" -> "动漫"
        "variety" -> "综艺"
        "short" -> "短剧"
        else -> "其他"
    }

    private val KINDS = arrayOf("series", "movie", "anime", "variety", "short", "other")

    /* ----------------------------- 取数 ----------------------------- */

    private fun fetchSource(src: Sources.Src): List<Card> {
        val out = ArrayList<Card>()
        for (page in 1..PAGES) {
            try {
                val txt = Sources.get(src.base + "?ac=videolist&pg=" + page, 8000)
                val arr = JSONObject(txt).optJSONArray("list") ?: continue
                for (i in 0 until arr.length()) {
                    val o = arr.optJSONObject(i) ?: continue
                    val name = o.optString("vod_name").trim()
                    val vodId = o.optString("vod_id").trim()
                    if (name.isEmpty() || vodId.isEmpty()) continue
                    val parsed = parseTime(o.optString("vod_time"))
                        ?: parseTime(o.optString("vod_pubdate"))
                        ?: continue
                    val typeName = o.optString("type_name")
                    out.add(
                        Card(
                            name = name,
                            pic = o.optString("vod_pic"),
                            remarks = o.optString("vod_remarks"),
                            year = o.optString("vod_year"),
                            area = o.optString("vod_area"),
                            typeName = typeName,
                            date = parsed.first,
                            at = parsed.second,
                            kind = kindOf(typeName, name),
                            sourceKey = src.key,
                            sourceName = src.name,
                            sourceUrl = src.base,
                            vodId = vodId
                        )
                    )
                }
            } catch (_: Exception) {
                // 单页失败就少一页，不影响其它源
            }
        }
        return out
    }

    private fun snapshot(): List<Card> {
        val raw = Collections.synchronizedList(ArrayList<Card>())
        val workers = Sources.usableSources().take(MAX_SOURCES).map { src ->
            thread { raw.addAll(fetchSource(src)) }
        }
        workers.forEach { it.join(20000) }

        // 「日期 + 片名」去重：同一天同一部只留更新时间更晚的那条
        val map = LinkedHashMap<String, Card>()
        raw.forEach { c ->
            val key = c.date + "|" + c.name.trim().lowercase(Locale.US).replace(Regex("[\\s\\p{P}\\p{S}]+"), "")
            val prev = map[key]
            if (prev == null || c.at > prev.at) map[key] = c
        }
        return ArrayList(map.values)
    }

    /* ----------------------------- 出口 ----------------------------- */

    fun json(week: String?, kind: String?, watch: String?, limit: Int, day: String? = null): String {
        val today = today()
        val weekStart = when (week) {
            null, "", "current" -> mondayOf(today)
            "prev" -> addDays(mondayOf(today), -7)
            "next" -> addDays(mondayOf(today), 7)
            else -> if (Regex("^\\d{4}-\\d{2}-\\d{2}$").matches(week)) mondayOf(week) else mondayOf(today)
        }
        val weekEnd = addDays(weekStart, 6)

        // 前端点日期条时传 day，直接定选哪天；不传就本周选今天、别的周选周一。
        // 以前只能按「今天」选，点别的日子只能拿到今天的列表——手机上就是「点了没反应」。
        val auto = if (today in weekStart..weekEnd) today else weekStart
        val selected = if (!day.isNullOrBlank() &&
            Regex("^\\d{4}-\\d{2}-\\d{2}$").matches(day) &&
            day >= weekStart && day <= weekEnd
        ) day else auto

        val lim = limit.coerceIn(3, 60)
        val key = weekStart + "|" + selected + "|" + kind.orEmpty() + "|" + watch.orEmpty() + "|" + lim
        val now = System.currentTimeMillis()
        val body = if (cacheBody != null && cacheKey == key && now - cacheAt < TTL_MS) {
            cacheBody!!
        } else {
            val built = build(weekStart, weekEnd, today, selected, kind, watch, lim)
            cacheKey = key
            cacheAt = now
            cacheBody = built
            built
        }
        return body
    }

    private fun build(
        weekStart: String,
        weekEnd: String,
        today: String,
        selectedIn: String,
        kind: String?,
        watch: String?,
        limitIn: Int
    ): String {
        val limit = limitIn.coerceIn(3, 60)
        var items = snapshot()

        // 「只看我追的剧」：手机端传进来的是片名清单（换行或逗号分隔）
        val watchSet = HashSet<String>()
        (watch ?: "").split('\n', ',').forEach { t ->
            val n = t.trim().lowercase(Locale.US).replace(Regex("[\\s\\p{P}\\p{S}]+"), "")
            if (n.length >= 2) watchSet.add(n)
        }
        val watchOnly = watchSet.isNotEmpty()
        if (watchOnly) {
            items = ArrayList(items.filter {
                watchSet.contains(it.name.trim().lowercase(Locale.US).replace(Regex("[\\s\\p{P}\\p{S}]+"), ""))
            })
        }

        val week = items.filter { it.date >= weekStart && it.date <= weekEnd }

        // 每天每类的计数（与列表同源）
        val dayTotals = HashMap<String, HashMap<String, Int>>()
        for (i in 0..6) {
            val d = addDays(weekStart, i)
            val m = HashMap<String, Int>()
            m["all"] = 0
            KINDS.forEach { m[it] = 0 }
            dayTotals[d] = m
        }
        week.forEach { c ->
            val m = dayTotals[c.date] ?: return@forEach
            m["all"] = (m["all"] ?: 0) + 1
            m[c.kind] = (m[c.kind] ?: 0) + 1
        }

        // 选中的日子由调用方定（json() 里已经校验过落在本周内）
        val selected = selectedIn

        val days = JSONArray()
        for (i in 0..6) {
            val d = addDays(weekStart, i)
            val m = dayTotals[d] ?: HashMap()
            val totals = JSONObject()
            totals.put("all", m["all"] ?: 0)
            KINDS.forEach { totals.put(it, m[it] ?: 0) }
            days.put(
                JSONObject()
                    .put("date", d)
                    .put("weekday", weekdayOf(d))
                    .put("weekdayLabel", weekdayLabel(weekdayOf(d)))
                    .put("dayLabel", dayLabel(d))
                    .put("today", d == today)
                    .put("totals", totals)
            )
        }

        val selTotals = dayTotals[selected] ?: HashMap()
        val selDay = JSONObject()
            .put("date", selected)
            .put("weekday", weekdayOf(selected))
            .put("weekdayLabel", weekdayLabel(weekdayOf(selected)))
            .put("dayLabel", dayLabel(selected))
            .put("today", selected == today)
            .put(
                "totals",
                JSONObject().apply {
                    put("all", selTotals["all"] ?: 0)
                    KINDS.forEach { put(it, selTotals[it] ?: 0) }
                }
            )

        val dayItems = week.filter { it.date == selected }.sortedByDescending { it.at }
        val kindParam = when {
            kind.isNullOrBlank() -> "all"
            KINDS.contains(kind) -> kind
            else -> "all"
        }

        val categories = JSONArray()
        categories.put(JSONObject().put("key", "all").put("label", "全部").put("total", selTotals["all"] ?: 0))
        KINDS.forEach { k ->
            val n = selTotals[k] ?: 0
            if (n > 0) categories.put(JSONObject().put("key", k).put("label", label(k)).put("total", n))
        }

        val groups = JSONArray()
        if (kindParam == "all") {
            KINDS.forEach { k ->
                val list = dayItems.filter { it.kind == k }
                if (list.isEmpty()) return@forEach
                val cap = if (limit < 12) limit else 12
                groups.put(
                    JSONObject()
                        .put("key", k)
                        .put("label", label(k))
                        .put("total", list.size)
                        .put("items", cards(list.take(cap)))
                        .put("hasMore", list.size > cap)
                )
            }
        } else {
            val list = dayItems.filter { it.kind == kindParam }
            groups.put(
                JSONObject()
                    .put("key", kindParam)
                    .put("label", label(kindParam))
                    .put("total", list.size)
                    .put("items", cards(list.take(limit)))
                    .put("hasMore", list.size > limit)
            )
        }

        val root = JSONObject()
        root.put("object", "mflixtv.watch_calendar")
        root.put("title", "追剧日历")
        root.put("weekStart", weekStart)
        root.put("weekEnd", weekEnd)
        root.put("weekLabel", weekRangeLabel(weekStart))
        root.put("today", today)
        root.put("days", days)
        root.put("selected", selDay)
        root.put("categories", categories)
        root.put("groups", groups)
        root.put("watchOnly", watchOnly)
        root.put("watchCount", watchSet.size)
        root.put("weekTotal", week.size)
        root.put("notice", "按各采集源最近更新记录统计（同一天同一部只算一条），源站排播会变，实际更新可能延迟。")
        root.put("ts", System.currentTimeMillis())
        return root.toString()
    }

    private fun cards(list: List<Card>): JSONArray {
        val arr = JSONArray()
        list.forEach { c ->
            arr.put(
                JSONObject()
                    .put("name", c.name)
                    .put("pic", c.pic)
                    .put("remarks", c.remarks)
                    .put("year", c.year)
                    .put("area", c.area)
                    .put("typeName", c.typeName)
                    .put("kind", c.kind)
                    .put("date", c.date)
                    .put("at", c.at)
                    .put("episode", episodeOf(c.remarks))
                    .put("src", c.sourceKey)
                    .put("srcName", c.sourceName)
                    .put("sourceUrl", c.sourceUrl)
                    .put("vodId", c.vodId)
            )
        }
        return arr
    }

    private fun weekRangeLabel(weekStart: String): String {
        val end = addDays(weekStart, 6)
        fun md(d: String) = d.substring(5, 7).trimStart('0') + "月" + d.substring(8, 10).trimStart('0') + "日"
        return md(weekStart) + " - " + md(end)
    }
}
