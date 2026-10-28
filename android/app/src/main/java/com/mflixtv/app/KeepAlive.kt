package com.mflixtv.app

import android.content.Context
import android.os.PowerManager
import android.util.Log

/**
 * 息屏常驻（CPU 不被挂起）。
 *
 * 为什么必须有它：前台服务只能保证「进程不被回收」，管不住 CPU。
 * 手机一锁屏，系统很快进 Doze / 挂起，网卡虽然还连着，但 CPU 睡了，
 * 局域网里那台设备发过来的 HTTP 请求（尤其是一段一段拉 m3u8 分片）就没人应答——
 * 表现就是「手机上什么都好，一锁屏，别的设备打开页面就播不动了」。
 *
 * 这里持一个 PARTIAL_WAKE_LOCK（只唤 CPU、不亮屏）：
 *  - 默认「常驻」：服务活着就一直持着，锁屏后照样能应答；
 *  - 用户嫌耗电可以关掉，关掉后只在有流量时持 10 分钟（看片期间不断，空闲就松手）。
 */
object KeepAlive {
    private const val TAG = "MFlixTV"
    private const val PREFS = "mflixtv-keep"
    private const val KEY_ALWAYS = "wake_always"
    private const val TRAFFIC_TIMEOUT_MS = 10 * 60 * 1000L

    @Volatile
    private var lock: PowerManager.WakeLock? = null

    /** 默认开着：这个 App 本身就是「手机当服务器」，宁可多耗一点电也不能掉线。 */
    fun alwaysOn(ctx: Context): Boolean {
        return try {
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(KEY_ALWAYS, true)
        } catch (_: Throwable) {
            true
        }
    }

    fun setAlwaysOn(ctx: Context, on: Boolean) {
        try {
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(KEY_ALWAYS, on).apply()
        } catch (_: Throwable) {
        }
        if (on) hold(ctx) else release()
    }

    fun isHeld(): Boolean {
        return try {
            lock?.isHeld == true
        } catch (_: Throwable) {
            false
        }
    }

    /** 按当前策略持锁：常驻模式无超时，省电模式 10 分钟（每次请求都会续）。 */
    fun applyPolicy(ctx: Context) {
        if (alwaysOn(ctx)) hold(ctx) else touch(ctx)
    }

    fun hold(ctx: Context) {
        try {
            val pm = ctx.applicationContext.getSystemService(Context.POWER_SERVICE) as PowerManager
            val l = lock ?: pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "MFlixTV:cpu").also {
                it.setReferenceCounted(false)
                lock = it
            }
            if (!l.isHeld) {
                l.acquire()
                Log.i(TAG, "cpu wakelock held (always)")
            }
        } catch (e: Throwable) {
            Log.w(TAG, "wakelock hold failed", e)
        }
    }

    /** 有请求进来就续一次（只在省电模式下有意义）。 */
    fun touch(ctx: Context) {
        if (alwaysOn(ctx)) {
            if (!isHeld()) hold(ctx)
            return
        }
        try {
            val pm = ctx.applicationContext.getSystemService(Context.POWER_SERVICE) as PowerManager
            val l = lock ?: pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "MFlixTV:cpu").also {
                it.setReferenceCounted(false)
                lock = it
            }
            // 带超时的 acquire 会重置计时，同一个 lock 反复 acquire 是安全的
            l.acquire(TRAFFIC_TIMEOUT_MS)
        } catch (_: Throwable) {
        }
    }

    fun release() {
        try {
            val l = lock
            if (l != null && l.isHeld) l.release()
        } catch (_: Throwable) {
        }
        lock = null
    }
}
