package com.mflixtv.app

import java.net.Inet4Address
import java.net.NetworkInterface

/**
 * 本机局域网地址。
 *
 * 注意：App 里的 WebView 是自己访问 127.0.0.1:8080，页面里拿到的 host 永远是回环地址，
 * 所以「局域网怎么访问」只能由 Android 这边查网卡再告诉页面。
 *
 * 取法：wlan（WiFi）优先 → ap（手机开热点）→ 其它非回环网卡，只认 IPv4。
 */
object LanIp {

    fun ip(): String {
        return try {
            val en = NetworkInterface.getNetworkInterfaces() ?: return ""
            val all = en.toList()
            val ordered = all.sortedByDescending {
                val n = it.name.lowercase()
                when {
                    n.startsWith("wlan") -> 3
                    n.startsWith("ap") || n.contains("softap") -> 2
                    n.startsWith("eth") -> 1
                    else -> 0
                }
            }
            for (nic in ordered) {
                if (!nic.isUp || nic.isLoopback) continue
                for (addr in nic.inetAddresses) {
                    if (addr is Inet4Address && !addr.isLoopbackAddress) {
                        val host = addr.hostAddress ?: continue
                        if (host.startsWith("169.254.")) continue // 无 DHCP 时的自分配地址
                        return host
                    }
                }
            }
            ""
        } catch (_: Throwable) {
            ""
        }
    }

    /** WiFi 网卡是否在工作（用移动数据时局域网访问不了）。 */
    fun wifiUp(): Boolean {
        return try {
            val en = NetworkInterface.getNetworkInterfaces() ?: return false
            en.toList().any { it.name.lowercase().startsWith("wlan") && it.isUp && !it.isLoopback }
        } catch (_: Throwable) {
            false
        }
    }
}
