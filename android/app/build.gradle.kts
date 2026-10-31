plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.mflixtv.app"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.mflixtv.app"
        // 0.13：往下兼容到 Android 7.0（API 24）。之前是 26，Android 7.x 的老机型直接装不上。
        minSdk = 24
        targetSdk = 34
        versionCode = 107
        versionName = "1.7"
        // 这里原来写着 abiFilters += listOf("arm64-v8a")，再加一份用不到的 jniLibs/arm64-v8a/libnode.so
        // （42 MB 的 nodejs-mobile 残留）。结果 API 里声明了 native-code: arm64-v8a，
        // 32 位机型、部分平板/盒子和 x86 设备不是装不上就是起来就崩。
        // 现在这条链路上没有任何 native 库，去掉限制 → 通用包，什么 ABI 都能装。
        vectorDrawables.useSupportLibrary = true
    }

    // 正式签名：keystore 只在本地，不进仓库。没有 keystore 时退回 debug 签名，保证还能出包。
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
