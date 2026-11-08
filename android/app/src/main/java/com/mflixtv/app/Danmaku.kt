package com.mflixtv.app

import org.json.JSONArray
import org.json.JSONObject
import java.net.URLEncoder
import java.security.MessageDigest

/**
 * 公共弹幕库（B 站）对接 —— 安卓 TV 端。
 *
 * 桌面端那套逻辑的移植：官方番剧 / 影视季优先，用户投稿兜底，噪音标题重罚。
 * 为什么要自己签 WBI：搜索接口从 2023 年起要求 `w_rid`，直接拼 keyword 会返回 -403；
 * 算法是公开的（nav 拿两张图的名字，按固定表打乱取前 32 位当密钥，参数排序后 md5）。
 *
 * 所有请求走 Net：已带证书宽容、超时与可选代理（手机在墙内直连必挂，代理是唯一出路）。
 */
object Danmaku {

    private const val API = "https://api.bilibili.com"
    private const val REF = "https://www.bilibili.com/"
    private const val UA =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

    /** 一集最多收多少条：再多也画不完，还拖慢解析 */
    private const val MAX_ITEMS = 6000

    /** WBI 打乱表（B 站前端固定值） */
    private val MIXIN = intArrayOf(
        46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28,
        14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 49, 4, 51, 25, 0, 24, 17, 20, 21, 26, 34, 40, 1, 44, 6, 36,
        11, 52, 30, 55, 22, 54, 56, 57, 59, 60, 61, 62, 63
    )

    /** 明显的「不是正片」标题：盖上去比没有更糟 */
    private val NOISE = listOf(
        "解说", "预告", "混剪", "速看", "盘点", "合集", "剪辑", "花絮", "影评", "剧评",
        "reaction", "吐槽", "讲解", "全集解说", "一口气"
    )

    @Volatile private var imgKey = ""
    @Volatile private var subKey = ""
    @Volatile private var keyAt = 0L

    // ---------- 基础工具 ----------

    private fun md5(text: String): String {
        val d = MessageDigest.getInstance("MD5").digest(text.toByteArray(Charsets.UTF_8))
        val sb = StringBuilder(32)
        for (b in d) sb.append(String.format("%02x", b))
        return sb.toString()
    }

    private fun enc(v: String): String =
        URLEncoder.encode(v, "UTF-8").replace("+", "%20")

    private fun baseName(url: String): String {
        val clean = url.substringBefore('?')
        val file = clean.substringAfterLast('/')
        val dot = file.lastIndexOf('.')
        return if (dot > 0) file.substring(0, dot) else file
    }

    private fun ensureKeys(force: Boolean = false): Boolean {
        if (!force && imgKey.isNotEmpty() && System.currentTimeMillis() - keyAt < 30 * 60_000L) return true
        return try {
            val txt = Net.getText("$API/x/web-interface/nav", 7000, REF, UA)
            val img = JSONObject(txt).optJSONObject("data")?.optJSONObject("wbi_img")
            val a = baseName(img?.optString("img_url").orEmpty())
            val b = baseName(img?.optString("sub_url").orEmpty())
            if (a.isEmpty() || b.isEmpty()) false
            else {
                imgKey = a; subKey = b; keyAt = System.currentTimeMillis(); true
            }
        } catch (e: Throwable) {
            Net.log("danmaku keys: " + Net.shortErr(e))
            false
        }
    }

    private fun mixinKey(): String {
        val raw = imgKey + subKey
        val sb = StringBuilder(32)
        for (n in MIXIN) {
            if (n < raw.length && sb.length < 32) sb.append(raw[n])
        }
        return sb.toString()
    }

    private fun signed(params: Map<String, String>): String {
        val all = LinkedHashMap(params)
        all["wts"] = (System.currentTimeMillis() / 1000).toString()
        val query = all.keys.sorted().joinToString("&") { k ->
            enc(k) + "=" + enc(all[k].orEmpty().replace(Regex("[!'()*]"), ""))
        }
        return query + "&w_rid=" + md5(query + mixinKey())
    }

