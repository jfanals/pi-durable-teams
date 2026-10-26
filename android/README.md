# Pi Agents Android groundwork
Requires JDK 17 and Android SDK platform 35; run these from `android/`.
Set `ANDROID_HOME` or write `sdk.dir=/your/sdk/path` to ignored `local.properties`.
Build and JVM tests: `./gradlew test assembleDebug`.
Install: `adb -s emulator-5554 install -r app/build/outputs/apk/debug/app-debug.apk`.
Launch: `adb -s emulator-5554 shell am start -n dev.pi.agents/.MainActivity`.
Local host bridge: `adb -s emulator-5554 reverse tcp:7799 tcp:7799`.
In Settings paste `https://host/?token=TOKEN` (local test: `http://127.0.0.1:7799/?token=test-token`).
Cleartext is allowed only for localhost/127.0.0.1; credentials stay in private, non-backed-up preferences.
Screens are plain Compose state; API flows are cold/cancellable, with no retry/reconnect policy yet.
