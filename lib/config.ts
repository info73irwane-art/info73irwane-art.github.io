// ============================================================
//  الإعدادات: هذا هو الملف الوحيد الذي تحتاج تعديله
//  (القيم هنا عامة وليست سرية، فلا مشكلة في نشرها)
// ============================================================

// رابط تطبيق الويب لسكربت Google Apps Script (ينتهي بـ /exec)
export const API_URL = "https://script.google.com/macros/s/AKfycbzL06R-fKGynhbJVQeXwtj2vLETsvaUC3mGPR4rxTblWfCSJorrT_aoL-rNGIK9EftS/exec";

// من Firebase Console ← Project settings ← General ← Your apps (Web app) ← SDK setup and configuration
export const FIREBASE_CONFIG = {
  apiKey: "AIzaSyAwC0RgvsseaXd-vt1R6ccZCHB0nEGIwxU",
  authDomain: "i3lam-3e6ed.firebaseapp.com",
  projectId: "i3lam-3e6ed",
  storageBucket: "i3lam-3e6ed.firebasestorage.app",
  messagingSenderId: "1008435908731",
  appId: "1:1008435908731:web:7864d6be29f4a6015f92de"
};

// من Firebase Console ← Project settings ← Cloud Messaging ← Web Push certificates ← Key pair
export const FIREBASE_VAPID_KEY = "BAeZWAoqDennx35lldN9MCWwVqg_Y4PuXwfDRyUta7_bpG8CpWbPj-vdOkZ5pz0VCgdOWMtGrS9ZsHp4xQS_rxY";

// كل كم ثانية يتحقق التطبيق من وجود تغييرات (المزامنة بين الأجهزة)
export const SYNC_SECONDS = 4;