    private fun apiJson(pathAndQuery: String, timeoutMs: Int = 9000): JSONObject? = try {
        val o = JSONObject(Net.getText(API + pathAndQuery, timeoutMs, REF, UA))
        val code = o.optInt("code", -999)
        if (code != 0) Net.log("danmaku api code=$code " + pathAndQuery.take(50) + " msg=" + o.optString("message"))
        o
    } catch (e: Throwable) {
        Net.log("danmaku api: " + Net.shortErr(e))
        null
    }

    // ---------- 打分 ----------

    private fun norm(s: String): String {
        val sb = StringBuilder()
        for (c in s) {
            if (c.isLetterOrDigit()) sb.append(c.lowercaseChar())
        }
        return sb.toString()
    }

    private fun noisePenalty(title: String): Int {
        val low = title.lowercase()
        var p = 0
        for (w in NOISE) if (low.contains(w)) p -= 45
        return maxOf(p, -60)
    }

    /** 标题里出现「第 N 集 / 第 N 话 / N」这类集数标记 */
    private fun hasEpisode(title: String, ep: Int): Boolean {
        if (ep <= 0) return false
        val patterns = listOf(
            "第" + ep + "集", "第" + ep + "话", "第" + ep + "期", "第" + ep + "回",
            "第" + cnNum(ep) + "集", "第" + cnNum(ep) + "话", "EP" + ep, "ep" + ep, "E" + ep
        )
        return patterns.any { title.contains(it, ignoreCase = true) }
    }

    private fun cnNum(n: Int): String {
        val d = "零一二三四五六七八九"
        if (n <= 10) return if (n == 10) "十" else d[n].toString()
        if (n < 20) return "十" + d[n - 10]
        if (n < 100) {
            val t = n / 10; val r = n % 10
            return d[t].toString() + "十" + (if (r == 0) "" else d[r].toString())
        }
        return n.toString()
    }

    private fun overlap(a: String, b: String): Boolean {
        if (a.isEmpty() || b.isEmpty()) return false
        if (a.contains(b)) return true
        if (b.contains(a) && b.length - a.length <= 6) return true
        return false
    }

    /** 用户投稿候选的分数 */
    private fun scoreVideo(want: String, title: String, ep: Int, durationSec: Int, clipSec: Int, dmCount: Int): Int {
        val w = norm(want)
        val t = norm(title)
        if (w.isEmpty() || t.isEmpty()) return 0
        var s = 0
        if (t.contains(w)) {
            s += 40
            val extra = t.length - w.length
            if (extra > 12) s -= 12
        } else {
            // 双向部分重合：取较长的公共前缀当粗略相似度
            var common = 0
            for (i in 0 until minOf(w.length, t.length)) {
                if (w[i] == t[i]) common++ else break
            }
            if (common >= 3) s += common * 4 else return 0
        }
        if (hasEpisode(title, ep)) s += 28
        else if (ep > 0) s -= 14
        if (dmCount <= 0) return 0           // 没弹幕的转载，挑它等于没弹幕
        s += when {
            dmCount > 500 -> 12
            dmCount > 100 -> 8
            dmCount > 20 -> 4
            else -> 0
        }
        if (durationSec > 0 && clipSec > 0) {
            val diff = Math.abs(durationSec - clipSec)
            if (diff < 180) s += 8
            else if (diff > 1800) s -= 8
        }
        s += noisePenalty(title)
        return s
    }

    private fun scoreSeason(want: String, title: String, ep: Int, epTotal: Int): Int {
        val w = norm(want)
        val t = norm(title)
        if (w.isEmpty() || t.isEmpty()) return 0
        var s = 0
        if (t.contains(w)) {
            s += 45
            val extra = t.length - w.length
            if (extra > 12) s -= 15
        } else {
            var common = 0
            for (i in 0 until minOf(w.length, t.length)) {
                if (w[i] == t[i]) common++ else break
            }
            if (common >= 3) s += common * 5 else return 0
        }
        if (ep > 0) {
            if (epTotal > 0 && ep > epTotal) s -= 25   // 集数超出这一季的集数，肯定不是它
            else s += 10
        }
        s += noisePenalty(title)
        return s
    }

    // ---------- 取数 ----------

    private data class Pick(val cid: Long, val label: String, val count: Int)

