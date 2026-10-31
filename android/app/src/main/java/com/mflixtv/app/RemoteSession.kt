package com.mflixtv.app

import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap

/**
 * 「扫一扫当遥控器」的会话总线（会话级，和 Remote.kt 的机器级队列互补）。
 *
 * Remote.kt 是「一整台设备一条队列」：手机遥控的是电视这台机器。
 * 这里是**每一个打开网页的标签页/WebView 各自领一个 token**：
 * 二维码里带的就是这个 token，扫它的设备只会控制那一个页面，互不串台。
 *
 * 例：安卓手机开着 MFlixTV 在放片 → 右上角点遥控 → 出码
 *    → 另一台手机扫码打开 /rc?t=XXXXXX → 它的按键只作用于发起那个页面。
 *
 * 只在内存里：进程一停全部失效，不落盘、不外发。
 */
object RemoteSession {
    private val LOCK_TAG = "mfl-rs"
    private const val MAX_CMDS = 48
    private const val HOST_ALIVE_MS = 45_000L
    private const val CTL_ALIVE_MS = 20_000L
    private const val TTL_MS = 30 * 60 * 1000L

    // 去掉容易看错的 0/O/1/I/L，扫码后手抄也不会错
    private const val ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"

    private class Session(val token: String, val name: String) {
        val created = System.currentTimeMillis()
        @Volatile var hostBeat = System.currentTimeMillis()
        var seq = 0L
        val cmds = ArrayDeque<JSONObject>()
        val ctls = ConcurrentHashMap<String, Long>()
        @Volatile var title = ""
        @Volatile var sub = ""
        @Volatile var playing = false
        @Volatile var pos = 0
        @Volatile var dur = 0
        @Volatile var page = ""
    }

    private val sessions = ConcurrentHashMap<String, Session>()

    private fun newToken(): String {
        val rnd = java.security.SecureRandom()
        repeat(40) {
            val sb = StringBuilder()
            repeat(6) { sb.append(ALPHABET[rnd.nextInt(ALPHABET.length)]) }
            val t = sb.toString()
            if (!sessions.containsKey(t)) return t
        }
        return (System.currentTimeMillis().toString(36).takeLast(6)).uppercase()
    }

    private fun sweep() {
        val now = System.currentTimeMillis()
        val dead = sessions.entries.filter { now - it.value.created > TTL_MS }.map { it.key }
        dead.forEach { sessions.remove(it) }
    }

    fun create(name: String): JSONObject {
        sweep()
        val token = newToken()
        val s = Session(token, name.take(40).ifBlank { "未命名设备" })
        sessions[token] = s
        return JSONObject().put("token", token).put("name", s.name)
    }

    private fun get(token: String): Session? {
        val s = sessions[token] ?: return null
        if (System.currentTimeMillis() - s.created > TTL_MS) {
            sessions.remove(token)
            return null
        }
        return s
    }

    fun drop(token: String) {
        sessions.remove(token)
    }

    /** 被控端每秒来一次，顺带取走新指令 */
    fun hostPoll(token: String, since: Long): String? {
        val s = get(token) ?: return null
        s.hostBeat = System.currentTimeMillis()
        val out = JSONArray()
        synchronized(LOCK_TAG) {
            for (c in s.cmds) if (c.optLong("id") > since) out.put(c)
            if (since > 0) {
                val keep = s.cmds.filter { it.optLong("id") > since - 24 }
                s.cmds.clear()
                s.cmds.addAll(keep)
            }
        }
        return JSONObject()
            .put("now", s.seq)
            .put("cmds", out)
            .put("ctls", liveCtls(s))
            .put("name", s.name)
            .put("state", stateOf(s))
            .toString()
    }

    fun push(token: String, cmd: String, arg: String): Long? {
        val s = get(token) ?: return null
        val id = synchronized(LOCK_TAG) {
            val n = ++s.seq
            s.cmds.addLast(
                JSONObject()
                    .put("id", n)
                    .put("cmd", cmd.take(24))
                    .put("arg", arg.take(200))
                    .put("ts", System.currentTimeMillis())
            )
            while (s.cmds.size > MAX_CMDS) s.cmds.removeFirst()
            n
        }
        return id
    }

    fun setState(token: String, body: JSONObject): Boolean {
        val s = get(token) ?: return false
        if (body.has("title")) s.title = body.optString("title").take(120)
        if (body.has("sub")) s.sub = body.optString("sub").take(60)
        if (body.has("playing")) s.playing = body.optBoolean("playing")
        if (body.has("pos")) s.pos = body.optInt("pos")
        if (body.has("dur")) s.dur = body.optInt("dur")
        if (body.has("page")) s.page = body.optString("page").take(200)
        return true
    }

    /** 遥控器每 1.2 秒来一次：拿被控端状态 + 报活 */
    fun ctlPoll(token: String, who: String): String? {
        val s = get(token) ?: return null
        val now = System.currentTimeMillis()
        s.ctls[who.ifBlank { "x" }.take(16)] = now
        val dead = s.ctls.entries.filter { now - it.value > CTL_ALIVE_MS }.map { it.key }
        dead.forEach { s.ctls.remove(it) }
        return JSONObject()
            .put("ok", true)
            .put("name", s.name)
            .put("state", stateOf(s))
            .put("hostAlive", now - s.hostBeat < HOST_ALIVE_MS)
            .put("ctls", liveCtls(s))
            .put("cmds", s.seq)
            .toString()
    }

    fun info(token: String): String? {
        val s = get(token) ?: return null
        return JSONObject()
            .put("name", s.name)
            .put("state", stateOf(s))
            .put("hostAlive", System.currentTimeMillis() - s.hostBeat < HOST_ALIVE_MS)
            .put("ctls", liveCtls(s))
            .toString()
    }

    private fun stateOf(s: Session): JSONObject = JSONObject()
        .put("title", s.title)
        .put("sub", s.sub)
        .put("playing", s.playing)
        .put("pos", s.pos)
        .put("dur", s.dur)
        .put("page", s.page)

    private fun liveCtls(s: Session): Int {
        val now = System.currentTimeMillis()
        return s.ctls.values.count { now - it < CTL_ALIVE_MS }
    }
}
