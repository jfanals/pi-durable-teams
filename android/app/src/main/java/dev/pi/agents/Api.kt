package dev.pi.agents

import java.io.IOException
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

val apiJson = Json { ignoreUnknownKeys = true; classDiscriminator = "kind" }

@Serializable
data class TokenUsage(val input: Long, val output: Long, val cacheRead: Long, val cacheWrite: Long)

@Serializable
data class AgentSummary(
    val id: String, val name: String, val enabled: Boolean, val hosted: Boolean,
    val children: List<AgentSummary> = emptyList(),
    val running: Boolean? = null, val connected: Boolean? = null,
    val activity: String? = null, val since: Double? = null, val finishedAt: Double? = null,
    val cost: Double? = null, val subscription: Boolean? = null,
    val model: String? = null, val modelId: String? = null, val provider: String? = null,
    val thinking: String? = null, val tokens: TokenUsage? = null, val cacheHit: Double? = null,
    val context: Long? = null, val contextWindow: Long? = null,
    val cwd: String? = null, val latest: String? = null,
)

@Serializable
data class ModelRef(val provider: String, val modelId: String)
@Serializable
data class ModelChoice(val provider: String, val modelId: String, val thinkingLevels: List<String>, val name: String? = null)
@Serializable
data class MutationResult(
    val id: String? = null, val taskId: Long? = null, val workerId: String? = null,
    val delivery: String? = null, val aborted: List<String>? = null, val stopped: List<String>? = null,
    val model: ModelRef? = null, val thinking: String? = null,
)
@Serializable
data class ToolCall(val id: String, val name: String, val subject: String)
@Serializable
data class Turn(val tokens: Long, val cost: Double, val ms: Double? = null)

@Serializable
sealed class ChatItem {
    abstract val id: String
    @Serializable @SerialName("input")
    data class Input(override val id: String, val from: String, val text: String, val report: Boolean? = null, val at: Double? = null) : ChatItem()
    @Serializable @SerialName("reply")
    data class Reply(override val id: String, val text: String, val tools: List<ToolCall>, val thinking: List<String>? = null, val error: String? = null, val at: Double? = null, val turn: Turn? = null) : ChatItem()
    @Serializable @SerialName("result")
    data class Result(override val id: String, val callId: String, val ok: Boolean, val error: String? = null) : ChatItem()
    @Serializable @SerialName("notice")
    data class Notice(override val id: String, val text: String) : ChatItem()
}
@Serializable
data class TranscriptPage(val items: List<ChatItem>, val next: String? = null)
@Serializable
data class Directory(val name: String, val markers: String)
@Serializable
data class DirsResponse(val path: String, val dirs: List<Directory>, val parent: String? = null, val error: String? = null)
@Serializable
data class WatchTick(val changed: Boolean)

/** Lines are framed by Okio, not network chunks; CRLF, blanks and a final unterminated line work. */
internal inline fun <reified T> decodeNdjsonLine(line: String): T? =
    if (line.isBlank()) null else apiJson.decodeFromString<T>(line)

class ApiClient(baseUrl: String, private val token: String) {
    private val base = baseUrl.trimEnd('/')
    // Do not replay mutations automatically. Streams have no read timeout.
    private val http = OkHttpClient.Builder().retryOnConnectionFailure(false)
        .followRedirects(false).followSslRedirects(false).build()
    private val streamingHttp = http.newBuilder().readTimeout(0, TimeUnit.MILLISECONDS).build()

    private fun request(route: String, body: JsonObject) = Request.Builder()
        .url("$base/$route").header("Authorization", "Bearer $token")
        .post(body.toString().toRequestBody("application/json".toMediaType())).build()

    private suspend inline fun <reified T> post(route: String, body: JsonObject = buildJsonObject {}): T {
        val text = suspendCancellableCoroutine<String> { continuation ->
            val call = http.newCall(request(route, body))
            continuation.invokeOnCancellation { call.cancel() }
            call.enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) { continuation.resumeWithException(e) }
                override fun onResponse(call: Call, response: Response) {
                    try {
                        val result = response.use {
                            if (!it.isSuccessful) throw IOException("HTTP ${it.code}")
                            it.body?.string() ?: throw IOException("Empty response")
                        }
                        continuation.resume(result)
                    } catch (e: Exception) { continuation.resumeWithException(e) }
                }
            })
        }
        return apiJson.decodeFromString(text)
    }

    private inline fun <reified T : Any> stream(route: String, body: JsonObject = buildJsonObject {}): Flow<T> = callbackFlow {
        val call = streamingHttp.newCall(request(route, body))
        val reader = launch(Dispatchers.IO) {
            try {
                call.execute().use { response ->
                    if (!response.isSuccessful) throw IOException("HTTP ${response.code}")
                    val source = response.body?.source() ?: throw IOException("Empty response")
                    while (true) {
                        val line = source.readUtf8Line() ?: break
                        decodeNdjsonLine<T>(line)?.let { send(it) }
                    }
                }
                close()
            } catch (e: Exception) { close(e) }
        }
        awaitClose { call.cancel(); reader.cancel() }
    }

    suspend fun list(): List<AgentSummary> = post("agents")
    suspend fun models(): List<ModelChoice> = post("agents/models")
    suspend fun page(target: String, cursor: String? = null): TranscriptPage = post("agents/page", buildJsonObject {
        put("target", target); cursor?.let { put("cursor", it) }
    })
    suspend fun dirs(path: String? = null): DirsResponse = post("agents/dirs", buildJsonObject { path?.let { put("path", it) } })
    fun roster(): Flow<List<AgentSummary>> = stream("agents/roster")
    fun watch(target: String): Flow<WatchTick> = stream("agents/watch", buildJsonObject { put("target", target) })

    private suspend fun mutate(route: String, fields: JsonObject): MutationResult = post("agents/$route", buildJsonObject {
        fields.forEach { (key, value) -> put(key, value) }
        put("requestId", UUID.randomUUID().toString())
    })
    suspend fun send(target: String, message: String, mode: String = "followUp") = mutate("send", buildJsonObject {
        put("target", target); put("message", message); put("mode", mode)
    })
    suspend fun stop(target: String) = mutate("stop", buildJsonObject { put("target", target) })
    suspend fun disable(target: String) = mutate("disable", buildJsonObject { put("target", target) })
    suspend fun rename(target: String, name: String) = mutate("rename", buildJsonObject { put("target", target); put("name", name) })
    suspend fun newAgent(name: String, cwd: String, model: ModelRef? = null, thinking: String? = null) = mutate("new", buildJsonObject {
        put("name", name); put("cwd", cwd)
        model?.let { put("model", apiJson.encodeToJsonElement(it)) }; thinking?.let { put("thinking", it) }
    })
    suspend fun setModel(target: String, provider: String, modelId: String, thinking: String? = null) = mutate("model", buildJsonObject {
        put("target", target); put("provider", provider); put("modelId", modelId); thinking?.let { put("thinking", it) }
    })
}
