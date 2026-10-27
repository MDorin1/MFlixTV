package com.mflixtv.app

import android.content.Context
import fi.iki.elonen.NanoHTTPD
import java.net.HttpURLConnection
import java.net.URL

/**
 * 手机上的极简服务端：先只做三件事，把「手机起服务、局域网能访问」跑通。
 *  - GET /               占位页（后续换成本地打包的前端）
 *  - GET /api/status     连通性与版本
 *  - GET /api/proxy?url= 图片/视频直通，Range 透传（视频要它才能拖动）
 */
class WebServer(context: Context, port: Int = 8080) : NanoHTTPD(port) {
    private val ctx = context

    override fun serve(session: IHTTPSession): Response {
        val uri = session.uri ?: "/"
        return when {
            uri == "/api/status" -> json("{\"passwordRequired\":false,\"verified\":true,\"version\":\"android-0.1\"}")
            uri == "/api/search" -> json(SourceSearch.search(session.parameters["wd"]?.firstOrNull() ?: ""))
            uri == "/api/proxy" -> proxy(session)
            uri == "/" || uri == "/index.html" -> assetPage()
            else -> newFixedLengthResponse(Response.Status.NOT_FOUND, MIME_PLAINTEXT, "not found")
        }
    }

    /** 首页：直接读 APK 内置的 assets/index.html，相对路径请求才会打到本机服务。 */
    private fun assetPage(): Response = try {
        val text = ctx.assets.open("index.html").bufferedReader().use { it.readText() }
        html(text)
    } catch (e: Exception) {
        html("<h1>MFlixTV</h1><p>assets/index.html 缺失</p>")
    }

    private fun json(body: String): Response =
        newFixedLengthResponse(Response.Status.OK, "application/json; charset=utf-8", body)

    private fun html(body: String): Response =
        newFixedLengthResponse(Response.Status.OK, "text/html; charset=utf-8", body)

    /** 代理：原样转发，Range/Content-Range 透传，保证播放器能拖动。 */
    private fun proxy(session: IHTTPSession): Response {
        val target = session.parameters["url"]?.firstOrNull()
            ?: return json("{\"error\":\"missing url\"}")
        return try {
            val conn = URL(target).openConnection() as HttpURLConnection
            conn.connectTimeout = 15000
            conn.readTimeout = 30000
            session.headers["range"]?.let { conn.setRequestProperty("Range", it) }
            conn.setRequestProperty("User-Agent", "Mozilla/5.0")
            val code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else conn.errorStream
            val resp = newChunkedResponse(
                if (code in 200..299) Response.Status.OK else Response.Status.INTERNAL_ERROR,
                conn.contentType ?: "application/octet-stream",
                stream
            )
            conn.getHeaderField("Content-Range")?.let { resp.addHeader("Content-Range", it) }
            conn.getHeaderField("Content-Length")?.let { resp.addHeader("Content-Length", it) }
            resp.addHeader("Accept-Ranges", "bytes")
            resp
        } catch (e: Exception) {
            json("{\"error\":\"" + (e.message ?: "proxy failed").replace("\"", "'") + "\"}")
        }
    }
}
