package com.mflixtv.app

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log

/**
 * 开机自启 + 常驻自愈。
 *
 * 干三件事：
 *  1. 开机（或覆盖安装）后把前台服务拉起来——局域网访问不用先手动点 App；
 *  2. 电视 / 盒子上直接把界面拉起来（手机不做，会被当成流氓软件）；
 *  3. 挂一个 15 分钟的循环闹钟，服务被系统杀了就自己再拉一次。
 *
 * Android 10 起「后台启动界面」默认被拦，开机广播不在白名单里，电视盒子 ROM 大多放行、
 * 原生 Android TV 可能拦——所以第 2 步整段 try/catch，失败也不影响服务常驻。
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return
        val boot = action == Intent.ACTION_BOOT_COMPLETED
        val upgraded = action == Intent.ACTION_MY_PACKAGE_REPLACED
        val keep = action == ACTION_KEEPALIVE
        if (!boot && !upgraded && !keep) return
        Log.i("MFlixTV", "boot receiver action=$action")

        startServer(context)
        // 开机后拉界面：只有电视 / 盒子才这么干，手机上不打扰用户
        if (boot && isTv(context)) showUi(context)
        // 自愈：闹钟到期时服务不在了就拉起来（这行放在最后，闹钟自己也会再排下一次）
        schedule(context)
    }

    private fun startServer(context: Context) {
        try {
            val svc = Intent(context, ServerService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(svc)
            else context.startService(svc)
        } catch (e: Throwable) {
            Log.w("MFlixTV", "boot start service failed", e)
        }
    }

    private fun showUi(context: Context) {
        try {
            val ui = Intent(context, MainActivity::class.java)
            ui.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            ui.putExtra("tv", true)
            context.startActivity(ui)
            Log.i("MFlixTV", "boot launched tv ui")
        } catch (e: Throwable) {
            // Android 10+ 可能直接抛 BackgroundActivityStartDenied；服务已经起来了，不影响用
            Log.w("MFlixTV", "boot launch ui blocked", e)
        }
    }

    private fun isTv(context: Context): Boolean {
        return try {
            if (Build.VERSION.SDK_INT >= 17) {
                val ui = context.getSystemService(Context.UI_MODE_SERVICE) as? android.app.UiModeManager
                if (ui != null && ui.currentModeType == android.content.res.Configuration.UI_MODE_TYPE_TELEVISION) {
                    return true
                }
            }
            val pm = context.packageManager
            pm.hasSystemFeature(PackageManager.FEATURE_LEANBACK) ||
                (!pm.hasSystemFeature(PackageManager.FEATURE_TOUCHSCREEN) &&
                    !pm.hasSystemFeature(PackageManager.FEATURE_FAKETOUCH))
        } catch (_: Throwable) {
            false
        }
    }

    companion object {
        const val ACTION_KEEPALIVE = "com.mflixtv.app.KEEPALIVE"
        private const val EVERY_MS = 15 * 60 * 1000L

        /** 排下一次自愈检查（重复排是安全的，系统只保留一个同 action 的闹钟）。 */
        fun schedule(context: Context) {
            try {
                val am = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
                val pi = PendingIntent.getBroadcast(
                    context,
                    1001,
                    Intent(context, BootReceiver::class.java).setAction(ACTION_KEEPALIVE),
                    if (Build.VERSION.SDK_INT >= 23) PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
                    else PendingIntent.FLAG_UPDATE_CURRENT
                )
                am.setInexactRepeating(AlarmManager.RTC, System.currentTimeMillis() + EVERY_MS, EVERY_MS, pi)
            } catch (e: Throwable) {
                Log.w("MFlixTV", "schedule keepalive failed", e)
            }
        }
    }
}
