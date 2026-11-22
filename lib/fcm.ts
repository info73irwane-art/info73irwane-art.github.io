// تنبيهات Firebase Cloud Messaging: يحصل على رمز هذا الجهاز لإرسال التنبيهات إليه
import { FIREBASE_CONFIG, FIREBASE_VAPID_KEY } from "./config";

async function messaging() {
  const { initializeApp, getApps } = await import("firebase/app");
  const { getMessaging } = await import("firebase/messaging");
  const app = getApps()[0] || initializeApp(FIREBASE_CONFIG);
  return getMessaging(app);
}

export async function getFcmToken(reg: ServiceWorkerRegistration): Promise<string> {
  const { getToken } = await import("firebase/messaging");
  return getToken(await messaging(), { vapidKey: FIREBASE_VAPID_KEY, serviceWorkerRegistration: reg });
}

export async function deleteFcmToken(): Promise<void> {
  const { deleteToken } = await import("firebase/messaging");
  await deleteToken(await messaging());
}
