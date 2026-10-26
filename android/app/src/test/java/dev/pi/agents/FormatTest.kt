package dev.pi.agents

import org.junit.Assert.*
import org.junit.Test

class FormatTest {
    private fun agent(id: String = "a", running: Boolean = false, enabled: Boolean = true) = AgentSummary(id, id, enabled, true, running = running)
    @Test fun formatters() {
        assertEquals("0s", formatDuration(-10.0))
        assertEquals("1m 01s", formatDuration(61000.0))
        assertEquals("1h 01m", formatDuration(3660000.0))
        assertEquals("just now", formatAgo(100.0))
        assertEquals("2m ago", formatAgo(120000.0))
        assertEquals("2h ago", formatAgo(7200000.0))
        assertEquals("1.1k", formatTokens(1150))
        assertEquals("9.9k", formatTokens(9950))
        assertEquals("9.9M", formatTokens(9950000))
        assertEquals("$1.000", formatCost(1.0005))
        assertEquals("$0.123", formatCost(0.1235))
        assertEquals("950", formatTokens(950))
        assertEquals("4.2k", formatTokens(4200))
        assertEquals("188k", formatTokens(188000))
        assertEquals("1.0M", formatTokens(1000000))
        assertEquals("12M", formatTokens(12000000))
        assertEquals("18.8%/1.0M", formatContext(agent().copy(context = 188000, contextWindow = 1000000)))
        assertEquals("4.2k ctx", formatContext(agent().copy(context = 4200)))
        assertEquals("", formatContext(agent()))
        assertEquals("$9.812", formatCost(9.812))
        assertEquals("", formatCost(0.0))
        assertEquals("idle", statusWord(agent()))
        assertEquals("thinking", statusWord(agent(running = true).copy(activity = "thinking")))
        assertEquals("stopped", statusWord(agent(enabled = false)))
    }
    @Test fun usageAndModelPresentation() {
        assertEquals("↑0 ↓0 R0 W0 CH0.0% $0.000", formatUsage(null))
        assertEquals("↑1.1k ↓4.2k R188k W1.0M CH12.5% $1.000 (sub) 18.8%/1.0M",
            formatUsage(agent().copy(tokens = TokenUsage(1150, 4200, 188000, 1000000), cacheHit = 12.5,
                cost = 1.0005, subscription = true, context = 188000, contextWindow = 1000000)))
        assertEquals("medium", defaultThinking(ModelChoice("p", "m", listOf("off", "medium", "high"))))
        assertEquals("off", defaultThinking(ModelChoice("p", "m", listOf("off", "high"))))
        assertEquals("connected", displayStatus(agent().copy(hosted = false, connected = true)))
        assertEquals("offline", displayStatus(agent().copy(hosted = false, connected = false)))
    }
    @Test fun finishTransitions() {
        val running = agent(running = true)
        assertEquals(listOf(agent()), finishedAgents(listOf(running), listOf(agent())))
        assertEquals(listOf(agent(enabled = false)), finishedAgents(listOf(running), listOf(agent(enabled = false))))
        assertTrue(finishedAgents(listOf(agent()), listOf(agent(enabled = false))).isEmpty())
        assertTrue(finishedAgents(emptyList(), listOf(agent())).isEmpty())
        assertTrue(finishedAgents(listOf(running), emptyList()).isEmpty())
        assertTrue(finishedAgents(listOf(agent()), listOf(agent())).isEmpty())
        val child = agent("child", true)
        assertTrue(finishedAgents(listOf(agent().copy(children = listOf(child))), listOf(agent().copy(children = listOf(child.copy(running = false))))).isEmpty())
    }
    @Test fun deepLinkAndNames() {
        assertEquals(ConnectionSettings("https://host", "abc"), ConnectionSettings.fromPairingUrl("piagents://pair?url=https%3A%2F%2Fhost%2F%3Ftoken%3Dabc"))
        assertNull(agentNameError("Agent-1_test.ok"))
        for (name in listOf("main", "human", "constructor", "prototype", "__proto__", "a b", "_x", "a".repeat(65))) assertNotNull(agentNameError(name))
    }
}
