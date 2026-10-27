package com.mflixtv.app

import android.app.*
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

/** 前台服务：稍后在这里用 nodejs-mobile 启动 Node 服务（next start -H 0.0.0.0 -p 8080）。 */
class ServerService : Service() {
    private var server: WebServer? = null
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val channelId = "mflixtv"
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.createNotificationChannel(NotificationChannel(channelId, "MFlixTV", NotificationManager.IMPORTANCE_LOW))
        }
        val n = NotificationCompat.Builder(this, channelId)
            .setContentTitle("MFlixTV 服务运行中")
            .setContentText("局域网访问：http://<手机IP>:8080")
            .setSmallIcon(android.R.drawable.ic_media_play)
            .build()
        startForeground(1, n)
        if (server == null) {
            try {
                server = WebServer(this, 8080).also { it.start(fi.iki.elonen.NanoHTTPD.SOCKET_READ_TIMEOUT, false) }
            } catch (e: Exception) {
            }
        }
        return START_STICKY
    }
}
