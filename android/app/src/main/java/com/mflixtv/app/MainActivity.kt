package com.mflixtv.app

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.TypedValue
import android.view.Gravity
import android.view.KeyEvent
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

    /** 电视模式：Leanback 盒子 / UI_MODE_TYPE_TELEVISION / 没有触摸屏，或启动时 --ez tv true 手动指定 */
    private var tvMode = false

    /** HTML5 全屏（WebView 交过来的自定义视图）——页面里 <video> 自带的全屏按钮也走这条路 */
    private var fullView: View? = null
    private var fullCb: WebChromeClient.CustomViewCallback? = null
    private var chrome: WebChromeClient? = null

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

        /**
         * 原生全屏（0.16）：页面右下角那个「全屏」键走这里。
         *
         * 以前页面调的是 HTML5 的 `requestFullscreen()`，而 WebView 只有在
         * WebChromeClient 实现了 onShowCustomView 时才会真的进全屏 —— 没实现就什么都不发生，
         * 用户只看到一句「这台设备的 WebView 不支持系统全屏」，也没转横屏，等于按钮是废的。
         * 现在真效果 = 转横屏 + 隐藏状态栏 / 导航栏 + 屏幕常亮，退出再还原。
         */
        @JavascriptInterface
        fun fullscreen(on: Boolean) {
            runOnUiThread {
                try {
                    requestedOrientation = if (on) ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
                    else ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
                    if (on) {
                        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                        immersive()
                    } else {
                        window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                        immersive()
                    }
                } catch (_: Throwable) {
                }
            }
        }

        /** 现在是不是横着的（页面据此给「全屏 / 旋转」键打高亮，不用自己猜）。 */
        @JavascriptInterface
        fun wide(): Boolean {
            return try {
                resources.configuration.orientation == android.content.res.Configuration.ORIENTATION_LANDSCAPE
            } catch (_: Throwable) {
                false
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

        /** 是不是电视版：页面据此换 10 英尺界面。 */
        @JavascriptInterface
        fun tv(): Boolean {
            return tvMode
        }

        /**
         * 电视版由原生注入按键（见 dispatchKeyEvent）。页面拿到 true 就不再自己听 keydown，
         * 免得一次按键动两格。
         */
        @JavascriptInterface
        fun tvKeys(): Boolean {
            return tvMode
        }

        /** 调试 / 外部触发用：往页面塞一个遥控器动作。up down left right ok back menu */
        @JavascriptInterface
        fun key(action: String) {
            runOnUiThread { sendKey(action) }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        try {
            immersive()
        } catch (_: Throwable) {
        }

        // 电视 / 盒子：锁横屏 + 屏幕常亮，页面走 /tv（10 英尺界面，遥控器导航）
        tvMode = try {
            intent?.getBooleanExtra("tv", false) == true || detectTv()
        } catch (_: Throwable) {
            false
        }
        if (tvMode) {
            try {
                requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
                window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            } catch (_: Throwable) {
            }
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

    /** 电视版进 /tv，手机进 /（同一个服务，同一份源，两套界面）。 */
    private fun pageUrl(): String {
        return baseUrl() + (if (tvMode) "tv" else "")
    }

    /** 判定这台设备是不是电视 / 盒子。 */
    private fun detectTv(): Boolean {
        return try {
            val ui = getSystemService(Context.UI_MODE_SERVICE) as? android.app.UiModeManager
            if (ui != null && ui.currentModeType == android.content.res.Configuration.UI_MODE_TYPE_TELEVISION) return true
            val pm = packageManager
            if (pm.hasSystemFeature(PackageManager.FEATURE_LEANBACK)) return true
            !pm.hasSystemFeature(PackageManager.FEATURE_TOUCHSCREEN) &&
                !pm.hasSystemFeature(PackageManager.FEATURE_FAKETOUCH)
        } catch (e: Throwable) {
            false
        }
    }

    /** 把遥控器动作转给页面（页面里的 window.mflTvKey）。 */
    private fun sendKey(action: String) {
        val w = web ?: return
        try {
            w.evaluateJavascript("window.mflTvKey&&window.mflTvKey('" + action + "')", null)
        } catch (_: Throwable) {
        }
    }

    /**
     * 电视上方向键 / 确定键不交给 WebView（它会拿去滚页面，焦点会乱跳），
     * 由这里统一翻译成动作再注入页面：一次按键只动一格。
     * BACK 不拦，交给 onBackPressed（页面能处理就先处理，处理不了才退出）。
     */
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (!tvMode) return super.dispatchKeyEvent(event)
        val action = when (event.keyCode) {
            KeyEvent.KEYCODE_DPAD_UP -> "up"
            KeyEvent.KEYCODE_DPAD_DOWN -> "down"
            KeyEvent.KEYCODE_DPAD_LEFT -> "left"
            KeyEvent.KEYCODE_DPAD_RIGHT -> "right"
            KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER,
            KeyEvent.KEYCODE_NUMPAD_ENTER, KeyEvent.KEYCODE_BUTTON_A -> "ok"
            KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, KeyEvent.KEYCODE_MEDIA_PLAY -> "ok"
            KeyEvent.KEYCODE_MENU -> "menu"
            else -> null
        }
        if (action == null) return super.dispatchKeyEvent(event)
        if (event.action == KeyEvent.ACTION_DOWN) sendKey(action)
        return true
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

                /**
                 * 页面里真的调 requestFullscreen() 时（比如 <video> 自带的那个全屏键），
                 * WebView 把渲染好的视图交过来——以前这里没实现，所以请求被静静吞掉。
                 * 现在接住：铺满整屏 + 转横屏，退出时还原。
                 */
                override fun onShowCustomView(view: View, callback: WebChromeClient.CustomViewCallback) {
                    if (fullView != null) {
                        try { callback.onCustomViewHidden() } catch (_: Throwable) {}
                        return
                    }
                    fullView = view
                    fullCb = callback
                    try {
                        requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
                        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                        immersive()
                        web?.visibility = View.GONE
                        root.addView(
                            view,
                            LinearLayout.LayoutParams(
                                ViewGroup.LayoutParams.MATCH_PARENT,
                                ViewGroup.LayoutParams.MATCH_PARENT
                            )
                        )
                    } catch (_: Throwable) {
                    }
                }

                override fun onHideCustomView() {
                    val v = fullView
                    fullView = null
                    try { if (v != null) (v.parent as? ViewGroup)?.removeView(v) } catch (_: Throwable) {}
                    try { fullCb?.onCustomViewHidden() } catch (_: Throwable) {}
                    fullCb = null
                    runOnUiThread {
                        try {
                            web?.visibility = View.VISIBLE
                            requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
                            window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                            immersive()
                        } catch (_: Throwable) {
                        }
                    }
                }
            }

            chrome = w.webChromeClient
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
        loadingUrl = pageUrl()
        val url = loadingUrl
        w.postDelayed({
            try {
                w.loadUrl(url)
            } catch (_: Throwable) {
            }
        }, if (retries == 0) 700L else 0L)
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
                // 每次重试都重新读端口：8080 被占时服务端可能已经换到 8081，
                // 沿用第一次那个地址会一直打在错的端口上（表现就是永远白屏）。
                loadingUrl = pageUrl()
                view.loadUrl(loadingUrl)
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
        try { if (fullView != null) chrome?.onHideCustomView() } catch (_: Throwable) {}
        fullView = null
        fullCb = null
        chrome = null
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

    override fun onConfigurationChanged(newConfig: android.content.res.Configuration) {
        super.onConfigurationChanged(newConfig)
        // 横竖屏切换后系统栏会自己回来，这里重新收一次
        try {
            immersive()
        } catch (_: Throwable) {
        }
    }

    @Deprecated("Android 13 起由系统手势处理，这里保留以兼容旧机型")
    override fun onBackPressed() {
        // 电视：返回键先给页面（退全屏 / 退详情 / 退搜索），页面说没得退才落回系统
        if (tvMode) {
            val tv = web
            if (tv == null) {
                super.onBackPressed()
                return
            }
            try {
                tv.evaluateJavascript(
                    "(function(){try{return window.mflTvKey?window.mflTvKey('back'):false}catch(e){return false}})()"
                ) { v ->
                    if (v != "true") {
                        if (tv.canGoBack()) tv.goBack() else finish()
                    }
                }
                return
            } catch (_: Throwable) {
                super.onBackPressed()
                return
            }
        }
        // 正在 HTML5 全屏：返回键先退全屏，不要直接退到桌面
        if (fullView != null) {
            try {
                chrome?.onHideCustomView()
            } catch (_: Throwable) {
            }
            return
        }
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
