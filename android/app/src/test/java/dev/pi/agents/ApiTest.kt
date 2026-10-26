package dev.pi.agents

import okio.Buffer
import org.junit.Assert.*
import org.junit.Test

class ApiTest {
    @Test fun nestedAgents() {
        val agents = apiJson.decodeFromString<List<AgentSummary>>("""[
            {"id":"a","name":"Parent","enabled":true,"hosted":true,"running":true,
             "tokens":{"input":5,"output":8,"cacheRead":2,"cacheWrite":3},"unknown":"ignored",
             "children":[{"id":"b","name":"Child","enabled":false,"hosted":true,"children":[]}]}
        ]""")
        assertEquals("Child", agents.single().children.single().name)
        assertEquals(8L, agents.single().tokens?.output)
        assertEquals(true, agents.single().running)
    }

    @Test fun inputItem() {
        val item = apiJson.decodeFromString<ChatItem>("""{"id":"i","kind":"input","from":"human","text":"Hello","report":true,"at":123}""") as ChatItem.Input
        assertEquals("human", item.from)
        assertEquals(true, item.report)
    }

    @Test fun replyItem() {
        val item = apiJson.decodeFromString<ChatItem>("""{"id":"r","kind":"reply","text":"Done","thinking":["Plan"],"tools":[{"id":"t","name":"read","subject":"Api.kt"}],"turn":{"ms":24,"tokens":12,"cost":0.01}}""") as ChatItem.Reply
        assertEquals("Api.kt", item.tools.single().subject)
        assertEquals(12L, item.turn?.tokens)
        assertEquals(listOf("Plan"), item.thinking)
    }

    @Test fun resultItem() {
        val item = apiJson.decodeFromString<ChatItem>("""{"id":"result","kind":"result","callId":"t","ok":false,"error":"Failed"}""") as ChatItem.Result
        assertFalse(item.ok)
        assertEquals("t", item.callId)
    }

    @Test fun noticeAndPage() {
        val page = apiJson.decodeFromString<TranscriptPage>("""{"items":[{"id":"n","kind":"notice","text":"No hosted transcript"}],"next":"cursor"}""")
        assertEquals("No hosted transcript", (page.items.single() as ChatItem.Notice).text)
        assertEquals("cursor", page.next)
    }

    @Test fun ndjsonAcrossNetworkChunks() {
        val wire = Buffer().writeUtf8("{\"changed\":")
        assertEquals(-1L, wire.indexOf('\n'.code.toByte()))
        wire.writeUtf8("true}\r\n\n{\"changed\":false}")
        assertEquals(WatchTick(true), decodeNdjsonLine<WatchTick>(wire.readUtf8Line()!!))
        assertNull(decodeNdjsonLine<WatchTick>(wire.readUtf8Line()!!))
        assertEquals(WatchTick(false), decodeNdjsonLine<WatchTick>(wire.readUtf8Line()!!))
        assertNull(wire.readUtf8Line())
    }

    @Test fun dirsAndModels() {
        val dirs = apiJson.decodeFromString<DirsResponse>("""{"path":"/home","parent":"/","dirs":[{"name":"repo","markers":"git · AGENTS.md"}]}""")
        assertEquals("git · AGENTS.md", dirs.dirs.single().markers)
        val model = apiJson.decodeFromString<ModelChoice>("""{"provider":"p","modelId":"m","thinkingLevels":["off","high"]}""")
        assertEquals(listOf("off", "high"), model.thinkingLevels)
    }

    @Test fun pairing() {
        assertEquals(ConnectionSettings("https://host.ts.net", "a+b="), ConnectionSettings.fromPairingUrl(" https://host.ts.net/?token=a%2Bb%3D "))
        assertEquals("http://127.0.0.1:7799", ConnectionSettings.fromPairingUrl("http://127.0.0.1:7799/?token=test").serverUrl)
        for (invalid in listOf("http://example.com/?token=x", "https://host/", "https://user@host/?token=x")) {
            assertThrows(IllegalArgumentException::class.java) { ConnectionSettings.fromPairingUrl(invalid) }
        }
    }
}
