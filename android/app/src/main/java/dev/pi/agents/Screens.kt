package dev.pi.agents

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.interaction.collectIsDraggedAsState
import androidx.compose.foundation.lazy.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.UriHandler
import java.net.URI
import androidx.compose.ui.Alignment
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.mikepenz.markdown.m3.Markdown
import kotlinx.coroutines.*

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AgentsApp(state: AppState, notifications: (Boolean) -> Unit) {
    val screen by state.screen.collectAsState()
    val agents by state.agents.collectAsState()
    val target by state.target.collectAsState()
    val error by state.error.collectAsState()
    val reconnecting by state.reconnecting.collectAsState()
    val busy by state.busy.collectAsState()
    val all = flatten(agents)
    val agent = all.find { it.id == target }
    var menu by remember { mutableStateOf(false) }
    var dialog by remember { mutableStateOf<String?>(null) }
    var rename by remember { mutableStateOf("") }
    val stack = state.backStack
    fun open(id: String) { target?.let { stack.add(it) }; state.open(id) }
    fun back() {
        if (screen == "chat" && stack.isNotEmpty()) state.open(stack.removeAt(stack.lastIndex))
        else state.navigate("list")
    }
    BackHandler(screen != "list") { back() }
    Scaffold(
        topBar = { TopAppBar(title = { Column {
            Text(when (screen) { "chat" -> agent?.name ?: "Agent"; "new" -> "New agent"; "settings" -> "Settings"; else -> "Pi Agents" }, maxLines = 1)
            if (screen == "chat" && agent != null) Text(statusWord(agent), style = MaterialTheme.typography.labelSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
        } }, navigationIcon = { if (screen != "list") TextButton(onClick = { back() }) { Text("‹ Back") } }, actions = {
            if (screen == "list") TextButton(onClick = { state.navigate("settings") }) { Text("Settings") }
            if (screen == "chat") Box {
                TextButton(onClick = { menu = true }) { Text("⋮") }
                DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                    DropdownMenuItem(text = { Text("Rename") }, enabled = agent?.hosted == true, onClick = { rename = agent?.name.orEmpty(); dialog = "rename"; menu = false })
                    DropdownMenuItem(text = { Text("Model & thinking") }, enabled = agent?.hosted == true, onClick = { state.loadModels(); dialog = "model"; menu = false })
                    DropdownMenuItem(text = { Text("Disable agent") }, onClick = { dialog = "disable"; menu = false })
                }
            }
        }) },
        floatingActionButton = { if (screen == "list") FloatingActionButton(onClick = { state.navigate("new"); state.loadModels() }) { Text("+ New") } }
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).imePadding()) {
            if (reconnecting && screen != "settings") Text("Reconnecting to host…", Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.secondaryContainer).padding(8.dp))
            error?.let { Row(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.errorContainer).padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(it, Modifier.weight(1f), color = MaterialTheme.colorScheme.onErrorContainer)
                TextButton(onClick = { state.error.value = null }) { Text("Dismiss") }
            } }
            when (screen) {
                "settings" -> SettingsScreen(state, notifications)
                "new" -> NewAgentScreen(state, agents, busy)
                "chat" -> ChatScreen(state, agent, busy, ::open)
                else -> AgentList(agents, { stack.clear(); state.open(it) })
            }
        }
    }
    when (dialog) {
        "disable" -> AlertDialog(onDismissRequest = { dialog = null }, title = { Text("Disable ${agent?.name}?") }, text = { Text("Stops this agent and its sub-agents. Its transcript remains available.") }, confirmButton = { TextButton(onClick = { target?.let { id -> state.action { disable(id) } }; dialog = null }) { Text("Disable") } }, dismissButton = { TextButton(onClick = { dialog = null }) { Text("Cancel") } })
        "rename" -> {
            val siblings = all.find { it.children.any { c -> c.id == target } }?.children ?: agents
            val issue = agentNameError(rename.trim()) ?: if (siblings.any { it.hosted && it.id != target && it.name == rename.trim() }) "Name already exists" else null
            AlertDialog(onDismissRequest = { dialog = null }, title = { Text("Rename agent") }, text = { Column { OutlinedTextField(rename, { rename = it }, label = { Text("Name") }, singleLine = true); issue?.let { Text(it, color = MaterialTheme.colorScheme.error) } } }, confirmButton = { TextButton(enabled = issue == null && !busy, onClick = { target?.let { id -> state.action { rename(id, rename.trim()) } }; dialog = null }) { Text("Save") } }, dismissButton = { TextButton(onClick = { dialog = null }) { Text("Cancel") } })
        }
        "model" -> {
            val models by state.models.collectAsState()
            var choice by remember { mutableStateOf<ModelChoice?>(null) }
            val selected = choice ?: models.find { it.provider == agent?.provider && it.modelId == agent?.modelId }
            var thinking by remember { mutableStateOf(agent?.thinking ?: "off") }
            AlertDialog(onDismissRequest = { dialog = null }, title = { Text("Model & thinking") }, text = { Column { ModelPicker(state, selected, thinking, { choice = it; thinking = defaultThinking(it) }, { thinking = it }) } }, confirmButton = { TextButton(enabled = selected != null && !busy, onClick = { target?.let { id -> selected?.let { m -> state.action { setModel(id, m.provider, m.modelId, thinking) } } }; dialog = null }) { Text("Save") } }, dismissButton = { TextButton(onClick = { dialog = null }) { Text("Cancel") } })
        }
    }
}

