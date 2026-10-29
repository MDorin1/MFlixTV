package com.mflixtv.app

import android.app.Application
import android.content.Context
import android.os.Build
import android.util.Log
import android.webkit.WebView
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 崩溃兜底 + 机型信息。
 *
 * 崩溃会写进 /sdcard/Android/data/com.mflixtv.app/files/crash.log（手机没有 adb 也能用
 * 文件管理找到发出来），同时把「最近一次异常」记进 SharedPreferences，
 * 设置页和 /api/status 都能读到 —— 别人反馈「装上去就闪退」时能直接拿到机型、系统版本、
 * WebView 版本和堆栈，不用再靠猜。
 *
 * 日志超过 128 KB 自动只留最后一段，避免长期使用把存储占满。
 */
class MFlixApp : Application() {
    override fun onCreate() {
        super.onCreate()
        // 源列表要尽早可用：前台服务、WebView、后台刷新都读同一份
        try {
            Sources.init(this)
            Net.init(this)
        } catch (_: Throwable) {
        }
        // 常驻自愈：15 分钟一次的闹钟，服务被系统杀了也能自己回来
        try {
            BootReceiver.schedule(this)
        } catch (_: Throwable) {
        }
        val prev = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { t, e ->
            try {
                CrashLog.record(this, t, e)
            } catch (_: Throwable) {
            }
            prev?.uncaughtException(t, e)
        }
    }
}

/** 崩溃记录的小工具：写文件 + 留一句摘要给设置页显示。 */
object CrashLog {
    private const val NAME = "crash.log"
    private const val PREFS = "mflixtv-crash"
    private const val KEY_LAST = "last"
    private const val MAX_BYTES = 128 * 1024

    fun file(ctx: Context): File {
        val dir = try {
            ctx.getExternalFilesDir(null)
        } catch (_: Throwable) {
            null
        } ?: ctx.filesDir
        return File(dir, NAME)
    }

    /** 一句话的机型指纹：厂商 型号 Android 版本 WebView 版本。 */
    fun deviceLine(ctx: Context): String {
        val sb = StringBuilder()
        sb.append(Build.MANUFACTURER).append(' ').append(Build.MODEL)
            .append(" | Android ").append(Build.VERSION.RELEASE).append(" (API ").append(Build.VERSION.SDK_INT).append(')')
            .append(" | abi=").append(Build.SUPPORTED_ABIS.joinToString(","))
        sb.append(" | webview=").append(webViewVersion(ctx))
        return sb.toString()
    }

    /**
     * 取系统 WebView 版本。
     * Android 8（API 26）起有 WebView.getCurrentWebViewPackage()，老盒子（斐讯 N1 这类
     * Android 7）没有这个方法，直接调会抛 NoSuchMethodError，所以那里退回查包管理器。
     * 别人的盒子上出问题时，这一行就是判断「是不是 WebView 太老」的第一手依据。
     */
    fun webViewVersion(ctx: Context): String {
        if (Build.VERSION.SDK_INT >= 26) {
            try {
                val pkg = WebView.getCurrentWebViewPackage()
                return pkg?.versionName ?: "none(需安装 Android System WebView)"
            } catch (_: Throwable) {
            }
        }
        for (name in arrayOf("com.google.android.webview", "com.android.webview", "com.android.chrome")) {
            try {
                val pi = ctx.packageManager.getPackageInfo(name, 0)
                val v = pi.versionName ?: "?"
                return "$v(${name.substringAfterLast('.')})"
            } catch (_: Throwable) {
            }
        }
        return "none(需安装 Android System WebView)"
    }

    fun record(ctx: Context, t: Thread?, e: Throwable?) {
        val stamp = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.CHINA).format(Date())
        val head = e?.let { it.javaClass.name + ": " + (it.message ?: "") } ?: "unknown"
        val body = buildString {
            append("\n===== ").append(stamp).append(" =====\n")
            append("device=").append(deviceLine(ctx)).append('\n')
            append("thread=").append(t?.name ?: "?").append('\n')
            append(Log.getStackTraceString(e)).append('\n')
        }
        try {
            val f = file(ctx)
            if (f.exists() && f.length() > MAX_BYTES) {
                // 只保留最后 64 KB，再追加这次的
                val text = f.readText()
                f.writeText(text.takeLast(64 * 1024))
            }
            f.appendText(body)
        } catch (_: Throwable) {
        }
        try {
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putString(KEY_LAST, stamp + "  " + head.take(140))
                .apply()
        } catch (_: Throwable) {
        }
    }

    /** 最近一次异常（没有就返回空串）。 */
    fun lastSummary(ctx: Context): String {
        return try {
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_LAST, "") ?: ""
        } catch (_: Throwable) {
            ""
        }
    }
}
