package com.mflixtv.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.Network
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import java.net.NetworkInterface

/**
 * 前台服务：把手机变成一台小服务器（0.0.0.0:8080）。
 *
 * 三件事保证「手机开着就一直能用」：
 *  1. 前台服务 + 常驻通知，避免被系统回收；
 *  2. WifiLock，息屏后 WiFi 不被省电策略掐掉（否则屏幕一黑，别的设备就连不上）；
 *  3. 网络变化时刷新通知里的 IP —— 换 WiFi / 开热点后地址变了，用户看通知就知道新地址。
 */
class ServerService : Service() {
    private var server: WebServer? = null
    private var wifiLock: WifiManager.WifiLock? = null
    private var netCallback: ConnectivityManager.NetworkCallback? = null

    companion object {
        private const val CH_ID = "mflixtv-service"
        private const val NOTI_ID = 1
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        try {
            Sources.init(this)
            Net.init(this)
        } catch (_: Throwable) {
        }

        ensureChannel()
        // Android 8.0+ 要求 startForegroundService 之后 5 秒内 startForeground，
        // 所以先亮通知，再起 HTTP 服务（绑定端口放到后面，慢也不会被系统判 ANR）。
        try {
            val n = buildNotification(LanIp.ip())
            val type = if (Build.VERSION.SDK_INT >= 34)
                android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
            else android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
            androidx.core.app.ServiceCompat.startForeground(this, NOTI_ID, n, type)
        } catch (e: Throwable) {
            // 少数 ROM 对 specialUse 不认，退回不带类型的 startForeground 也要能跑起来
            try {
                startForeground(NOTI_ID, buildNotification(LanIp.ip()))
            } catch (e2: Throwable) {
                Log.w("MFlixTV", "startForeground failed", e2)
            }
        }

        if (server == null) {
            try {
                server = WebServer(this, 8080).also {
                    it.start(fi.iki.elonen.NanoHTTPD.SOCKET_READ_TIMEOUT, false)
                }
                Log.i("MFlixTV", "http server listening on 0.0.0.0:8080, lan ip=${LanIp.ip()}")
            } catch (e: Throwable) {
                Log.e("MFlixTV", "http server failed to start", e)
            }
        }

        acquireWifiLock()
        watchNetwork()
        return START_STICKY
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (nm.getNotificationChannel(CH_ID) == null) {
                nm.createNotificationChannel(NotificationChannel(CH_ID, "MFlixTV 服务", NotificationManager.IMPORTANCE_LOW))
            }
        }
    }

    private fun buildNotification(ip: String): Notification {
        val tap = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or
                (if (Build.VERSION.SDK_INT >= 23) PendingIntent.FLAG_IMMUTABLE else 0)
        )
        return NotificationCompat.Builder(this, CH_ID)
            .setContentTitle("MFlixTV 正在运行")
            .setContentText("局域网访问：http://$ip:8080")
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setOngoing(true)
            .setContentIntent(tap)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    private fun refreshNotification() {
        try {
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.notify(NOTI_ID, buildNotification(LanIp.ip()))
        } catch (_: Throwable) {
        }
    }

    /** 息屏后不让 WiFi 掉线：没有它，屏幕一黑别的设备就连不上 8080。 */
    private fun acquireWifiLock() {
        if (wifiLock?.isHeld == true) return
        try {
            val wm = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
            @Suppress("DEPRECATION")
            val lock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "MFlixTV:server")
            lock.setReferenceCounted(false)
            lock.acquire()
            wifiLock = lock
            Log.i("MFlixTV", "wifi lock acquired")
        } catch (e: Throwable) {
            Log.w("MFlixTV", "wifi lock failed", e)
        }
    }

    private fun releaseWifiLock() {
        try {
            if (wifiLock?.isHeld == true) wifiLock?.release()
        } catch (_: Throwable) {
        }
        wifiLock = null
    }

    /** 换网 / 开热点后 IP 会变，通知里要跟着变。 */
    private fun watchNetwork() {
        if (netCallback != null) return
        try {
            val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
            val cb = object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) {
                    postDelayedRefresh()
                }

                override fun onLost(network: Network) {
                    postDelayedRefresh()
                }
            }
            cm.registerDefaultNetworkCallback(cb)
            netCallback = cb
        } catch (e: Throwable) {
            Log.w("MFlixTV", "network callback failed", e)
        }
    }

    private fun postDelayedRefresh() {
        android.os.Handler(mainLooper).postDelayed({ refreshNotification() }, 1200)
    }

    override fun onDestroy() {
        try {
            netCallback?.let {
                (getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager).unregisterNetworkCallback(it)
            }
        } catch (_: Throwable) {
        }
        netCallback = null
        releaseWifiLock()
        try {
            server?.stop()
        } catch (_: Throwable) {
        }
        server = null
        super.onDestroy()
    }
}

