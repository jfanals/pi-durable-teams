package dev.pi.agents

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*

class AppState(application: Application) : AndroidViewModel(application) {
    val settings = Settings(application)
    private var api: ApiClient? = null
    private var rosterJob: Job? = null
    private var chatJob: Job? = null
    private var active = false
    val agents = MutableStateFlow<List<AgentSummary>>(emptyList())
    val items = MutableStateFlow<List<ChatItem>>(emptyList())
    val next = MutableStateFlow<String?>(null)
    val error = MutableStateFlow<String?>(null)
    val reconnecting = MutableStateFlow(true)
    val screen = MutableStateFlow(if (settings.load().serverUrl.isBlank()) "settings" else "list")
    val target = MutableStateFlow<String?>(null)
    val busy = MutableStateFlow(false)
    val models = MutableStateFlow<List<ModelChoice>>(emptyList())
    val backStack = mutableListOf<String>()
    val pairingUrl = MutableStateFlow("")
    val pairingConfirmation = MutableStateFlow<ConnectionSettings?>(null)
    init { connect() }
    fun connect() {
        rosterJob?.cancel(); chatJob?.cancel()
        val c = settings.load()
        api = if (c.serverUrl.isNotBlank()) ApiClient(c.serverUrl, c.token) else null
        if (active) { startRoster(); startChat() }
    }
    fun foreground(value: Boolean) {
        active = value
        if (value) { startRoster(); startChat() } else { rosterJob?.cancel(); chatJob?.cancel() }
    }
    fun fail(e: Exception) {
        error.value = if (e.message?.contains("HTTP 401") == true) "Pairing expired or unauthorized. Paste a fresh pairing URL." else e.message ?: "Network error"
        if (e.message?.contains("HTTP 401") == true) { screen.value = "settings"; rosterJob?.cancel(); chatJob?.cancel() }
    }
    private fun startRoster() {
        rosterJob?.cancel()
        val client = api ?: return
        rosterJob = viewModelScope.launch {
            var wait = 500L
            while (isActive) {
                try { client.roster().collect { agents.value = it; error.value = null; reconnecting.value = false; wait = 500 } }
                catch (e: CancellationException) { throw e }
                catch (e: Exception) { if (e.message?.contains("HTTP 401") == true) fail(e) }
                reconnecting.value = true
                delay(wait); wait = (wait * 2).coerceAtMost(10000)
            }
        }
    }
    fun open(id: String) {
        if (target.value != id) { items.value = emptyList(); next.value = null }
        target.value = id; screen.value = "chat"; startChat()
    }
    fun navigate(to: String) { screen.value = to; if (to != "chat") { chatJob?.cancel(); target.value = null } }
    private fun startChat() {
        chatJob?.cancel()
        val id = target.value ?: return
        if (!active || screen.value != "chat") return
        val client = api ?: return
        chatJob = viewModelScope.launch {
            var wait = 500L
            while (isActive) {
                try {
                    client.watch(id).conflate().collect {
                        refresh(id, false); reconnecting.value = false; error.value = null; wait = 500
                    }
                } catch (e: CancellationException) { throw e } catch (e: Exception) { if (e.message?.contains("HTTP 401") == true) fail(e) }
                reconnecting.value = true; delay(wait); wait = (wait * 2).coerceAtMost(10000)
            }
        }
    }
    private suspend fun refresh(id: String, older: Boolean) {
        val page = api!!.page(id, if (older) next.value else null)
        if (target.value != id) return
        if (older) {
            items.value = (page.items + items.value).distinctBy { it.id }; next.value = page.next
        } else {
            val merged = refreshedPage(items.value, next.value, page)
            items.value = merged.items; next.value = merged.next
        }
    }

    fun older() = action { target.value?.let { refresh(it, true) } }
    fun action(block: suspend ApiClient.() -> Unit) {
        if (busy.value) return
        val client = api ?: return
        viewModelScope.launch {
            busy.value = true
            try { client.block(); error.value = null } catch (e: CancellationException) { throw e } catch (e: Exception) { fail(e) }
            finally { busy.value = false }
        }
    }
    fun loadModels() = action { models.value = models() }
    suspend fun dirs(path: String?) = api!!.dirs(path).also { error.value = null }
}