    private fun tryPgc(want: String, ep: Int): Pick? {
        val q = signed(mapOf("search_type" to "media_bangumi", "keyword" to want, "page" to "1"))
        val body = apiJson("/x/web-interface/wbi/search/type?$q")
        if (body == null) {
            Net.log("pgc body null")
            return null
        }
        val results = body.optJSONObject("data")?.optJSONArray("result")
        if (results == null) {
            Net.log("pgc no result for [" + want + "]")
            return null
        }
        var best = -1
        var bestSeason = ""
        var bestTitle = ""
        for (i in 0 until results.length()) {
            val o = results.optJSONObject(i) ?: continue
            val title = (o.optString("title") + " " + o.optString("org_title"))
                .replace(Regex("<[^>]+>"), " ").trim()
            val seasonId = o.optString("season_id")
            val epTotal = o.optInt("ep_size")
            if (seasonId.isEmpty()) continue
            val sc = scoreSeason(want, title, ep, epTotal)
            if (sc > best) { best = sc; bestSeason = seasonId; bestTitle = title }
        }
        if (best < 45 || bestSeason.isEmpty()) {
            Net.log("danmaku pgc: n=" + results.length() + " best=" + best + " t=[" + bestTitle.take(40) + "]")
            return null
        }

        val season = apiJson("/pgc/view/web/season?season_id=$bestSeason")
        if (season == null) {
            Net.log("pgc season null id=$bestSeason")
            return null
        }
        // 注意：/pgc/view/web/season 把数据放在 result，不是 data（和 search 接口不一样）
        val data = season.optJSONObject("data") ?: season.optJSONObject("result")
        if (data == null) {
            Net.log("pgc season no data: " + season.toString().take(120))
            return null
        }
        val eps = data.optJSONArray("episodes")
        if (eps == null || eps.length() == 0) {
            Net.log("pgc season no episodes keys=" + data.keys().asSequence().joinToString(",").take(200))
            return null
        }
        Net.log("pgc hit best=$best eps=" + eps.length() + " t=[" + bestTitle.take(30) + "]")
        val idx = if (ep > 0) ep - 1 else 0
        val e = eps.optJSONObject(if (idx < eps.length()) idx else eps.length() - 1)
        if (e == null) {
            Net.log("pgc ep node null idx=$idx")
            return null
        }
        val cid = e.optLong("cid", 0)
        if (cid <= 0L) {
            Net.log("pgc cid 0 keys=" + e.keys().asSequence().joinToString(",").take(160))
            return null
        }
        val label = e.optString("title").ifEmpty { "第" + (idx + 1) + "集" }
        return Pick(cid, bestTitle + " · " + label, -1)
    }

    private fun tryVideo(want: String, ep: Int, clipSec: Int): Pick? {
        val keywords = if (ep > 0) listOf(want, want + " 第" + ep + "集", want + " 第" + cnNum(ep) + "集")
        else listOf(want)
        var best = -1
        var bestBvid = ""
        var bestTitle = ""
        for (kw in keywords) {
            val q = signed(mapOf("search_type" to "video", "keyword" to kw, "page" to "1"))
            val body = apiJson("/x/web-interface/wbi/search/type?$q") ?: continue
            val results = body.optJSONObject("data")?.optJSONArray("result") ?: continue
            for (i in 0 until results.length()) {
                val o = results.optJSONObject(i) ?: continue
                val bvid = o.optString("bvid")
                if (bvid.isEmpty()) continue
                val title = o.optString("title").replace(Regex("<[^>]+>"), " ").trim()
                val dm = o.optInt("video_review", 0)
                val dur = parseDuration(o.optString("duration"))
                val sc = scoreVideo(want, title, ep, dur, clipSec, dm)
                if (sc > best) { best = sc; bestBvid = bvid; bestTitle = title }
            }
            if (best >= 55) break
        }
        val threshold = if (ep > 0) 55 else 35
        if (best < threshold || bestBvid.isEmpty()) {
            Net.log("danmaku video: best=" + best + " need=" + threshold + " t=[" + bestTitle.take(40) + "]")
            return null
        }

        val pages = apiJson("/x/player/pagelist?bvid=$bestBvid") ?: return null
        val list = pages.optJSONArray("data") ?: return null
        if (list.length() == 0) return null
        // 分P：集数对得上就用那一 P，否则用第一 P
        var part = 0
        if (ep > 0) {
            for (i in 0 until list.length()) {
                val p = list.optJSONObject(i) ?: continue
                if (hasEpisode(p.optString("part"), ep)) { part = i; break }
            }
        }
        val p = list.optJSONObject(part) ?: return null
        val cid = p.optLong("cid", 0)
        if (cid <= 0L) return null
        val partName = p.optString("part")
        return Pick(cid, bestTitle + (if (partName.isEmpty()) "" else " · " + partName), -1)
    }

