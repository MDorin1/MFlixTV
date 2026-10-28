package com.mflixtv.app

import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.ActivityInfo
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat

/**
 * MFlixTV 安卓端。
 *
 * 界面全部来自手机本机跑起来的服务（127.0.0.1:端口，默认 8080），局域网里别的设备访问
 * 「手机 IP:端口」看到的是同一套页面。这里只负责：起服务、全屏 WebView、
 * 播放时切横屏、返回键交给页面处理。
 *
 * 0.13 起「别的手机也能跑」是硬要求，所以这里的每一步都可能失败、也必须能兜住：
 *  - WebView 造不出来（ROM 没带 / 被禁用 / 系统 WebView 版本太老）→ 不再直接崩，给一屏提示 + 重试；
 *  - WebView 渲染进程被杀（低内存机型最常见，默认行为是整进程一起崩 = 用户看到的「闪退」）
 *    → onRenderProcessGone 里重建 WebView 重新加载；
 *  - 8080 被别的 App 占用 → 服务端自动换端口，这里跟着换成实际端口；
 *  - 服务还没起来 → 退避重试，重试到头再给失败页，不会卡在空白页。
 */
class MainActivity : AppCompatActivity() {
    private var web: WebView? = null
    private var fallback: View? = null
    private var retries = 0
    private var loadingUrl: String = ""

    /** 暴露给页面的原生能力（页面里用 MFlixNative.xxx 调）。 */
    inner class Bridge {
        @JavascriptInterface
        fun landscape(on: Boolean) {
            runOnUiThread {
                try {
                    requestedOrientation = if (on) ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
                    else ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
                    if (on) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                    else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                } catch (_: Throwable) {
                }
            }
        }

        @JavascriptInterface
        fun keepAwake(on: Boolean) {
            runOnUiThread {
                try {
                    if (on) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                    else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                } catch (_: Throwable) {
                }
            }
        }

        @JavascriptInterface
        fun toast(msg: String) {
            runOnUiThread {
                try {
                    Toast.makeText(this@MainActivity, msg, Toast.LENGTH_SHORT).show()
                } catch (_: Throwable) {
                }
            }
        }

        /** 是否已经进了电池优化白名单（进了就不会被后台清理）。 */
        @JavascriptInterface
        fun batteryOk(): Boolean {
            return try {
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true
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
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                        val pm = getSystemService(android.content.Context.POWER_SERVICE) as android.os.PowerManager
                        if (pm.isIgnoringBatteryOptimizations(packageName)) {
                            Toast.makeText(this@MainActivity, "已经允许后台常驻了", Toast.LENGTH_SHORT).show()
                            return@runOnUiThread
                        }
                    }
                    val i = Intent(
                        android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                        Uri.parse("package:$packageName")
                    )
                    startActivity(i)
                } catch (e: Throwable) {
                    try {
                        startActivity(Intent(android.provider.Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
                    } catch (_: Throwable) {
                        Toast.makeText(this@MainActivity, "请在系统设置里手动允许后台运行", Toast.LENGTH_LONG).show()
                    }
                }
            }
        }

        /** 页面想知道真正的端口（8080 被占时服务端会换端口）。 */
        @JavascriptInterface
        fun port(): Int {
            return ServerService.port
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        try {
            immersive()
        } catch (_: Throwable) {
        }

        // 容器先上屏：后面 WebView 出问题也只是这一层里换内容，不会整页垮掉
        try {
            setContentView(root)
        } catch (e: Throwable) {
            android.util.Log.e("MFlixTV", "setContentView failed", e)
        }

        // 先把服务拉起来（页面要连它），再建 WebView
        startServer()

        if (!openWeb()) {
            showFallback("这台手机的 WebView 用不了", webViewProblem())
        }

        // Android 13+ 通知要用户同意，否则通知栏看不到「局域网地址」那一条（服务本身照跑）
        if (Build.VERSION.SDK_INT >= 33) {
            try {
                requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 1001)
            } catch (_: Throwable) {
            }
        }
    }

    /** 起前台服务。Android 8+ 只能用 startForegroundService，低版本用 startService；全都加兜底。 */
    private fun startServer() {
        try {
            val svc = Intent(this, ServerService::class.java)
            ContextCompat.startForegroundService(this, svc)
        } catch (e: Throwable) {
            // Android 12+ 从后台起前台服务会被拒；这里退回普通 startService，服务里照样会 startForeground
            try {
                startService(Intent(this, ServerService::class.java))
            } catch (e2: Throwable) {
                android.util.Log.w("MFlixTV", "start service failed", e2)
            }
        }
    }

