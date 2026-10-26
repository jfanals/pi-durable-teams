package dev.pi.agents

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val settings = Settings(this)
        setContent {
            MaterialTheme(colorScheme = if (isSystemInDarkTheme()) darkColorScheme() else lightColorScheme()) {
                Surface(Modifier.fillMaxSize()) { AgentsApp(settings) }
            }
        }
    }
}

@Composable
private fun AgentsApp(settings: Settings) {
    var connection by remember { mutableStateOf(settings.load()) }
    var showSettings by rememberSaveable { mutableStateOf(connection.serverUrl.isBlank()) }
    Column(Modifier.fillMaxSize().safeDrawingPadding().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Pi Agents", style = MaterialTheme.typography.headlineMedium)
        if (showSettings) {
            SettingsScreen(connection, onSave = {
                settings.save(it); connection = it; showSettings = false
            }, onCancel = if (connection.serverUrl.isNotBlank()) ({ showSettings = false }) else null)
        } else {
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Button(onClick = { showSettings = true }) { Text("Settings") }
            }
            AgentList(connection)
        }
    }
}

@Composable
private fun SettingsScreen(connection: ConnectionSettings, onSave: (ConnectionSettings) -> Unit, onCancel: (() -> Unit)?) {
    var pairing by rememberSaveable { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    Text("Connect to your host", style = MaterialTheme.typography.titleLarge)
    if (connection.serverUrl.isNotBlank()) Text(connection.serverUrl)
    OutlinedTextField(value = pairing, onValueChange = { pairing = it }, label = { Text("Pairing URL") },
        placeholder = { Text("https://host/?token=…") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
    error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
    Button(onClick = {
        try { onSave(ConnectionSettings.fromPairingUrl(pairing)) }
        catch (e: Exception) { error = e.message ?: "Invalid pairing URL" }
    }) { Text("Save and connect") }
    onCancel?.let { TextButton(onClick = it) { Text("Cancel") } }
}

@Composable
private fun AgentList(connection: ConnectionSettings) {
    var agents by remember(connection) { mutableStateOf<List<AgentSummary>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var refresh by remember { mutableIntStateOf(0) }
    LaunchedEffect(connection, refresh) {
        loading = true; error = null
        try { agents = ApiClient(connection.serverUrl, connection.token).list() }
        catch (e: CancellationException) { throw e }
        catch (e: Exception) { error = e.message ?: "Connection failed" }
        finally { loading = false }
    }
    Button(onClick = { refresh++ }, enabled = !loading) { Text("Refresh") }
    if (loading) Text("Connecting…")
    error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
    if (!loading && error == null && agents.isEmpty()) Text("No agents")
    LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        items(agents, key = { it.id }) { agent ->
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp)) {
                    Text(agent.name, style = MaterialTheme.typography.titleMedium)
                    Text(if (agent.running == true) "Running" else if (agent.enabled) "Idle" else "Stopped")
                }
            }
        }
    }
}