    private fun decodeEntity(s: String): String = s
        .replace("&lt;", "<").replace("&gt;", ">")
        .replace("&quot;", "\"").replace("&#39;", "'")
        .replace("&apos;", "'").replace("&amp;", "&")

    private data class Raw(val t: Double, val mode: Int, val size: Double, val color: String, val text: String)

    private fun fetchXml(cid: Long): List<Raw> {
        val xml = Net.getText("https://comment.bilibili.com/$cid.xml", 9000, REF, UA)
        val re = Regex("<d p=\"([^\"]*)\">([^<]*)</d>")
        val out = ArrayList<Raw>()
        for (m in re.findAll(xml)) {
            val attrs = m.groupValues[1].split(',')
            if (attrs.size < 4) continue
            val t = attrs[0].toDoubleOrNull() ?: continue
            val mode = attrs[1].toIntOrNull() ?: 1
            if (mode != 1 && mode != 4 && mode != 5) continue
            val size = attrs[2].toDoubleOrNull() ?: 25.0
            val colorNum = attrs[3].toLongOrNull() ?: 0xFFFFFFL
            val text = decodeEntity(m.groupValues[2]).trim()
            if (text.isEmpty()) continue
            val color = String.format("#%06x", colorNum and 0xFFFFFFL)
            val sz = (size / 25.0).coerceIn(0.86, 1.6)
            out.add(Raw(t, mode, sz, color, text))
            if (out.size >= MAX_ITEMS) break
        }
        // 按时间升序：渲染侧好按游标推进
        out.sortBy { it.t }
        return out
    }

    /**
     * 取一集的弹幕。任何一步失败都返回 ok:false + 一句人话，不抛异常。
     * 返回结构与桌面端一致：`{ok, count, source, items:[[t, mode, size, color, text], ...]}`
     */
    fun fetch(title: String, episode: Int, clipSec: Int = 0): String {
        val want = title.trim()
        if (want.isEmpty()) return JSONObject().put("ok", false).put("msg", "没有片名，匹配不了弹幕").toString()
        if (!ensureKeys()) return JSONObject().put("ok", false).put("msg", "连不上弹幕库（检查网络或代理）").toString()

        val picks = ArrayList<Pick>()
        try {
            tryPgc(want, episode)?.let { picks.add(it) }
        } catch (e: Throwable) {
            Net.log("danmaku pgc: " + Net.shortErr(e))
        }
        try {
            tryVideo(want, episode, clipSec)?.let { picks.add(it) }
        } catch (e: Throwable) {
            Net.log("danmaku video: " + Net.shortErr(e))
        }
        if (picks.isEmpty()) {
            Net.log("danmaku: no pick for [$want] ep=$episode")
            return JSONObject().put("ok", false)
                .put("msg", "这一集在弹幕库里没有合适的来源").toString()
        }

        for (pick in picks) {
            try {
                val items = fetchXml(pick.cid)
                if (items.isEmpty()) continue
                val arr = JSONArray()
                for (it in items) {
                    arr.put(
                        JSONArray()
                            .put(Math.round(it.t * 1000.0) / 1000.0)
                            .put(it.mode)
                            .put(it.size)
                            .put(it.color)
                            .put(it.text)
                    )
                }
                return JSONObject().put("ok", true).put("count", arr.length())
                    .put("source", pick.label).put("items", arr).toString()
            } catch (e: Throwable) {
                Net.log("danmaku xml: " + Net.shortErr(e))
            }
        }
        return JSONObject().put("ok", false).put("msg", "来源找到了，但这一集的弹幕是空的").toString()
    }

    private fun parseDuration(text: String): Int {
        val parts = text.split(':').map { it.trim().toIntOrNull() ?: 0 }
        return when (parts.size) {
            3 -> parts[0] * 3600 + parts[1] * 60 + parts[2]
            2 -> parts[0] * 60 + parts[1]
            1 -> parts[0]
            else -> 0
        }
    }
}
