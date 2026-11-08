package com.mflixtv.app

import android.content.Context
import java.net.HttpURLConnection
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.URL
import java.security.SecureRandom
import java.security.cert.X509Certificate
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

/**
 * 统一出口：所有对外请求（源站接口、图片、分片）都从这里走。
 *
 * 三件事是踩过坑才加的：
 *  1. **证书宽容**：采集站的证书链常常缺中间证书。桌面用 Node/Chromium 能过，
 *     Android 的 Java HTTPS 校验更严，会直接 `CertPathValidatorException` —— 表现就是手机上
 *     什么都拉不到、电脑上一切正常。这里放宽到只加密、不校验链。
 *  2. **可选代理**：手机在墙内直连这些站基本必挂；设置里能填一个 HTTP 代理（手机上的梯子地址），
 *     填了就一直走它。
 *  3. 统一超时与 UA/Referer，避免各处各写一套。
 */
object Net {

    const val UA =
        "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36"

    private const val SP = "mflixtv"
    private const val K_PROXY = "http_proxy"

    @Volatile private var sp: android.content.SharedPreferences? = null
    @Volatile private var proxyHost: String? = null
    @Volatile private var proxyPort: Int = 0

    fun init(ctx: Context) {
        if (sp != null) return
        val p = ctx.applicationContext.getSharedPreferences(SP, Context.MODE_PRIVATE)
        sp = p
        applyProxyString(p.getString(K_PROXY, "").orEmpty())
    }

    /** 保存形如 `192.168.1.5:7890` 的代理；传空字符串表示不走代理。 */
    fun setProxy(ctx: Context, hostPort: String): Boolean {
        init(ctx)
        val trimmed = hostPort.trim()
        if (trimmed.isNotEmpty()) {
            val parts = trimmed.split(":")
            if (parts.size != 2) return false
            val port = parts[1].toIntOrNull() ?: return false
            if (port !in 1..65535) return false
        }
        sp?.edit()?.putString(K_PROXY, trimmed)?.apply()
        applyProxyString(trimmed)
        return true
    }

    fun proxyString(): String = if (proxyHost != null) "$proxyHost:$proxyPort" else ""

    private fun applyProxyString(s: String) {
        val t = s.trim()
        if (t.isEmpty()) {
            proxyHost = null; proxyPort = 0
            return
        }
        val parts = t.split(":")
        val port = parts.getOrNull(1)?.toIntOrNull()
        if (parts.size == 2 && port != null) {
            proxyHost = parts[0]; proxyPort = port
        } else {
            proxyHost = null; proxyPort = 0
        }
    }

    private fun currentProxy(): Proxy? {
        val h = proxyHost ?: return null
        return try {
            Proxy(Proxy.Type.HTTP, InetSocketAddress(h, proxyPort))
        } catch (_: Exception) {
            null
        }
    }

    private val trustAll: SSLSocketFactory by lazy {
        val tm = arrayOf<TrustManager>(object : X509TrustManager {
            override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
            override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
            override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()
        })
        val ctx = SSLContext.getInstance("TLS")
        ctx.init(null, tm, SecureRandom())
        ctx.socketFactory
    }

    private val anyHost = HostnameVerifier { _, _ -> true }

    /** 建一个已配好超时、UA、Referer、证书宽容（和可选代理）的连接。 */
    fun open(raw: String, timeoutMs: Int, referer: String? = null, ua: String? = null): HttpURLConnection {
        val target = if (raw.startsWith("http")) raw else "https://" + raw
        val u = URL(target)
        val p = currentProxy()
        val conn = (if (p != null) u.openConnection(p) else u.openConnection()) as HttpURLConnection
        conn.connectTimeout = timeoutMs
        conn.readTimeout = timeoutMs
        conn.instanceFollowRedirects = true
        conn.setRequestProperty("User-Agent", ua ?: UA)
        conn.setRequestProperty("Accept", "*/*")
        conn.setRequestProperty("Accept-Language", "zh-CN,zh;q=0.9")
        conn.setRequestProperty("Referer", referer ?: (u.protocol + "://" + u.host + "/"))
        if (conn is HttpsURLConnection) {
            try {
                conn.sslSocketFactory = trustAll
                conn.hostnameVerifier = anyHost
            } catch (_: Throwable) {
            }
        }
        return conn
    }

    fun getText(url: String, timeoutMs: Int = 7000, referer: String? = null, ua: String? = null): String {
        val conn = open(url, timeoutMs, referer, ua)
        try {
            val code = conn.responseCode
            if (code !in 200..299) throw java.io.IOException("HTTP $code")
            val raw = conn.inputStream ?: throw java.io.IOException("empty body")
            // 有些站（弹幕库就是）不理会 Accept-Encoding，照样压；Java 的 HttpURLConnection
            // 不会替你解压，按文本读出来就是一串乱码，这里按 Content-Encoding 自己解。
            val enc = conn.contentEncoding.orEmpty()
            val stream: java.io.InputStream = when {
                enc.contains("gzip", ignoreCase = true) -> java.util.zip.GZIPInputStream(raw)
                enc.contains("deflate", ignoreCase = true) -> inflate(raw)
                else -> raw
            }
            return stream.bufferedReader(Charsets.UTF_8).use { it.readText() }
        } finally {
            try {
                conn.disconnect()
            } catch (_: Throwable) {
            }
        }
    }

    /** deflate 有两种：zlib 包裹（0x78 开头）和裸 deflate。看头两个字节判断。 */
    private fun inflate(raw: java.io.InputStream): java.io.InputStream {
        val pb = java.io.PushbackInputStream(raw, 2)
        val a = pb.read()
        val b = pb.read()
        if (b >= 0) pb.unread(b)
        if (a >= 0) pb.unread(a)
        val zlib = a == 0x78 && (b == 0x01 || b == 0x5E || b == 0x9C || b == 0xDA)
        return java.util.zip.InflaterInputStream(pb, java.util.zip.Inflater(!zlib))
    }

    /** 给人看的短错误：类名 + 前 70 字，够定位是哪类问题。 */
    fun shortErr(e: Throwable): String {
        val m = (e.message ?: "").replace(Regex("\\s+"), " ").trim()
        val head = e.javaClass.simpleName
        return if (m.isEmpty()) head else "$head: " + m.take(70)
    }

    /** 一行日志（logcat tag=MFlixTV）：换源、自愈这类后台动作，出问题时有据可查。 */
    fun log(msg: String) {
        try {
            android.util.Log.i("MFlixTV", msg)
        } catch (_: Throwable) {
        }
    }
}
