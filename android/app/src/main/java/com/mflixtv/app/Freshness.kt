package com.mflixtv.app

import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Locale

/**
 * 内容新鲜度（安卓端）。
 *
 * 这是 `app/src/lib/remarks.ts` + `app/src/lib/source-freshness.ts` 的 Kotlin 版，
 * 口径必须一字不差 —— 同一部片在电视上和电脑上显示的年份、最新一集、归档结论
 * 不能是两套数字。以前这套判定只写在 Next.js 里，安卓端（含电视）一条都没有，
 * 结果「2016起」「归档源」只在电脑上生效，电视上还是老样子。
 *
 * 两个字段性质不同，不能混：
 *  - `vod_remarks`（备注）是**内容日期**：`更新至20251020期`。上游真采到新一期才变，
 *    能拿它判「这条源还更不更新」。
 *  - `vod_time`（上架/更新时间）是**抓取时间**：旧内容被重抓一次就变成今天，
 *    拿它判归档等于把闸拆了。
 * 所以：有备注日期优先用备注，一条都没有才退回 `vod_time` 兜底，并用 `dateSource`
 * 标清楚；**归档判定只认 `remarks`**。
 */
object Freshness {

    /** 期号日期：`20251020` / `2025-10-20` / `2025.10.20` 三种写法都认 */
    private val EP_DATE = Regex("(20\\d{2})[-./]?(\\d{2})[-./]?(\\d{2})")
    /** 集数：`全34集` / `第34集` / `更新至12集` */
    private val EP_COUNT = Regex("(\\d+)\\s*集")
    private val FINISHED_WORD = Regex("完结|大结局|全集|剧终")
    private val FINISHED_PREFIX = Regex("(?:全|共)\\s*\\d+\\s*集")
    private val FINISHED_SUFFIX = Regex("\\d+\\s*集\\s*全")

    /** 归档门槛（天）：最新一期比这还旧，说明上游早不采了，只是接口还活着 */
    const val ARCHIVE_DAYS = 90

    /** 日期来自哪个字段：`remarks`（内容日期）/ `vod_time`（上架时间） */
    data class Latest(val date: String, val source: String) {
        val fromRemarks: Boolean get() = source == "remarks"
    }

    /**
     * 从备注里取出「最新一期」的播出日期，`YYYY-MM-DD`。
     * 只认能落到合法日历的日期：纯年份（`2026`）、集数（`第12集`）都不算；
     * 文中多个日期取最晚的，兼容 `20240101-20251020` 这种区间写法。
     */
    fun latestEpisodeDate(raw: String?): String? {
        val text = raw?.trim().orEmpty()
        if (text.isEmpty()) return null
        var best: String? = null
        for (m in EP_DATE.findAll(text)) {
            val y = m.groupValues[1]
            val mo = m.groupValues[2]
            val d = m.groupValues[3]
            val mi = mo.toIntOrNull() ?: continue
            val di = d.toIntOrNull() ?: continue
            if (mi < 1 || mi > 12 || di < 1 || di > 31) continue
            if (parseIso("$y-$mo-$d") == null) continue
            val iso = "$y-$mo-$d"
            val cur = best
            if (cur == null || iso > cur) best = iso
        }
        return best
    }

    private fun isFinished(text: String): Boolean =
        FINISHED_WORD.containsMatchIn(text) || FINISHED_PREFIX.containsMatchIn(text) ||
            FINISHED_SUFFIX.containsMatchIn(text)

    /** 备注归一：`全N集` / `更新至N集` / `更新至 YYYY-MM-DD` / `已完结`，非集数备注原样返回 */
    fun formatRemarks(raw: String?): String? {
        val text = raw?.trim().orEmpty()
        if (text.isEmpty()) return null
        val finished = isFinished(text)
        val count = EP_COUNT.find(text)?.groupValues?.get(1)?.toIntOrNull() ?: 0
        if (count > 0) return if (finished) "全${count}集" else "更新至${count}集"
        val date = latestEpisodeDate(text)
        if (date != null) return "更新至 $date"
        if (finished) return "已完结"
        return text
    }

    /**
     * 排序用的「新旧年份」。
     * 连载综艺 / 新闻的 `vod_year` 是首播年（「小明星大跟班」永远 2016），
     * 只按它排会把今天还在更新的节目压到十年前那一档，所以最新一期跨年时以它为准。
     */
    fun recencyYear(year: String?, latest: String?): Int {
        val latestYear = latest?.take(4)?.toIntOrNull() ?: 0
        val base = year?.trim()?.take(4)?.toIntOrNull() ?: 0
        if (latestYear > 0) return if (base > latestYear) base else latestYear
        return base
    }

