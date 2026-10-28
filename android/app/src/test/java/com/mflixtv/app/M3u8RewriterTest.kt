package com.mflixtv.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.URLDecoder

/** HLS manifest 重写：分片、密钥、子列表都要换成 /api/proxy，相对地址要按 base 解析。 */
class M3u8RewriterTest {

    private val base = "https://vod6.bdzybf11.com/2025/xh9JkCf7/index.m3u8"

    private fun unwrap(line: String): String {
        assertTrue("应当被代理: $line", line.startsWith("/api/proxy?url="))
        return URLDecoder.decode(line.removePrefix("/api/proxy?url="), "UTF-8")
    }

    @Test
    fun relativeSegmentsResolveAgainstBase() {
        val src = """
            #EXTM3U
            #EXT-X-TARGETDURATION:10
            001.ts
            002.ts
        """.trimIndent()
        val out = M3u8Rewriter.rewrite(src, base).lines()
        assertEquals("#EXTM3U", out[0])
        assertEquals("https://vod6.bdzybf11.com/2025/xh9JkCf7/001.ts", unwrap(out[2]))
        assertEquals("https://vod6.bdzybf11.com/2025/xh9JkCf7/002.ts", unwrap(out[3]))
    }

    @Test
    fun absoluteSegmentsOnAnotherHostAreProxied() {
        val src = "#EXTM3U\nhttps://b2.bdzybf22.com/videos/a/1/index.m3u8\n"
        val out = M3u8Rewriter.rewrite(src, base).lines()
        assertEquals("https://b2.bdzybf22.com/videos/a/1/index.m3u8", unwrap(out[1]))
    }

    @Test
    fun keyUriIsRewrittenButOtherAttributesKept() {
        val src = "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\",IV=0x1234\n000.ts"
        val out = M3u8Rewriter.rewrite(src, base)
        val keyLine = out.lines()[1]
        assertTrue(keyLine.startsWith("#EXT-X-KEY:METHOD=AES-128,URI=\""))
        assertTrue(keyLine.contains("IV=0x1234"))
        assertTrue(keyLine.contains("https%3A%2F%2Fvod6.bdzybf11.com%2F2025%2Fxh9JkCf7%2Fkey.bin"))
    }

    @Test
    fun initSegmentMapIsRewritten() {
        val src = "#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\"\nseg.m4s"
        val out = M3u8Rewriter.rewrite(src, base).lines()
        assertTrue(out[1].contains("init.mp4"))
        assertEquals("https://vod6.bdzybf11.com/2025/xh9JkCf7/seg.m4s", unwrap(out[2]))
    }

    @Test
    fun dataUriAndAlreadyProxiedAreLeftAlone() {
        val src = "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"data:text/plain;base64,AAAA\"\n/api/proxy?url=x"
        val out = M3u8Rewriter.rewrite(src, base).lines()
        assertTrue(out[1].contains("data:text/plain;base64,AAAA"))
        assertEquals("/api/proxy?url=x", out[2])
    }

    @Test
    fun blankLinesAndCrlfSurvive() {
        val src = "#EXTM3U\r\n\r\n001.ts\r\n"
        val out = M3u8Rewriter.rewrite(src, base)
        assertTrue(out.contains("#EXTM3U"))
        assertTrue(out.contains("001.ts") || out.contains("/api/proxy"))
    }
}
