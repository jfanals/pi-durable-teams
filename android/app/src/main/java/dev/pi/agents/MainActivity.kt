package dev.pi.agents

import android.Manifest
import android.content.Intent
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.SystemBarStyle
import androidx.activity.viewModels
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.material3.*

class MainActivity : ComponentActivity() {
    private val state: AppState by viewModels()
    private val permission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) WatchService.enable(this) else { state.settings.notify = false; state.error.value = "Notification permission denied. Enable it in Android settings." }
    }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge(statusBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT), navigationBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT))
        if (savedInstanceState == null) accept(intent)
        state.settings.notify = WatchService.running
        setContent { MaterialTheme(colorScheme = darkColorScheme()) { Surface { AgentsApp(state, ::notifications) } } }
    }
    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); setIntent(intent); accept(intent) }
    private fun accept(intent: Intent) {
        intent.dataString?.let { url ->
            try {
                val parsed = ConnectionSettings.fromPairingUrl(url)
                state.pairingUrl.value = "${parsed.serverUrl}/?token=${java.net.URLEncoder.encode(parsed.token, "UTF-8")}"
                state.pairingConfirmation.value = parsed
                state.navigate("settings")
            }
            catch (e: Exception) { state.error.value = e.message; state.navigate("settings") }
        }
        intent.getStringExtra("agent")?.let { state.open(it) }
    }
    private fun notifications(enabled: Boolean) {
        state.settings.notify = enabled
        if (!enabled) stopService(Intent(this, WatchService::class.java))
        else if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) permission.launch(Manifest.permission.POST_NOTIFICATIONS)
        else WatchService.enable(this)
    }
    override fun onStart() { super.onStart(); state.foreground(true) }
    override fun onStop() { state.foreground(false); super.onStop() }
}
