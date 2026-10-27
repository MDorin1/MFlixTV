package com.mflixtv.app

import fi.iki.elonen.NanoHTTPD
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

/** 点播源搜索：并发查各源 ?ac=videolist&wd=，合并成一份列表。 */
object SourceSearch {
    // 与桌面版内置源一致（后续可在设置里改）
    private val SOURCES = listOf(
        "env_0" to ("豪华资源" to "https://hhzyapi.com/api.php/provide/vod"),
        "env_1" to ("暴风资源" to "https://bfzyapi.com/api.php/provide/vod"),
        "env_2" to ("魔都资源" to "https://caiji.moduapi.cc/api.php/provide/vod")
    )

    fun search(wd: String): String {
        val results = java.util.Collections.synchronizedList(ArrayList<JSONObject>())
        val threads = SOURCES.map { (key, cfg) ->
            thread {
                try {
                    val url = URL(cfg.second + "?ac=videolist&wd=" + java.net.URLEncoder.encode(wd, "UTF-8"))
                    val conn = url.openConnection() as HttpURLConnection
                    conn.connectTimeout = 8000
                    conn.readTimeout = 8000
                    conn.setRequestProperty("User-Agent", "Mozilla/5.0")
                    val text = conn.inputStream.bufferedReader().readText()
                    val arr = JSONObject(text).optJSONArray("list") ?: return@thread
                    for (i in 0 until arr.length()) {
                        val o = arr.optJSONObject(i) ?: continue
                        results.add(JSONObject().apply {
                            put("sourceKey", key)
                            put("sourceName", cfg.first)
                            put("vodId", o.optString("vod_id"))
                            put("name", o.optString("vod_name"))
                            put("pic", o.optString("vod_pic"))
                            put("year", o.optString("vod_year"))
                            put("remarks", o.optString("vod_remarks"))
                            put("sourceUrl", cfg.second)
                        })
                    }
                } catch (_: Exception) {
                }
            }
        }
        threads.forEach { it.join(9000) }
        val out = JSONObject()
        val arr = org.json.JSONArray()
        results.forEach { arr.put(it) }
        out.put("list", arr)
        return out.toString()
    }
}
