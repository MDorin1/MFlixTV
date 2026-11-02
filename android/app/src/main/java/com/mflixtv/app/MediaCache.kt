package com.mflixtv.app

import java.util.LinkedHashMap

/**
 * 清单 / 分片的一小块缓存 + 单飞（同一地址同时只打一次上游）。
 *
 * 为什么要有：采集站的媒体清单能大到 500KB、里面三千多个分片，
 * hls.js 每次起播、轮询、拖动都会重新拉一遍；而「点播放」和「详情页预热」
 * 这两个请求又经常同时打同一个地址。这里把它们合成一次上游请求，
 * 让重复的那次直接吃缓存——起播头几秒的时间基本都省在这一步。
 *
 * 只放内存、有上限、有 TTL：刷不掉播放，也不会一直吃内存。
 */
object MediaCache {

    class Item(val bytes: ByteArray, val type: String, val exp: Long)

    /** 内存上限：电视盒子的内存本来就不宽裕，28MB 够放清单 + 十来个分片 */
    private const val MAX_BYTES = 28L * 1024 * 1024

    private var used = 0L
    private val map = object : LinkedHashMap<String, Item>(32, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Item>?): Boolean {
            val e = eldest?.value
            if (e != null) used -= e.bytes.size
            return used > MAX_BYTES
        }
    }
    private val lock = java.lang.Object()
    private val inflight = HashMap<String, Any>()

    fun peek(key: String): ByteArray? = synchronized(lock) {
        val e = map[key] ?: return null
        if (e.exp < System.currentTimeMillis()) {
            map.remove(key)
            used -= e.bytes.size
            return null
        }
        e.bytes
    }

    fun typeOf(key: String): String? = synchronized(lock) {
        val e = map[key] ?: return null
        if (e.exp < System.currentTimeMillis()) return null
        e.type
    }

    fun put(key: String, bytes: ByteArray, type: String, ttlMs: Long) {
        if (bytes.isEmpty() || ttlMs <= 0) return
        synchronized(lock) {
            map.remove(key)?.let { used -= it.bytes.size }
            map[key] = Item(bytes, type, System.currentTimeMillis() + ttlMs)
            used += bytes.size
        }
    }

    /**
     * 申请这个地址的「唯一上游请求权」。
     * 拿到返回 true，调用方负责 release；别人正在做就等它做完再返回 false，
     * 这时调用方回去查一次缓存即可（多半已经有结果了）。
     */
    fun claim(key: String, waitMs: Long = 8000): Boolean {
        while (true) {
            synchronized(lock) {
                if (!inflight.containsKey(key)) {
                    inflight[key] = Any()
                    return true
                }
                val gate = inflight[key]!!
                // 等持有者做完（它 release 时会 notifyAll）
                try {
                    lock.wait(waitMs)
                } catch (e: InterruptedException) {
                    Thread.currentThread().interrupt()
                }
                if (inflight[key] === gate) {
                    // 还没做完但等超时了：就当没有，让调用方自己去拉
                    return false
                }
            }
            return false
        }
    }

    fun release(key: String) {
        synchronized(lock) {
            inflight.remove(key)
            lock.notifyAll()
        }
    }
}
