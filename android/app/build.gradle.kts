plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.mflixtv.app"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.mflixtv.app"
        minSdk = 26
        targetSdk = 34
        versionCode = 7
        versionName = "0.7"
        ndk { abiFilters += listOf("arm64-v8a") }
    }

    // 正式签名（keystore 只在本地，不进仓库）。没有 keystore 时退回 debug 签名，保证还能出包。
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
