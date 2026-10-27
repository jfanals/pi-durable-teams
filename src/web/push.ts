import { api } from "./api.ts";

export const notifications = { enabled: false, busy: false, note: "", supported: "serviceWorker" in navigator && "PushManager" in window && "Notification" in window };
let registration: Promise<ServiceWorkerRegistration> | undefined;
export function registerWorker() {
  return registration ??= navigator.serviceWorker.register("/web/sw.js", { scope: "/" }).then(() => navigator.serviceWorker.ready);
}
function permissionNote() {
  if (!notifications.supported) return "Notifications need HTTPS and a supporting browser";
  if (Notification.permission === "denied") return "Notifications blocked. Allow notifications in this site's browser settings.";
  return "";
}
// A reset host has a new VAPID identity; browser subscriptions must follow it.
async function subscribe(reg: ServiceWorkerRegistration, subscription: PushSubscription | null) {
  const { publicKey } = await api<{ publicKey: string }>("/push/key");
  const key = Uint8Array.from(atob(publicKey.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
  const existing = subscription?.options.applicationServerKey;
  if (subscription && (!existing || existing.byteLength !== key.byteLength ||
      !new Uint8Array(existing).every((byte, i) => byte === key[i]))) {
    if (!await subscription.unsubscribe()) throw new Error("Could not replace the browser notification subscription. Try again.");
    subscription = null;
  }
  const created = !subscription;
  subscription ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  try { await api("/push/subscribe", { subscription }); }
  catch (error) { if (created) await subscription.unsubscribe(); throw error; }
}
export async function notificationState() {
  notifications.enabled = false;
  notifications.note = permissionNote();
  if (!notifications.supported) return;
  const reg = await registerWorker();
  const subscription = await reg.pushManager.getSubscription();
  // A browser subscription alone is not proof that this host still knows it.
  if (subscription && Notification.permission === "granted") {
    await subscribe(reg, subscription);
    notifications.enabled = true;
  } else notifications.enabled = false;
}
export async function toggleNotifications(enabled: boolean) {
  if (notifications.busy) return;
  notifications.busy = true;
  notifications.note = "";
  try {
    if (!notifications.supported) throw new Error(permissionNote());
    // Ask directly from the user's gesture, before network or worker awaits.
    if (enabled && await Notification.requestPermission() !== "granted") throw new Error(permissionNote() || "Notification permission was not granted.");
    const reg = await registerWorker();
    let subscription = await reg.pushManager.getSubscription();
    if (enabled) {
      await subscribe(reg, subscription);
      notifications.enabled = true;
    } else {
      if (subscription) {
        await api("/push/unsubscribe", { endpoint: subscription.endpoint });
        notifications.enabled = false;
        if (!await subscription.unsubscribe()) throw new Error("Host notifications are off; browser subscription cleanup failed. Try again.");
      }
      notifications.enabled = false;
    }
  } catch (error) {
    notifications.note = error instanceof Error ? error.message : String(error);
    throw error;
  } finally { notifications.busy = false; }
}
