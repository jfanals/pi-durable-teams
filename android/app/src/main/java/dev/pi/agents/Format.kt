package dev.pi.agents

import java.math.BigDecimal
import java.math.RoundingMode
import kotlin.math.floor

private fun fixed(n: Double, digits: Int) = BigDecimal(n).setScale(digits, RoundingMode.HALF_UP).toPlainString()
fun formatDuration(ms: Double): String {
    val s = (ms / 1000).toLong().coerceAtLeast(0)
    return when { s < 60 -> "${s}s"; s < 3600 -> "${s / 60}m ${(s % 60).toString().padStart(2, '0')}s"; else -> "${s / 3600}h ${(s / 60 % 60).toString().padStart(2, '0')}m" }
}
fun formatAgo(ms: Double) = when { ms < 60000 -> "just now"; ms < 3600000 -> "${floor(ms / 60000).toLong()}m ago"; else -> "${floor(ms / 3600000).toLong()}h ago" }
fun formatTokens(n: Long): String = when {
    n < 1000 -> "$n"; n < 10000 -> "${fixed(n / 1000.0, 1)}k"; n < 1000000 -> "${floor(n / 1000.0 + .5).toLong()}k"
    n < 10000000 -> "${fixed(n / 1000000.0, 1)}M"; else -> "${floor(n / 1000000.0 + .5).toLong()}M"
}
fun formatContext(a: AgentSummary) = a.context?.let { if ((a.contextWindow ?: 0) > 0) "${fixed(100.0 * it / a.contextWindow!!, 1)}%/${formatTokens(a.contextWindow)}" else "${formatTokens(it)} ctx" }.orEmpty()
fun formatCost(cost: Double?) = if (cost == null || cost == 0.0) "" else "$${fixed(cost, 3)}"
fun statusWord(a: AgentSummary) = if (!a.enabled) "stopped" else if (a.running == true) a.activity ?: "running" else "idle"
fun agentNameError(name: String): String? = if (!Regex("^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$").matches(name) || name in listOf("main", "human", "constructor", "prototype", "__proto__")) "Use a unique 1–64 character name: letters/digits, dash, underscore, dot; not main" else null
fun flatten(agents: List<AgentSummary>): List<AgentSummary> = agents.flatMap { listOf(it) + flatten(it.children) }
fun hasRunning(a: AgentSummary): Boolean = a.running == true || a.children.any(::hasRunning)
fun offline(a: AgentSummary) = !a.hosted && a.connected != true && !hasRunning(a)
/** Initial snapshots and missing agents never signal a finish. Only top-level transitions do. */
fun finishedAgents(previous: List<AgentSummary>, current: List<AgentSummary>): List<AgentSummary> = current.filter { now ->
    previous.any { it.id == now.id && (it.running == true && now.running != true) }
}

fun formatUsage(a: AgentSummary?): String {
    val u = a?.tokens
    val context = if ((a?.contextWindow ?: 0) > 0) "${fixed(100.0 * (a?.context ?: 0) / a!!.contextWindow!!, 1)}%/${formatTokens(a.contextWindow)}"
        else if ((a?.context ?: 0) != 0L) "${formatTokens(a!!.context!!)} ctx" else ""
    return listOf("↑${formatTokens(u?.input ?: 0)} ↓${formatTokens(u?.output ?: 0)}",
        "R${formatTokens(u?.cacheRead ?: 0)} W${formatTokens(u?.cacheWrite ?: 0)}",
        "CH${fixed(a?.cacheHit ?: 0.0, 1)}% $${fixed(a?.cost ?: 0.0, 3)}${if (a?.subscription == true) " (sub)" else ""}", context).filter { it.isNotBlank() }.joinToString(" ")
}
fun defaultThinking(model: ModelChoice) = if ("medium" in model.thinkingLevels) "medium" else model.thinkingLevels.firstOrNull() ?: "off"
fun displayStatus(a: AgentSummary) = if (!a.hosted && a.running != true) { if (a.connected == true) "connected" else "offline" } else statusWord(a)
