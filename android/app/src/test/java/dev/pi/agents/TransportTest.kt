package dev.pi.agents

import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Test

class TransportTest {
    @Test fun routesAuthAndFreshMutationIds() = runBlocking {
        MockWebServer().use { server ->
            server.start()
            val api = ApiClient("http://127.0.0.1:${server.port}", "secret")
            val seenIds = mutableSetOf<String>()
            suspend fun check(route: String, response: String, mutation: Boolean = false, operation: suspend () -> Unit) {
                server.enqueue(MockResponse().setBody(response))
                operation()
                val request = server.takeRequest(2, TimeUnit.SECONDS)!!
                assertEquals("POST", request.method)
                assertEquals("/agents$route", request.path)
                assertEquals("Bearer secret", request.getHeader("Authorization"))
                assertTrue(request.getHeader("Content-Type")!!.startsWith("application/json"))
                val body = apiJson.parseToJsonElement(request.body.readUtf8()).jsonObject
                if (mutation) {
                    val id = body.getValue("requestId").jsonPrimitive.content
                    UUID.fromString(id)
                    assertTrue(seenIds.add(id))
                }
            }
            check("", "[]") { api.list() }
            check("/models", "[]") { api.models() }
            check("/page", """{"items":[]}""") { api.page("a", "cursor") }
            check("/dirs", """{"path":"/","dirs":[]}""") { api.dirs() }
            check("/new", "{}", true) { api.newAgent("Name", "/tmp", ModelRef("p", "m")) }
            check("/send", "{}", true) { api.send("a", "Hello") }
            check("/send", "{}", true) { api.send("a", "Hello", "steer") }
            check("/stop", "{}", true) { api.stop("a") }
            check("/disable", "{}", true) { api.disable("a") }
            check("/model", "{}", true) { api.setModel("a", "p", "m", "high") }
            check("/rename", "{}", true) { api.rename("a", "New name") }
        }
    }

    @Test fun streamsAreColdAndCancelWithoutWaitingForEndOfBody() = runBlocking {
        MockWebServer().use { server ->
            server.start()
            val api = ApiClient("http://127.0.0.1:${server.port}", "secret")
            val roster = api.roster()
            assertEquals(0, server.requestCount)
            server.enqueue(MockResponse().setBody("[]\n").setHeader("Content-Length", "999999"))
            assertEquals(emptyList<AgentSummary>(), withTimeout(3000) { roster.first() })
            assertEquals("/agents/roster", server.takeRequest().path)
            server.enqueue(MockResponse().setBody("\n{\"changed\":true}\r\n").setHeader("Content-Length", "999999"))
            assertEquals(WatchTick(true), withTimeout(3000) { api.watch("a").first() })
            assertEquals("/agents/watch", server.takeRequest().path)
        }
    }
}
