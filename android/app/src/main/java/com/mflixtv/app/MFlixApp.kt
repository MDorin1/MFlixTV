package com.mflixtv.app

import android.app.Application
import android.util.Log
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 崩溃兜底：把未捕获异常写到 /sdcard/Android/data/com.mflixtv.app/files/crash.log，
 * 手机没有 adb 也能用「文件管理」找到这个文件发出来，比只说一句「闪退」有用得多。
 */
class MFlixApp : Application() {
    override fun onCreate() {
        super.onCreate()
        // 源列表要尽早可用：前台服务、WebView、后台刷新都读同一份
        try {
            Sources.init(this)
        } catch (_: Throwable) {
        }
        val prev = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { t, e ->
            try {
                val dir = getExternalFilesDir(null) ?: filesDir
                val stamp = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.CHINA).format(Date())
                File(dir, "crash.log").appendText(
                    "\n===== $stamp =====\n" +
                        "thread=${t.name}\n" +
                        Log.getStackTraceString(e) + "\n"
                )
            } catch (_: Throwable) {
            }
            prev?.uncaughtException(t, e)
        }
    }
}
