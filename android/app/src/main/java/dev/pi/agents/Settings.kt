package dev.pi.agents

import android.content.Context
import java.net.URI
import java.net.URLDecoder

/** Pairing URLs are consumed locally: never send their token as a query parameter. */
data class ConnectionSettings(val serverUrl: String = "", val token: String = "") {
    companion object {
        fun fromPairingUrl(value: String): ConnectionSettings {
            val uri = URI(value.trim())
            if (uri.scheme == "piagents") {
                require(uri.host == "pair") { "Invalid pairing link" }
                val nested = uri.rawQuery.orEmpty().split('&').firstOrNull { it.startsWith("url=") }
                    ?.substringAfter('=') ?: error("Pairing link needs url")
                return fromPairingUrl(URLDecoder.decode(nested, "UTF-8"))
            }
            require(uri.scheme == "https" || (uri.scheme == "http" && uri.host in listOf("127.0.0.1", "localhost"))) {
                "Use HTTPS (HTTP is allowed only for localhost)"
            }
            require(!uri.host.isNullOrBlank() && uri.rawUserInfo == null) { "Invalid server URL" }
            val token = uri.rawQuery.orEmpty().split('&').firstNotNullOfOrNull { part ->
                val pair = part.split('=', limit = 2)
                if (pair[0] == "token" && pair.size == 2) URLDecoder.decode(pair[1], "UTF-8") else null
            }
            require(!token.isNullOrBlank()) { "Pairing URL needs a token" }
            return ConnectionSettings(URI(uri.scheme, null, uri.host, uri.port, null, null, null).toString(), token)
        }
    }
}

class Settings(context: Context) {
    private val preferences = context.getSharedPreferences("connection", Context.MODE_PRIVATE)
    var notify: Boolean
        get() = preferences.getBoolean("notify", false)
        set(value) { preferences.edit().putBoolean("notify", value).apply() }
    fun load() = ConnectionSettings(preferences.getString("serverUrl", "").orEmpty(), preferences.getString("token", "").orEmpty())
    fun save(value: ConnectionSettings) {
        preferences.edit().putString("serverUrl", value.serverUrl).putString("token", value.token).apply()
    }
}