@Composable
private fun AgentList(agents: List<AgentSummary>, open: (String) -> Unit) {
    var showOffline by rememberSaveable { mutableStateOf(false) }
    var now by remember { mutableDoubleStateOf(System.currentTimeMillis().toDouble()) }
    LaunchedEffect(Unit) { while (true) { delay(1000); now = System.currentTimeMillis().toDouble() } }
    val rows = mutableListOf<Pair<AgentSummary, Int>>()
    fun visit(list: List<AgentSummary>, depth: Int) { list.forEach { a -> if (showOffline || !offline(a)) { rows.add(a to depth); visit(a.children, depth + 1) } else visit(a.children, depth) } }
    visit(agents, 0)
    val offlineCount = agents.count(::offline)
    val running = agents.count { it.running == true }
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) { Text("Show offline Pi sessions", Modifier.weight(1f)); Switch(showOffline, { showOffline = it }) }
        Text("$running running · ${agents.size - running - offlineCount} idle · $offlineCount offline · total ${formatCost(flatten(agents).sumOf { it.cost ?: 0.0 }).ifBlank { "$0.000" }}", Modifier.padding(16.dp, 8.dp), style = MaterialTheme.typography.labelMedium)
        LazyColumn(Modifier.weight(1f), contentPadding = PaddingValues(bottom = 96.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            if (rows.isEmpty()) item { Text("No agents yet. Create one to get started.", Modifier.padding(24.dp)) }
            items(rows, key = { it.first.id }) { (a, depth) ->
                Card(onClick = { open(a.id) }, modifier = Modifier.fillMaxWidth().padding(start = (12 + depth * 18).dp, end = 12.dp)) {
                    Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(if (a.running == true) "● " else "○ ", color = if (a.running == true) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outline)
                            Text(a.name + if (!a.hosted) " (Pi)" else "", style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                            Text(displayStatus(a), style = MaterialTheme.typography.labelSmall, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 145.dp))
                        }
                        val time = if (a.running == true) a.since?.let { formatDuration(now - it) } else a.finishedAt?.let { formatAgo(now - it) }
                        Text(listOfNotNull(a.model, a.thinking, time, formatContext(a).takeIf { it.isNotBlank() }, formatCost(a.cost).takeIf { it.isNotBlank() }?.let { it + if (a.subscription == true) " (sub)" else "" }).joinToString(" · "), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        }
    }
}

@Composable
private fun SettingsScreen(state: AppState, notifications: (Boolean) -> Unit) {
    val pairing by state.pairingUrl.collectAsState()
    val confirmation by state.pairingConfirmation.collectAsState()
    var notify by remember { mutableStateOf(state.settings.notify) }
    confirmation?.let { connection ->
        AlertDialog(onDismissRequest = { state.pairingConfirmation.value = null },
            title = { Text("Connect to ${URI(connection.serverUrl).authority}?") },
            text = { Text("This host will receive your messages and pairing token.") },
            confirmButton = { TextButton(onClick = {
                state.settings.save(connection); state.pairingConfirmation.value = null
                state.connect(); state.error.value = null; state.navigate("list")
                if (notify) notifications(true)
            }) { Text("Connect") } },
            dismissButton = { TextButton(onClick = { state.pairingConfirmation.value = null }) { Text("Cancel") } })
    }
    Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Text("Connect to your host", style = MaterialTheme.typography.titleLarge)
        Text(state.settings.load().serverUrl.ifBlank { "Run pi-agents pair on your computer, then paste its pairing URL." })
        OutlinedTextField(pairing, { state.pairingUrl.value = it }, label = { Text("Pairing URL") }, placeholder = { Text("https://host/?token=…") }, modifier = Modifier.fillMaxWidth(), maxLines = 4)
        Button(onClick = {
            try { state.pairingConfirmation.value = ConnectionSettings.fromPairingUrl(pairing) }
            catch (e: Exception) { state.error.value = e.message }
        }) { Text("Save and connect") }
        HorizontalDivider()
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Notify when agents finish", Modifier.weight(1f))
            Switch(notify, { notify = it; notifications(it) }, enabled = state.settings.load().serverUrl.isNotBlank())
        }
        Text("Keeps a low-priority ‘Watching agents’ notification while watching. Only top-level agents notify when they finish.", style = MaterialTheme.typography.bodySmall)
    }
}

