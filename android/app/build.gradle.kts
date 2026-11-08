plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.mflixtv.app"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.mflixtv.app"
        // 0.13锛氬線涓嬪吋瀹瑰埌 Android 7.0锛圓PI 24锛夈€備箣鍓嶆槸 26锛孉ndroid 7.x 鐨勮€佹満鍨嬬洿鎺ヨ涓嶄笂銆?
        minSdk = 24
        targetSdk = 34
        versionCode = 134
        versionName = "1.23"
        // 杩欓噷鍘熸潵鍐欑潃 abiFilters += listOf("arm64-v8a")锛屽啀鍔犱竴浠界敤涓嶅埌鐨?jniLibs/arm64-v8a/libnode.so
        // 锛?2 MB 鐨?nodejs-mobile 娈嬬暀锛夈€傜粨鏋?API 閲屽０鏄庝簡 native-code: arm64-v8a锛?
        // 32 浣嶆満鍨嬨€侀儴鍒嗗钩鏉?鐩掑瓙鍜?x86 璁惧涓嶆槸瑁呬笉涓婂氨鏄捣鏉ュ氨宕┿€?
        // 鐜板湪杩欐潯閾捐矾涓婃病鏈変换浣?native 搴擄紝鍘绘帀闄愬埗 鈫?閫氱敤鍖咃紝浠€涔?ABI 閮借兘瑁呫€?
        vectorDrawables.useSupportLibrary = true
    }

    // 姝ｅ紡绛惧悕锛歬eystore 鍙湪鏈湴锛屼笉杩涗粨搴撱€傛病鏈?keystore 鏃堕€€鍥?debug 绛惧悕锛屼繚璇佽繕鑳藉嚭鍖呫€?
    val ksFile = rootProject.file("keystore/mflixtv.jks")
    if (ksFile.exists()) {
        signingConfigs {
            create("release") {
                storeFile = ksFile
                storePassword = "MFlixTV"
                keyAlias = "mflixtv"
                keyPassword = "MFlixTV"
                enableV1Signing = true
                enableV2Signing = true
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("release")
        }
        debug {
            applicationIdSuffix = ".debug"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("org.nanohttpd:nanohttpd:2.3.1")
    testImplementation("junit:junit:4.13.2")
}