    private fun baseUrl(): String {
        return "http://127.0.0.1:" + ServerService.port + "/"
    }

    /** 造 WebView 并加载首页；任何一步抛异常都返回 false，交给失败页兜住，绝不整 App 崩。 */
    private fun openWeb(): Boolean {
        try {
            closeWeb()
            val w = WebView(this)
            w.setBackgroundColor(0xFF000000.toInt())
            applySettings(w)
            w.addJavascriptInterface(Bridge(), "MFlixNative")
            w.webViewClient = object : WebViewClient() {
                override fun onReceivedError(
                    view: WebView,
                    request: WebResourceRequest,
                    error: WebResourceError
                ) {
                    // 只处理主文档：子资源（海报、分片）失败不该触发整页重载
                    if (!request.isForMainFrame) return
                    retryLoad(view)
                }

                override fun onReceivedHttpError(
                    view: WebView,
                    request: WebResourceRequest,
                    errorResponse: android.webkit.WebResourceResponse
                ) {
                    if (!request.isForMainFrame) return
                    retryLoad(view)
                }

                /**
                 * 渲染进程被杀（低内存机型最常见）：默认行为是把整个 App 一起杀掉，
                 * 用户看到的就是「打开就闪退、反复闪退」。这里自己接住，重建一个接着用。
                 */
                override fun onRenderProcessGone(view: WebView?, detail: RenderProcessGoneDetail?): Boolean {
                    android.util.Log.w(
                        "MFlixTV",
                        "webview renderer gone" + (if (Build.VERSION.SDK_INT >= 26 && detail?.didCrash() == true) " crashed" else "")
                    )
                    try {
                        (view?.parent as? ViewGroup)?.removeView(view)
                        view?.destroy()
                    } catch (_: Throwable) {
                    }
                    web = null
                    root.postDelayed({ if (!openWeb()) showFallback("画面进程被系统回收了", webViewProblem()) }, 300)
                    return true
                }
            }
            w.webChromeClient = object : WebChromeClient() {
                override fun onPermissionRequest(request: android.webkit.PermissionRequest) {
                    try {
                        request.deny()
                    } catch (_: Throwable) {
                    }
                }
            }

            web = w
            root.removeAllViews()
            fallback = null
            root.addView(
                w,
                LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT
                )
            )
            retries = 0
            loadHome()
            return true
        } catch (e: Throwable) {
            android.util.Log.e("MFlixTV", "webview create failed", e)
            web = null
            return false
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun applySettings(w: WebView) {
        w.settings.apply {
            try {
                javaScriptEnabled = true
                domStorageEnabled = true
                mediaPlaybackRequiresUserGesture = false
                mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
                loadsImagesAutomatically = true
                cacheMode = WebSettings.LOAD_DEFAULT
                useWideViewPort = true
                loadWithOverviewMode = true
                textZoom = 100
                // 老机型省内存：关掉用不到的 WebSQL / 文件访问
                @Suppress("DEPRECATION")
                databaseEnabled = false
                allowFileAccess = false
                allowContentAccess = false
                javaScriptCanOpenWindowsAutomatically = false
                setSupportMultipleWindows(false)
            } catch (_: Throwable) {
            }
        }
    }

    /**
     * 服务刚起来那一下还没监听端口，直接 loadUrl 会吃一个连接被拒。
     * 这里退避重试：450ms、900ms、1.8s…最多 10 次，重试完给失败页（带「重试」按钮）。
     */
    private fun loadHome() {
        val w = web ?: return
        loadingUrl = baseUrl()
        val url = loadingUrl
        w.postDelayed({
            try {
                w.loadUrl(url)
            } catch (_: Throwable) {
            }
        }, if (retries == 0) 420L else 0L)
    }

    private fun retryLoad(view: WebView) {
        if (retries >= 10) {
            showFallback("连不上手机本机的服务", "服务没有在这个端口上监听（端口 " + ServerService.port + "）")
            return
        }
        retries++
        val delay = when (retries) {
            1 -> 500L
            2 -> 900L
            3 -> 1500L
            else -> 2200L
        }
        view.postDelayed({
            try {
                view.loadUrl(loadingUrl.ifEmpty { baseUrl() })
            } catch (_: Throwable) {
            }
        }, delay)
    }

    private fun webViewProblem(): String {
        val sb = StringBuilder()
        sb.append("这台设备 ").append(Build.MANUFACTURER).append(" ").append(Build.MODEL)
            .append("（Android ").append(Build.VERSION.RELEASE).append("）")
        if (Build.VERSION.SDK_INT >= 26) {
            try {
                val pkg = WebView.getCurrentWebViewPackage()
                if (pkg == null) {
                    sb.append(" 没有可用的系统 WebView。装一个「Android System WebView」或 Chrome 就能用。")
                } else {
                    sb.append(" 的 WebView 版本是 ").append(pkg.versionName).append("。")
                }
            } catch (_: Throwable) {
            }
        }
        return sb.toString()
    }

    /** 兜底页：不依赖 WebView，用最普通的原生控件画出来。 */
    private fun showFallback(title: String, detail: String) {
        try {
            val box = LinearLayout(this)
            box.orientation = LinearLayout.VERTICAL
            box.setBackgroundColor(Color.BLACK)
            box.gravity = Gravity.CENTER
            val pad = dp(24)
            box.setPadding(pad, pad, pad, pad)

            val t = TextView(this)
            t.text = "MFlixTV"
            t.setTextColor(Color.WHITE)
            t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 22f)
            t.gravity = Gravity.CENTER
            box.addView(t)

            val msg = TextView(this)
            msg.text = title + "\n\n" + detail
            msg.setTextColor(0xFFBBBBBB.toInt())
            msg.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
            msg.gravity = Gravity.CENTER
            msg.setPadding(0, dp(14), 0, dp(18))
            box.addView(msg)

            box.addView(
                button("重试") {
                    retries = 0
                    if (!openWeb()) showFallback(title, detail)
                }
            )
            box.addView(
                button("用手机浏览器打开") {
                    try {
                        startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(baseUrl())))
                    } catch (_: Throwable) {
                        Toast.makeText(this, "没有可用的浏览器", Toast.LENGTH_SHORT).show()
                    }
                }
            )
            box.addView(
                button("复制地址") {
                    try {
                        val cm = getSystemService(android.content.Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
                        cm.setPrimaryClip(android.content.ClipData.newPlainText("MFlixTV", baseUrl()))
                        Toast.makeText(this, "已复制 " + baseUrl(), Toast.LENGTH_SHORT).show()
                    } catch (_: Throwable) {
                    }
                }
            )

            root.removeAllViews()
            root.addView(
                box,
                LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT
                )
            )
            fallback = box
        } catch (_: Throwable) {
            // 连兜底页都画不出来就只能结束了，但至少不会一路崩
            try {
                finish()
            } catch (_: Throwable) {
            }
        }
    }

    private fun button(text: String, onClick: () -> Unit): Button {
        val b = Button(this)
        b.text = text
        b.isAllCaps = false
        val lp = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        )
        lp.topMargin = dp(10)
        b.layoutParams = lp
        b.setOnClickListener { onClick() }
        return b
    }

    private fun dp(v: Int): Int {
        return (v * resources.displayMetrics.density).toInt()
    }

    /** 根容器：Activity 里不用 XML，直接一个 LinearLayout 装 WebView / 兜底页。 */
    private val root: LinearLayout by lazy {
        val r = LinearLayout(this)
        r.orientation = LinearLayout.VERTICAL
        r.setBackgroundColor(Color.BLACK)
        r.layoutParams = ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        )
        r
    }

    private fun closeWeb() {
        val w = web ?: return
        try {
            (w.parent as? ViewGroup)?.removeView(w)
            w.stopLoading()
            w.destroy()
        } catch (_: Throwable) {
        }
        web = null
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
        if (hasFocus) {
            try {
                immersive()
            } catch (_: Throwable) {
            }
        }
    }

    @Deprecated("Android 13 起由系统手势处理，这里保留以兼容旧机型")
    override fun onBackPressed() {
        val w = web
        if (w == null) {
            super.onBackPressed()
            return
        }
        try {
            w.evaluateJavascript(
                "(function(){try{return window.mflBack?window.mflBack():false}catch(e){return false}})()"
            ) { v ->
                if (v != "true") {
                    if (w.canGoBack()) w.goBack() else finish()
                }
            }
        } catch (_: Throwable) {
            finish()
        }
    }

    override fun onDestroy() {
        closeWeb()
        super.onDestroy()
    }
}
