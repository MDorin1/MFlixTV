package com.mflixtv.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log

/**
 * 开机自启。
 *
 * 手机重启之后服务不会自己回来，局域网访问就一直「打不开」——这里在开机
 * 和覆盖安装后把前台服务拉起来，用户不用为了「能用」再手动点一次 App。
 * Android 8+ 只能通过 startForegroundService，服务里 5 秒内必须亮通知（已处理）。
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return
        if (action != Intent.ACTION_BOOT_COMPLETED && action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        try {
            val svc = Intent(context, ServerService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(svc)
            else context.startService(svc)
            Log.i("MFlixTV", "boot receiver started service, action=$action")
        } catch (e: Throwable) {
            Log.w("MFlixTV", "boot start failed", e)
        }
    }
}
