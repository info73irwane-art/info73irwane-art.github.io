// Service worker: يجعل الموقع قابلاً للتثبيت ويستقبل التنبيهات (Push)
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    const raw = event.data ? event.data.json() : {};
    // رسائل Firebase تأتي داخل الحقل data
    data = raw.data || raw.notification || raw;
  } catch (e) {
    data = { title: "تنبيه", body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "مهام قسم الإعلام والتوثيق", {
      body: data.body || "",
      icon: "/icons/icon-192.png",
      dir: "rtl",
      lang: "ar",
      tag: data.tag,
      data: { url: data.url || "/" },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ("focus" in client) return client.focus();
      }
      return self.clients.openWindow(url);
    })
  );
});