@Composable
private fun ChatScreen(state: AppState, agent: AgentSummary?, busy: Boolean, open: (String) -> Unit) {
    val transcript by state.items.collectAsState()
    val next by state.next.collectAsState()
    var message by rememberSaveable(agent?.id) { mutableStateOf("") }
    var steer by rememberSaveable { mutableStateOf(false) }
    var now by remember { mutableDoubleStateOf(System.currentTimeMillis().toDouble()) }
    val list = rememberLazyListState()
    val scope = rememberCoroutineScope()
    val results = remember(transcript) { transcript.filterIsInstance<ChatItem.Result>().associateBy { it.callId } }
    val atBottom by remember { derivedStateOf { !list.canScrollForward } }
    var follow by remember { mutableStateOf(true) }
    val dragging by list.interactionSource.collectIsDraggedAsState()
    LaunchedEffect(list) { snapshotFlow { list.canScrollForward to dragging }.collect { (forward, dragged) ->
        if (!forward) follow = true else if (dragged) follow = false
    } }
    LaunchedEffect(transcript, agent?.running, follow) { if (follow && transcript.isNotEmpty()) list.animateScrollToItem(transcript.count { it !is ChatItem.Result && it !is ChatItem.Unknown } + if (next != null) 1 else 0) }
    LaunchedEffect(agent?.running) { while (agent?.running == true) { now = System.currentTimeMillis().toDouble(); delay(1000) } }
    Column(Modifier.fillMaxSize()) {
        if (!agent?.children.isNullOrEmpty()) Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            agent!!.children.forEach { child -> AssistChip(onClick = { open(child.id) }, label = { Text("${if (child.running == true) "● " else ""}${child.name}") }) }
        }
        LazyColumn(state = list, modifier = Modifier.weight(1f), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            if (next != null) item(key = "older") { TextButton(onClick = { follow = false; state.older() }, enabled = !busy) { Text("Load older") } }
            items(transcript.filterNot { it is ChatItem.Result || it is ChatItem.Unknown }, key = { it.id }) { item ->
                when (item) {
                    is ChatItem.Input -> Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) { Surface(color = MaterialTheme.colorScheme.secondaryContainer, shape = MaterialTheme.shapes.medium, modifier = Modifier.widthIn(max = 340.dp)) { Column(Modifier.padding(12.dp)) { Text(item.from + if (item.report == true) " · report" else "", style = MaterialTheme.typography.labelSmall); SafeMarkdown(item.text) } } }
                    is ChatItem.Notice -> Text(item.text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    is ChatItem.Reply -> Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        item.parts.forEachIndexed { index, part ->
                            when (part) {
                                is ChatPart.Text -> SafeMarkdown(part.text)
                                is ChatPart.Thinking -> {
                                    var expanded by rememberSaveable(item.id, index) { mutableStateOf(false) }
                                    Column { TextButton(onClick = { expanded = !expanded }, contentPadding = PaddingValues(0.dp)) { Text(if (expanded) "▾ Thinking" else "▸ Thinking") }; if (expanded) Text(part.text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                                }
                                is ChatPart.Unknown -> Unit
                                is ChatPart.Tool -> {
                                    val result = results[part.id]
                                    Surface(color = MaterialTheme.colorScheme.surfaceContainer, shape = MaterialTheme.shapes.small) { Column(Modifier.fillMaxWidth().padding(10.dp)) {
                                        Text("${when (result?.ok) { true -> "✓"; false -> "✗"; null -> "…" }} ${part.name}  ${part.subject}", fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall)
                                        result?.error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
                                    } }
                                }
                            }
                        }
                        item.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                        item.turn?.let { Text(listOfNotNull(it.ms?.let(::formatDuration), "${formatTokens(it.tokens)} tokens", formatCost(it.cost).takeIf(String::isNotBlank)).joinToString(" · "), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.outline) }
                    }
                    else -> Unit
                }
            }
            item(key = "working") { if (agent?.running == true) Row(verticalAlignment = Alignment.CenterVertically) {
                CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp); Spacer(Modifier.width(8.dp)); Text("${agent.activity ?: "Working"} · ${formatDuration(now - (agent.since ?: now))}", style = MaterialTheme.typography.bodySmall)
            } }
        }
        if (!atBottom) TextButton(onClick = { follow = true; scope.launch { list.animateScrollToItem(list.layoutInfo.totalItemsCount - 1) } }, modifier = Modifier.align(Alignment.CenterHorizontally)) { Text("↓ Latest") }
        Text(formatUsage(agent), Modifier.padding(horizontal = 12.dp), style = MaterialTheme.typography.labelSmall)
        HorizontalDivider()
        Column(Modifier.padding(horizontal = 12.dp, vertical = 6.dp)) {
            OutlinedTextField(message, { message = it }, placeholder = { Text("Message ${agent?.name ?: "agent"}…") }, modifier = Modifier.fillMaxWidth(), maxLines = 5)
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Checkbox(steer, { steer = it }); Text("Steer", Modifier.weight(1f), style = MaterialTheme.typography.labelMedium)
                if (agent?.running == true) OutlinedButton(onClick = { state.action { stop(agent.id) } }, enabled = !busy) { Text("Stop") }
                Button(enabled = message.isNotBlank() && !busy && agent?.enabled == true, onClick = {
                    val text = message; val id = agent?.id ?: return@Button
                    state.action { send(id, text, if (steer) "steer" else "followUp"); message = ""; follow = true; scope.launch { list.scrollToItem((list.layoutInfo.totalItemsCount - 1).coerceAtLeast(0)) } }
                }) { Text("Send") }
            }
        }
    }
}