    /** 卡片上那个年份：连载跨年的写「2016起」，其余原样 */
    fun yearLabel(year: String?, latest: String?): String {
        val base = year?.trim()?.take(4)?.toIntOrNull() ?: 0
        val latestYear = latest?.take(4)?.toIntOrNull() ?: 0
        if (base > 0 && latestYear > base) return "${base}起"
        return year?.trim().orEmpty()
    }

    /**
     * 归一化标题/关键词：只留字母与数字（去掉空白、标点、符号），转小写。
     * 和电脑端 `cms-parser.ts` 的 `normalizeTitle` 同一口径，
     * 用于跨标点差异匹配（源站存「摔跤吧!爸爸」而用户搜「摔跤吧！爸爸」）。
     */
    fun normalizeTitle(s: String?): String =
        (s ?: "").lowercase().filter { it.isLetterOrDigit() }

    /**
     * 搜索结果的「标题精确度」分级，越小越靠前（口径同电脑端 `/api/search`）：
     * 0 归一后完全相等 / 1 前缀匹配 / 2 包含匹配 / 3 其他。
     *
     * 老片「小明星大跟班」（vod_year=2016）靠这一档才不会被一堆无关新片压到后面
     * —— 以前只按年份倒序，精确命中也排在 2024/2025 的模糊结果之后。
     */
    fun titleRank(name: String?, wd: String): Int {
        val n = normalizeTitle(name)
        val w = normalizeTitle(wd)
        if (n.isEmpty() || w.isEmpty()) return 3
        return when {
            n == w -> 0
            n.startsWith(w) -> 1
            n.contains(w) -> 2
            else -> 3
        }
    }

    /** 一条源「最新内容日期」：备注里的最晚日期优先，一条都没有才退回上架时间 */
    fun latestInRaw(arr: JSONArray?): Latest? {
        if (arr == null) return null
        var bestRemarks = ""
        var bestUpload = ""
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            val r = latestEpisodeDate(o.optString("vod_remarks"))
            if (r != null && r > bestRemarks) bestRemarks = r
            val u = latestEpisodeDate(o.optString("vod_time"))
            if (u != null && u > bestUpload) bestUpload = u
        }
        if (bestRemarks.isNotEmpty()) return Latest(bestRemarks, "remarks")
        if (bestUpload.isNotEmpty()) return Latest(bestUpload, "vod_time")
        return null
    }

    /** 距今天数（本地日历口径，跨时区差一天不影响判档） */
    fun ageDays(iso: String, now: Long = System.currentTimeMillis()): Int? {
        val t = parseIso(iso) ?: return null
        val days = (now - t) / 86400000L
        return if (days < 0) 0 else days.toInt()
    }

    /** 归档判定：只有内容日期（备注）能判死一条源 */
    fun isArchived(latest: Latest?, now: Long = System.currentTimeMillis()): Boolean {
        if (latest == null || !latest.fromRemarks) return false
        val days = ageDays(latest.date, now) ?: return false
        return days > ARCHIVE_DAYS
    }

    /**
     * 体检页那一格 / 详情页那一行的文案：
     * 内容日期写「最新一集 2025-10-20 · 源 12 个月前更新」，上架时间写「上架时间 …」。
     */
    fun freshnessLabel(latest: Latest?, now: Long = System.currentTimeMillis()): String {
        if (latest == null) return ""
        if (!latest.fromRemarks) return "上架时间 " + latest.date
        val days = ageDays(latest.date, now) ?: 0
        val months = days / 30
        return "最新一集 " + latest.date + if (months >= 1) " · 源 $months 个月前更新" else ""
    }

    /** 详情页那一行：备注里有内容日期才给，没有就不显示（别拿上架时间冒充） */
    fun episodeLine(raw: String?, now: Long = System.currentTimeMillis()): String {
        val date = latestEpisodeDate(raw) ?: return ""
        return freshnessLabel(Latest(date, "remarks"), now)
    }

    private fun parseIso(iso: String): Long? = try {
        val f = SimpleDateFormat("yyyy-MM-dd", Locale.US)
        f.isLenient = false
        f.parse(iso)?.time
    } catch (_: Exception) {
        null
    }
}
