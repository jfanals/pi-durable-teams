# Pi Agents for Android

Native Compose client for the same host API as the terminal and web app: live agents, transcripts, send/steer/stop, agent creation, remote folder browsing, rename, model/thinking, and optional finish notifications.

## Install on a phone

1. Install JDK 17 and Android SDK platform 35. Set `JAVA_HOME` and `ANDROID_HOME` (or put `sdk.dir=/your/sdk/path` in ignored `local.properties`).
2. Enable Developer options → USB debugging on the phone, connect USB, and approve the computer.
3. From `android/`, run:
   ```sh
   ./gradlew test assembleDebug
   ./gradlew installDebug
   ```
   Alternatively share `app/build/outputs/apk/debug/app-debug.apk` with the phone and approve installation from that source. This is a development-signed APK.
4. On the computer configure the host's `remote.port`, restart it, then run `pi-agents pair`. Follow its Tailscale Serve instructions; connect the phone to the same tailnet.
5. Open Pi Agents → Settings and paste the entire pairing URL. Tap **Save and connect**, then confirm the host. Treat that URL as a password. After token rotation, pair again.

HTTPS URLs can be pasted directly. A QR scanner/browser can also open `piagents://pair?url=<URL-encoded-pairing-URL>`. Arbitrary tailnet HTTPS domains are intentionally not claimed by an Android intent filter; a normal HTTPS pairing QR opens the web app, and its URL can be pasted here.

Pairing intents prefill Settings and ask for confirmation; they never replace credentials silently.

Credentials stay in private preferences with `allowBackup=false`; explicit Android 12+ `dataExtractionRules` (including OEM device-transfer exclusions) remain a known gap. Cleartext HTTP is allowed only for localhost/127.0.0.1 development connections.

## Notifications

In Settings enable **Notify when agents finish** and grant Android's notification permission. A low-importance **Watching agents** foreground service keeps a separate roster subscription alive in the background. Only top-level agents transitioning from running to idle trigger alerts; tapping one opens its chat. Disable the setting to stop the service. The watcher is sticky after process death; if it is not running when the app starts, the switch is off. Android 15 limits data-sync foreground services to six hours per day; at that limit the watcher stops and must be enabled again. Normal app subscriptions stop when the activity goes into the background.

## Emulator verification

From the repository root:

```sh
node scripts/dev-host.ts 8790
# In another terminal:
adb -s emulator-5554 reverse tcp:8790 tcp:8790
cd android
./gradlew installDebug
adb -s emulator-5554 shell am start -n dev.pi.agents/.MainActivity
```

Paste the printed localhost pairing URL in Settings. For an intent, URL-encode that URL inside `piagents://pair?url=…` and use `adb shell am start -a android.intent.action.VIEW -d '<link>' dev.pi.agents`. The faux host accepts `SLOW` (working/Stop), `READ` (tool), and `DELEGATE` (sub-agent; use a fresh parent or rename the existing reader before delegating again).

Verified on emulator-5554 with JVM tests and `assembleDebug`. Review-fix screenshots: `/tmp/m3f-pair.png`, `/tmp/m3f-model-medium.png`, `/tmp/m3f-chat-final.png`, `/tmp/m3f-list-rotated.png`, `/tmp/m3f-reconnecting.png`. Earlier screenshots: `/tmp/android-list.png`, `/tmp/android-chat.png`, `/tmp/android-chat-thinking.png`, `/tmp/android-slow.png`, `/tmp/android-delegate.png`, `/tmp/android-new.png`, `/tmp/android-folders.png`, `/tmp/android-settings.png`, `/tmp/android-notification.png`.

## Code map

- `Api.kt`: exact ordered ChatItem contract, cancellable OkHttp calls/NDJSON streams.
- `AppState.kt`: one shared app roster, open-chat watch/refetch, pagination, backoff and errors.
- `Screens.kt`: Material 3 list/chat/new/settings; screen-local drafts only.
- `Format.kt`: presentation formatters, name validation and pure finish detector.
- `WatchService.kt`: optional Android foreground watcher and notifications.

Uses Compose BOM 2025.04.01 (SDK 35), lifecycle-viewmodel-ktx 2.8.7 and Mike Penz multiplatform-markdown-renderer-m3 0.30.0, alongside the skeleton's OkHttp 4.12.0 and kotlinx.serialization 1.9.0. No DI, database, WebView or notification polling.
