package dev.pi.agents

import android.app.*
import android.content.Context
import android.content.Intent
import android.os.IBinder
import kotlinx.coroutines.*

class WatchService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var job: Job? = null
    private val manager get() = getSystemService(NotificationManager::class.java)
    override fun onBind(intent: Intent?): IBinder? = null
    override fun onCreate() {
        super.onCreate()
        running = true
        manager.createNotificationChannel(NotificationChannel("watch", "Agent watcher", NotificationManager.IMPORTANCE_LOW))
        manager.createNotificationChannel(NotificationChannel("finished", "Agents finished", NotificationManager.IMPORTANCE_DEFAULT))
    }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val settings = Settings(this)
        if (!settings.notify || settings.load().serverUrl.isBlank()) { stopSelf(); return START_NOT_STICKY }
        startForeground(1, Notification.Builder(this, "watch").setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle("Watching agents").setContentText("Notifications when top-level agents finish")
            .setContentIntent(open(null)).setOngoing(true).build())
        job?.cancel()
        job = scope.launch {
            val connection = settings.load()
            val api = ApiClient(connection.serverUrl, connection.token)
            var previous: List<AgentSummary>? = null
            var wait = 500L
            while (isActive) {
                try { api.roster().collect { rows ->
                    previous?.let { finishedAgents(it, rows).forEach(::notifyFinished) }
                    previous = rows; wait = 500
                } } catch (e: CancellationException) { throw e } catch (e: Exception) {
                    if (e.message?.contains("HTTP 401") == true) { settings.notify = false; stopSelf(); return@launch }
                }
                delay(wait); wait = (wait * 2).coerceAtMost(10000)
            }
        }
        return START_STICKY
    }
    private fun open(id: String?): PendingIntent = PendingIntent.getActivity(this, id?.hashCode() ?: 0,
        Intent(this, MainActivity::class.java).putExtra("agent", id).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    private fun notifyFinished(agent: AgentSummary) {
        try {
            manager.notify(agent.id.hashCode(), Notification.Builder(this, "finished").setSmallIcon(android.R.drawable.stat_notify_chat)
                .setContentTitle("${agent.name} finished").setContentText(agent.activity ?: agent.latest?.lineSequence()?.firstOrNull { it.isNotBlank() } ?: if (!agent.enabled) "Agent stopped" else "Ready for your next message")
                .setContentIntent(open(agent.id)).setAutoCancel(true).build())
        } catch (_: SecurityException) { Settings(this).notify = false; stopSelf() }
    }
    // Android 15 limits dataSync foreground services to six hours per day.
    override fun onTimeout(startId: Int, fgsType: Int) { Settings(this).notify = false; stopSelf() }
    override fun onDestroy() { running = false; scope.cancel(); super.onDestroy() }
    companion object {
        var running = false
            private set
        fun enable(context: Context) { context.startForegroundService(Intent(context, WatchService::class.java)) } }
}