@Composable
private fun ModelPicker(state: AppState, selected: ModelChoice?, thinking: String, select: (ModelChoice) -> Unit, think: (String) -> Unit) {
    val models by state.models.collectAsState()
    var expanded by remember { mutableStateOf(false) }
    var levels by remember { mutableStateOf(false) }
    Box { OutlinedButton(onClick = { expanded = true }) { Text(selected?.let { "${it.provider}/${it.modelId}" } ?: "Select model") }; DropdownMenu(expanded, { expanded = false }, Modifier.heightIn(max = 300.dp)) {
        models.forEach { m -> DropdownMenuItem(text = { Text("${m.provider}/${m.modelId}") }, onClick = { select(m); expanded = false }) }
        if (models.isEmpty()) DropdownMenuItem(text = { Text("No models available") }, onClick = {})
    } }
    Box { OutlinedButton(enabled = selected != null, onClick = { levels = true }) { Text("Thinking: $thinking") }; DropdownMenu(levels, { levels = false }) { selected?.thinkingLevels?.forEach { level -> DropdownMenuItem(text = { Text(level) }, onClick = { think(level); levels = false }) } } }
}

@Composable
private fun NewAgentScreen(state: AppState, agents: List<AgentSummary>, busy: Boolean) {
    var name by rememberSaveable { mutableStateOf("") }
    var cwd by rememberSaveable { mutableStateOf("") }
    var selected by remember { mutableStateOf<ModelChoice?>(null) }
    var thinking by remember { mutableStateOf("off") }
    var browse by remember { mutableStateOf(false) }
    val issue = agentNameError(name.trim()) ?: if (agents.any { it.hosted && it.name == name.trim() }) "Name already exists" else null
    Column(Modifier.verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        OutlinedTextField(name, { name = it }, label = { Text("Name") }, modifier = Modifier.fillMaxWidth(), singleLine = true, isError = name.isNotEmpty() && issue != null)
        if (name.isNotEmpty()) issue?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
        OutlinedTextField(cwd, { cwd = it }, label = { Text("Working directory") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
        OutlinedButton(onClick = { browse = true }) { Text("Browse host folders") }
        ModelPicker(state, selected, thinking, { selected = it; thinking = defaultThinking(it) }, { thinking = it })
        Button(enabled = issue == null && cwd.isNotBlank() && selected != null && !busy, onClick = {
            val model = selected ?: return@Button
            state.action { val result = newAgent(name.trim(), cwd.trim(), ModelRef(model.provider, model.modelId), thinking); result.id?.let { state.open(it) } }
        }) { Text("Create agent") }
    }
    if (browse) DirectoryPicker(state, flatten(agents).mapNotNull { it.cwd }.distinct(), cwd.ifBlank { null }, { cwd = it; browse = false }, { browse = false })
}

@Composable
private fun DirectoryPicker(state: AppState, recent: List<String>, initial: String?, choose: (String) -> Unit, close: () -> Unit) {
    var path by remember { mutableStateOf(initial) }
    var listing by remember { mutableStateOf<DirsResponse?>(null) }
    var loading by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(path) {
        loading = true; error = null
        try { listing = state.dirs(path) } catch (e: CancellationException) { throw e } catch (e: Exception) { error = e.message; state.fail(e) } finally { loading = false }
    }
    AlertDialog(onDismissRequest = close, title = { Text("Host folders") }, text = {
        LazyColumn(Modifier.heightIn(max = 440.dp)) {
            item { Text(listing?.path ?: "Loading…", style = MaterialTheme.typography.bodySmall); if (loading) LinearProgressIndicator(Modifier.fillMaxWidth()); (error ?: listing?.error)?.let { Text(it, color = MaterialTheme.colorScheme.error) } }
            if (recent.isNotEmpty()) { item { Text("Recent folders", style = MaterialTheme.typography.labelLarge, modifier = Modifier.padding(top = 12.dp)) }; items(recent) { dir -> TextButton(onClick = { path = dir }) { Text(dir) } } }
            item { HorizontalDivider(); listing?.parent?.let { parent -> TextButton(onClick = { path = parent }) { Text("↑ Parent") } } }
            items(listing?.dirs ?: emptyList()) { dir -> TextButton(onClick = { path = listing!!.path.trimEnd('/') + "/" + dir.name }) { Column(Modifier.fillMaxWidth()) { Text("▸ ${dir.name}"); if (dir.markers.isNotBlank()) Text(dir.markers, style = MaterialTheme.typography.labelSmall) } } }
        }
    }, confirmButton = { TextButton(enabled = listing != null && !loading && listing?.error == null, onClick = { listing?.let { choose(it.path) } }) { Text("Use this folder") } }, dismissButton = { TextButton(onClick = close) { Text("Cancel") } })
}

/** Never dispatch app intents (including pairing links) from untrusted transcript Markdown. */
@Composable
private fun SafeMarkdown(text: String) {
    val handler = LocalUriHandler.current
    val safe = remember(handler) { object : UriHandler {
        override fun openUri(uri: String) {
            if (runCatching { URI(uri).scheme?.lowercase() in listOf("http", "https") }.getOrDefault(false)) {
                runCatching { handler.openUri(uri) }
            }
        }
    } }
    CompositionLocalProvider(LocalUriHandler provides safe) { Markdown(text) }
}
