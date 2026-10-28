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
 *
 * 全失败时不把旧缓存覆盖成空：有旧数据就返回旧数据（标 stale），
 * 一条都没有就返回每个源的真实错误，让界面能说清「为什么打不开」。
 */
object HomeFeed {

    private const val TTL_MS = 10 * 60 * 1000L

    @Volatile private var memCache: JSONObject? = null
    @Volatile private var memAt: Long = 0L
    @Volatile private var building: Thread? = null

    private fun cacheFile(ctx: Context) = File(ctx.filesDir, "home-cache.json")

    private fun rawCache(ctx: Context): JSONObject? = try {
        val f = cacheFile(ctx)
        if (!f.exists()) null else JSONObject(f.readText())
    } catch (_: Exception) {
        null
    }

    fun cached(ctx: Context): JSONObject? {
        memCache?.let { if (System.currentTimeMillis() - memAt < TTL_MS) return it }
        val o = rawCache(ctx) ?: return null
        if (System.currentTimeMillis() - o.optLong("ts") > TTL_MS) return null
        memCache = o
        memAt = System.currentTimeMillis()
        return o
    }

    fun home(ctx: Context, force: Boolean): String {
        if (!force) cached(ctx)?.let { return it.toString() }
        val body = build(ctx)
        if (body.optJSONArray("rows")?.length() ?: 0 > 0) {
            memCache = body
            memAt = System.currentTimeMillis()
            try {
                cacheFile(ctx).writeText(body.toString())
            } catch (_: Exception) {
            }
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

    private fun build(ctx: Context): JSONObject {
        val rows = Sources.homeRows()
        val results = arrayOfNulls<JSONArray>(rows.size)

        // 五行并发：每行内部已经多源并发，这里再并行行与行，首屏时间取决于最慢的一行。
        val workers = rows.mapIndexed { i, row ->
            Thread {
                results[i] = try {
                    Sources.fetchRow(row)
                } catch (_: Throwable) {
                    JSONArray()
                }
            }.also { it.start() }
        }
        workers.forEach { it.join(10000) }

        val out = ArrayList<JSONObject>()
        rows.forEachIndexed { i, row ->
            val arr = results[i] ?: return@forEachIndexed
            if (arr.length() == 0) return@forEachIndexed
            out.add(
                JSONObject().apply {
                    put("key", row.key)
                    put("title", row.title)
                    put("items", arr)
                }
            )
        }

        val root = JSONObject().apply {
            put("rows", JSONArray(out))
            put("sources", Sources.ALL.size)
            put("pool", Sources.usableSources().size)
            put("proxy", Net.proxyString())
            put("ts", System.currentTimeMillis())
        }

        if (out.isEmpty()) {
            // 一个行都没拿到：先给旧缓存兜底，同时把每个源的真实错误带回去
            rawCache(ctx)?.let {
                val old = JSONObject(it.toString())
                if ((old.optJSONArray("rows")?.length() ?: 0) > 0) {
                    old.put("stale", true)
                    old.put("error", "all_sources_failed")
                    return old
                }
            }
            root.put("error", "all_sources_failed")
            try {
                root.put("diag", JSONObject(Sources.probeJson(false)))
            } catch (_: Throwable) {
            }
        }
        return root
    }
}
