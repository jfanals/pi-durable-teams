plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.compose.compiler)
    alias(libs.plugins.kotlin.serialization)
}
android {
    namespace = "dev.pi.agents"
    compileSdk = 35
    defaultConfig {
        applicationId = "dev.pi.agents"
        minSdk = 29
        targetSdk = 35
        versionCode = 1
        versionName = "0.1"
    }
    buildFeatures { compose = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
dependencies {
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.material3)
    implementation(libs.activity.compose)
    implementation(libs.serialization.json)
    implementation(libs.coroutines.android)
    implementation(libs.okhttp)
    implementation("androidx.lifecycle:lifecycle-viewmodel-ktx:2.8.7")
    implementation("com.mikepenz:multiplatform-markdown-renderer-m3:0.30.0")
    testImplementation(libs.junit)
    testImplementation(libs.mockwebserver)
}
