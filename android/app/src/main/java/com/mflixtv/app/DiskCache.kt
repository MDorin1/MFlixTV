package com.mflixtv.app

import android.content.Context
import java.io.File
import java.security.MessageDigest

/**
 * 封面图的磁盘缓存。
 *
 * 内存缓存只能管住「这一次打开 App」：电视重启、切后台久了被回收，缓存全没，
 * 于是每次冷启动都要重新去采集站的图床拉二十多张图（实测一张 8~14 秒，首页就是白一块）。
 * 图片内容基本不会变，落到磁盘上，第二次开机就是本地读。
 *
 * 只做图片：清单会变（直播清单几秒一版），分片太大又不划算。
 * 上限 300MB，按最后访问时间淘汰最老的。
 */
object DiskCache {

    private const val MAX_BYTES = 300L * 1024 * 1024
    private var dir: File? = null
    private var usedBytes = 0L
    private var ready = false

    @Synchronized
    fun init(ctx: Context) {
        if (ready) return
        val d = File(ctx.cacheDir, "imgcache")
        if (!d.exists()) d.mkdirs()
        dir = d
        ready = true
        // 开机先量一遍占用、顺手清到上限以内（上次可能是被强杀，没来得及清）
        Thread {
            try {
                val files = d.listFiles() ?: return@Thread
                usedBytes = files.sumOf { it.length() }
                trimLocked()
            } catch (_: Throwable) {
            }
        }.start()
    }

    private fun name(url: String): String {
        val md = MessageDigest.getInstance("SHA-1")
        val h = md.digest(url.toByteArray(Charsets.UTF_8))
        val sb = StringBuilder()
        for (b in h) sb.append(String.format("%02x", b))
        return sb.toString()
    }

    /** 命中返回 (字节, 类型)；没有就 null */
    @Synchronized
    fun get(url: String): Pair<ByteArray, String>? {
        val d = dir ?: return null
        val f = File(d, name(url))
        if (!f.exists()) return null
        return try {
            // 以前是 readBytes() 读整个文件，再 copyOfRange 复制一份正文：
            // 一张 2MB 的封面会瞬时吃掉 4MB，首页二十张并发就是 80MB 的垃圾，
            // 全喂给 GC。改成「先读头拿到类型，再按长度精确申请一次正文」。
            java.io.RandomAccessFile(f, "r").use { raf ->
                val len = raf.length()
                if (len < 2) return null
                val head = ByteArray(minOf(64L, len).toInt())
                raf.readFully(head)
                val nl = head.indexOf('\n'.code.toByte())
                if (nl <= 0 || nl > 64) return null
                val type = String(head, 0, nl, Charsets.UTF_8)
                val bodyLen = (len - nl - 1L).toInt()
                if (bodyLen <= 0) return null
                val body = ByteArray(bodyLen)
                raf.seek(nl + 1L)
                raf.readFully(body)
                // 触碰一下 mtime，让「最近看过的」排在后面不被淘汰
                f.setLastModified(System.currentTimeMillis())
                body to type
            }
        } catch (_: Throwable) {
            null
        }
    }

    @Synchronized
    fun put(url: String, bytes: ByteArray, type: String) {
        val d = dir ?: return
        if (bytes.isEmpty() || bytes.size > 2 * 1024 * 1024) return
        try {
            val f = File(d, name(url))
            val had = if (f.exists()) f.length() else 0L
            f.outputStream().use { out ->
                out.write((type + "\n").toByteArray(Charsets.UTF_8))
                out.write(bytes)
            }
            usedBytes += f.length() - had
            if (usedBytes > MAX_BYTES) trimLocked()
        } catch (_: Throwable) {
        }
    }

    /** 调试用：当前占用（文件数, 字节数） */
    @Synchronized
    fun stats(): Pair<Int, Long> {
        val d = dir ?: return 0 to 0L
        val n = d.listFiles()?.size ?: 0
        return n to usedBytes
    }

    /** 按 mtime 从老到新删，直到回到上限的 80% */
    private fun trimLocked() {
        val d = dir ?: return
        if (usedBytes <= MAX_BYTES) return
        val target = (MAX_BYTES * 8) / 10
        val files = d.listFiles()?.sortedBy { it.lastModified() } ?: return
        for (f in files) {
            if (usedBytes <= target) break
            val len = f.length()
            if (f.delete()) usedBytes -= len
        }
    }
}
