package com.mflixtv.app

import java.net.URI
import java.net.URLEncoder

/**
 * 把 HLS manifest 里所有 URI 换成本机代理地址。
 *
 * 为什么要做：采集站的 m3u8 分片通常在另一个域名上，WebView 里直接拉会被跨域/防盗链拦住；
 * 换成 /api/proxy?url=… 之后，请求由手机本机的服务端转发，分片、密钥、init 段一起解决。
 *
 * 规则：
 *  - 普通行（分片 / 子播放列表）→ 先按 base 解析成绝对地址，再套代理
 *  - #EXT-X-KEY / #EXT-X-MAP / #EXT-X-MEDIA 的 URI="…" → 同上，其它属性原样保留
 *  - data: 内联数据、已经是 /api/proxy 的地址原样放行
 */
object M3u8Rewriter {

    private val uriAttr = Regex("URI=\"([^\"]+)\"")

    fun rewrite(text: String, baseUrl: String): String {
        val base: URI? = try {
            URI(baseUrl)
        } catch (e: Exception) {
            null
        }

        fun abs(u: String): String = try {
            base?.resolve(u.trim())?.toString() ?: u
        } catch (e: Exception) {
            u
        }

        fun wrap(raw: String): String {
            val u = raw.trim()
            return when {
                u.startsWith("data:") -> raw
                u.startsWith("/api/proxy") -> u
                else -> "/api/proxy?url=" + URLEncoder.encode(abs(u), "UTF-8")
            }
        }

        return text.lines().joinToString("\n") { line ->
            val t = line.trim()
            when {
                t.isEmpty() -> line
                t.startsWith("#") -> uriAttr.replace(line) { m -> "URI=\"" + wrap(m.groupValues[1]) + "\"" }
                else -> wrap(t)
            }
        }
    }
}
