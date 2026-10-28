package com.mflixtv.app

import org.json.JSONArray
import org.json.JSONObject

/**
 * 详情与分集。
 *
 * 采集站的 vod_play_url 是「名称$地址#名称$地址」，多播放组之间用 $$$ 分隔，
 * 组名在 vod_play_from 里（顺序一一对应）。这里把每个组都返回给前端，
 * 前端优先选 m3u8 组，其次 mp4 组，分享页（/share/）排在最后。
 */
object SourceDetail {

    /**
     * @param base    源接口地址（https://xxx/api.php/provide/vod）
     * @param vodId   片 id
     * @param srcKey  源 key（前端传的是 key；调用方负责把 key 换成 base，这里只用来回填名字）
     */
    fun detail(base: String, vodId: String, srcKey: String = ""): String {
        val out = JSONObject()
        out.put("groups", JSONArray())
        if (base.isBlank() || vodId.isBlank() || !base.startsWith("http")) {
            out.put("error", "missing params")
            return out.toString()
        }
        return try {
            val text = Sources.get(base + "?ac=detail&ids=" + Sources.enc(vodId), 9000)
            val list = JSONObject(text).optJSONArray("list")
            if (list == null || list.length() == 0) {
                out.put("error", "empty detail")
                return out.toString()
            }
            val v = list.getJSONObject(0)
            val src = Sources.byKey(srcKey) ?: Sources.byBase(base)
            out.put("name", v.optString("vod_name"))
            out.put("pic", v.optString("vod_pic"))
            out.put("remarks", v.optString("vod_remarks"))
            out.put("year", v.optString("vod_year"))
            out.put("area", v.optString("vod_area"))
            out.put("typeName", v.optString("vod_class").ifBlank { v.optString("type_name") })
            out.put("actor", v.optString("vod_actor"))
            out.put("director", v.optString("vod_director"))
            out.put("src", src?.key ?: srcKey)
            out.put("srcName", src?.name ?: "")
            out.put("sourceUrl", base)
            out.put("content", clean(v.optString("vod_content")))
            out.put("groups", parseGroups(v))
            out.toString()
        } catch (e: Exception) {
            out.put("error", e.message ?: "detail failed")
            out.toString()
        }
    }

    private fun clean(html: String): String = html
        .replace(Regex("(?i)<br\\s*/?>"), "\n")
        .replace(Regex("<[^>]+>"), "")
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace(Regex("\\n{3,}"), "\n\n")
        .trim()

    private fun parseGroups(v: JSONObject): JSONArray {
        val froms = v.optString("vod_play_from").split("$$$")
        val urls = v.optString("vod_play_url").split("$$$")
        val groups = ArrayList<Pair<Int, JSONObject>>()

        urls.forEachIndexed { gi, block ->
            if (block.isBlank()) return@forEachIndexed
            val eps = JSONArray()
            block.split("#").forEachIndexed { i, seg ->
                val parts = seg.split("$")
                val label = parts.getOrNull(0)?.trim().orEmpty()
                val url = parts.getOrNull(1)?.trim().orEmpty()
                if (url.startsWith("http")) {
                    eps.put(JSONObject().put("idx", i).put("label", label.ifBlank { "第" + (i + 1) + "集" }).put("url", url))
                }
            }
            if (eps.length() == 0) return@forEachIndexed
            val fromName = froms.getOrNull(gi)?.trim().orEmpty().ifBlank { "线路" + (gi + 1) }
            val g = JSONObject()
            g.put("name", fromName)
            g.put("episodes", eps)
            g.put("total", eps.length())
            groups.add(rankOf(fromName, eps) to g)
        }

        groups.sortBy { it.first }
        val arr = JSONArray()
        groups.forEach { arr.put(it.second) }
        return arr
    }

    /** 越小越优先：真 m3u8 > mp4 > 分享页/其它。 */
    private fun rankOf(fromName: String, eps: JSONArray): Int {
        val first = eps.optJSONObject(0)?.optString("url").orEmpty().lowercase()
        val f = fromName.lowercase()
        return when {
            first.contains("/share/") -> 30
            first.contains(".m3u8") || f.contains("m3u8") -> 0
            first.contains(".mp4") || f.contains("mp4") -> 10
            else -> 20
        }
    }
}
