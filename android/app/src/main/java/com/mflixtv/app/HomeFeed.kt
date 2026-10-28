package com.mflixtv.app

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * 首页片单：不用搜索也能出内容。
 *
 * 五行**同时**开工（以前是串行，最坏要等 50 多秒），每行只打 2–4 个源；
 * 结果落盘缓存，第二次打开秒出，过 10 分钟才后台重建。
 */
object HomeFeed {

    private const val TTL_MS = 10 * 60 * 1000L

    @Volatile private var memCache: JSONObject? = null
    @Volatile private var memAt: Long = 0L
    @Volatile private var building: Thread? = null

    private fun cacheFile(ctx: Context) = File(ctx.filesDir, "home-cache.json")

    fun cached(ctx: Context): JSONObject? {
        memCache?.let { if (System.currentTimeMillis() - memAt < TTL_MS) return it }
        return try {
            val f = cacheFile(ctx)
            if (!f.exists()) return null
            val o = JSONObject(f.readText())
            if (System.currentTimeMillis() - o.optLong("ts") > TTL_MS) null else {
                memCache = o
                memAt = System.currentTimeMillis()
                o
            }
        } catch (_: Exception) {
            null
        }
    }

    fun home(ctx: Context, force: Boolean): String {
        if (!force) cached(ctx)?.let { return it.toString() }
        val body = build()
        memCache = body
        memAt = System.currentTimeMillis()
        try {
            cacheFile(ctx).writeText(body.toString())
        } catch (_: Exception) {
        }
        return body.toString()
    }

    /** 缓存过期时先给旧数据、后台重建（前端不用白等）。 */
    fun stale(ctx: Context): String? = try {
        val f = cacheFile(ctx)
        if (!f.exists()) null else JSONObject(f.readText()).toString()
    } catch (_: Exception) {
        null
    }

    fun refreshAsync(ctx: Context) {
        if (building?.isAlive == true) return
        building = Thread {
            try {
                home(ctx, true)
            } catch (_: Throwable) {
            }
        }.also { it.start() }
    }

    private fun build(): JSONObject {
        val rows = Sources.homeRows()
        val slots = ArrayList<Pair<String, String>>()
        val results = arrayOfNulls<JSONArray>(rows.size)

        // 五行并发：每行内部已经多源并发，这里再并行行与行，首屏时间取决于最慢的一行。
        val workers = rows.mapIndexed { i, row ->
            Thread {
                try {
                    results[i] = Sources.fetchRow(row)
                } catch (_: Throwable) {
                    results[i] = JSONArray()
                }
            }.also { it.start() }
        }
        workers.forEach { it.join(13000) }

        val out = ArrayList<JSONObject>()
        rows.forEachIndexed { i, row ->
            val arr = results[i] ?: return@forEachIndexed
            if (arr.length() == 0) return@forEachIndexed
            slots.add(row.key to row.title)
            out.add(
                JSONObject().apply {
                    put("key", row.key)
                    put("title", row.title)
                    put("items", arr)
                }
            )
        }

        return JSONObject().apply {
            put("rows", JSONArray(out))
            put("sources", Sources.ALL.size)
            put("ts", System.currentTimeMillis())
        }
    }
}
