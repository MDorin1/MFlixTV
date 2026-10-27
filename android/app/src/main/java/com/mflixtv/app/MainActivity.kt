package com.mflixtv.app

import android.annotation.SuppressLint
import android.os.Bundle
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity

/**
 * MFlixTV 安卓端：所有页面都来自手机本机跑起来的 Node 服务（127.0.0.1:8080）。
 * 局域网里其它设备访问「手机 IP:8080」看到的是同一套界面。
 */
class MainActivity : AppCompatActivity() {
    private lateinit var web: WebView

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        web = WebView(this)
        startForegroundService(android.content.Intent(this, ServerService::class.java))
        setContentView(web)

        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            useWideViewPort = true
            loadWithOverviewMode = true
        }
        web.webViewClient = WebViewClient()
        web.webChromeClient = WebChromeClient()
        web.loadUrl("http://127.0.0.1:8080/")
    }

    override fun onBackPressed() {
        if (web.canGoBack()) web.goBack() else super.onBackPressed()
    }
}
