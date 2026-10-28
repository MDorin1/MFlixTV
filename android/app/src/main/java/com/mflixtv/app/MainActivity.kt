package com.mflixtv.app

import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.ActivityInfo
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity

/**
 * MFlixTV 安卓端。
 *
 * 界面全部来自手机本机跑起来的服务（127.0.0.1:8080），局域网里别的设备访问
 * 「手机 IP:8080」看到的是同一套页面。这里只负责：起服务、全屏 WebView、
 * 播放时切横屏、返回键交给页面处理。
 */
class MainActivity : AppCompatActivity() {
    private lateinit var web: WebView
    private var retries = 0

    /** 暴露给页面的原生能力（页面里用 MFlixNative.xxx 调）。 */
    inner class Bridge {
        @JavascriptInterface
        fun landscape(on: Boolean) {
            runOnUiThread {
                requestedOrientation = if (on) ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
                else ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
                if (on) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            }
        }

        @JavascriptInterface
        fun keepAwake(on: Boolean) {
            runOnUiThread {
                if (on) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            }
        }

        @JavascriptInterface
        fun toast(msg: String) {
            runOnUiThread { android.widget.Toast.makeText(this@MainActivity, msg, android.widget.Toast.LENGTH_SHORT).show() }
        }

        /** 是否已经进了电池优化白名单（进了就不会被后台清理）。 */
        @JavascriptInterface
        fun batteryOk(): Boolean {
            return try {
                val pm = getSystemService(android.content.Context.POWER_SERVICE) as android.os.PowerManager
                pm.isIgnoringBatteryOptimizations(packageName)
            } catch (e: Throwable) {
                false
            }
        }

        /** 弹系统对话框申请「忽略电池优化」，国产 ROM 还会再要「自启动」权限。 */
        @JavascriptInterface
        fun battery() {
            runOnUiThread {
                try {
                    val pm = getSystemService(android.content.Context.POWER_SERVICE) as android.os.PowerManager
                    if (pm.isIgnoringBatteryOptimizations(packageName)) {
                        android.widget.Toast.makeText(
                            this@MainActivity, "已经允许后台常驻了", android.widget.Toast.LENGTH_SHORT
                        ).show()
                        return@runOnUiThread
                    }
                    val i = android.content.Intent(
                        android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                        android.net.Uri.parse("package:$packageName")
                    )
                    startActivity(i)
                } catch (e: Throwable) {
                    try {
                        startActivity(android.content.Intent(android.provider.Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
                    } catch (_: Throwable) {
                        android.widget.Toast.makeText(
                            this@MainActivity, "请在系统设置里手动允许后台运行", android.widget.Toast.LENGTH_LONG
                        ).show()
                    }
                }
            }
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        immersive()

        web = WebView(this)
        web.setBackgroundColor(0xFF000000.toInt())
        setContentView(web)

        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            loadsImagesAutomatically = true
            cacheMode = WebSettings.LOAD_DEFAULT
            useWideViewPort = true
            loadWithOverviewMode = true
            textZoom = 100
        }
        web.addJavascriptInterface(Bridge(), "MFlixNative")

        web.webViewClient = object : WebViewClient() {
            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame && retries < 8) {
                    retries++
                    view.postDelayed({ view.loadUrl("http://127.0.0.1:8080/") }, 600)
                }
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: android.webkit.PermissionRequest) {
                request.deny()
            }
        }

        startForegroundService(Intent(this, ServerService::class.java))
        // Android 13+ 通知要用户同意，否则通知栏看不到「局域网地址」那一条（服务本身照跑）
        if (Build.VERSION.SDK_INT >= 33) {
            try {
                requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 1001)
            } catch (_: Throwable) {
            }
        }
        // 服务起来要几百毫秒，先等一小会儿再加载，免得吃一个连接被拒
        web.postDelayed({ web.loadUrl("http://127.0.0.1:8080/") }, 450)
    }

    private fun immersive() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.setDecorFitsSystemWindows(false)
            window.insetsController?.let {
                it.hide(WindowInsets.Type.statusBars() or WindowInsets.Type.navigationBars())
                it.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = (
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                    or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                    or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    or View.SYSTEM_UI_FLAG_FULLSCREEN
                    or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                )
        }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) immersive()
    }

    @Deprecated("Android 13 起由系统手势处理，这里保留以兼容旧机型")
    override fun onBackPressed() {
        web.evaluateJavascript("(function(){try{return window.mflBack?window.mflBack():false}catch(e){return false}})()") { v ->
            if (v != "true") {
                if (web.canGoBack()) web.goBack() else finish()
            }
        }
    }
}
