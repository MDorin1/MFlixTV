package com.mflixtv.app

import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong

/**
 * 手机遥控：一个只在局域网内走的小指令队列。
 *
 * 场景：手机打开「电视那台设备」的网页版（同一网络），点「遥控这台电视」，
 * 之后手机上的方向键 / 搜索框 / 播放键都变成指令推到这里；
 * 电视上的 tv.html 每 0.8 秒来 poll 一次，取到就执行——不经过任何外网服务。
 *
 * 设计上的几个取舍：
 *  - 队列只在内存里，进程一停就清空（遥控本来就只管当下，不需要持久化）；
 *  - 只保留最近 64 条，poll 时把已确认的旧条目顺手丢掉，长挂机不会越攒越多；
 *  - since 是自增 id，客户端记住上次的 id 就不会重复执行同一条；
 *  - to 用来区分目标（tv / pc / any），手机开着电视网页时不会被自己的指令带跑。
 */
object Remote {
    private val seq = AtomicLong(0)
    private val queue = ArrayDeque<JSONObject>()
    private val beats = ConcurrentHashMap<String, Long>()
    private const val LOCK_TAG = "mfl-remote"
    private const val MAX = 64
    private const val ALIVE_MS = 15_000L

    fun push(cmd: String, arg: String, to: String, from: String): Long {
        val id = seq.incrementAndGet()
        val o = JSONObject()
            .put("id", id)
            .put("cmd", cmd.take(24))
            .put("arg", arg.take(200))
            .put("to", if (to.isBlank()) "any" else to.take(8))
            .put("from", from.take(24))
            .put("ts", System.currentTimeMillis())
        synchronized(LOCK_TAG) {
            queue.addLast(o)
            while (queue.size > MAX) queue.removeFirst()
        }
        beat("app", from)
        return id
    }

    /** 取比 since 新的指令；顺手把这一端的心跳记上，面板里就能显示「有几台设备连着」。 */
    fun poll(since: Long, role: String, who: String): String {
        val out = JSONArray()
        val now = seq.get()
        synchronized(LOCK_TAG) {
            val keep = ArrayDeque<JSONObject>()
            for (o in queue) {
                val id = o.optLong("id")
                val to = o.optString("to", "any")
                if (id > since && (to == "any" || to == role)) out.put(o)
                if (id > since - 32) keep.addLast(o)
            }
            queue.clear()
            queue.addAll(keep)
        }
        beat(role, who)
        return JSONObject().put("now", now).put("cmds", out).put("devices", active()).toString()
    }

    fun beat(role: String, who: String) {
        beats[role + "|" + who.ifBlank { "-" }] = System.currentTimeMillis()
    }

    /** 最近 15 秒内有过来 poll / push 的设备数。 */
    fun active(): Int {
        val now = System.currentTimeMillis()
        val dead = ArrayList<String>()
        var n = 0
        for ((k, v) in beats) {
            if (now - v < ALIVE_MS) n++ else dead.add(k)
        }
        dead.forEach { beats.remove(it) }
        return n
    }
}
