# مهام قسم الإعلام والتوثيق: النسخة الجديدة (Google Sheets + APK)

بعد تنفيذ هذا الدليل تستغني نهائياً عن **Vercel** و **Supabase**:

| ما كان | ما أصبح |
|---|---|
| Supabase (قاعدة البيانات) | **Google Sheet** في حسابك |
| Supabase Auth (الدخول) | سكربت **Apps Script** داخل الشيت |
| Vercel (الخادم والتنبيه اليومي) | نفس السكربت + مؤقت يومي الساعة 9 |
| Supabase Storage (صور التفكير) | مجلد في **Google Drive** |
| Web Push | **Firebase Cloud Messaging** (مجاني، للتنبيهات فقط) |
| رابط Vercel | رابط مجاني على **GitHub Pages** + ملف **APK** |

> ⚠️ **لا تحذف Supabase قبل إنهاء الخطوة 1** (نقل البيانات).

خصص لهذا الدليل ساعة تقريباً. نفّذ الخطوات بالترتيب.

---

## الخطوة 1: الشيت والسكربت (الخادم الجديد)

1. افتح [sheets.new](https://sheets.new) وسمِّ الملف مثلاً: **مهام قسم الإعلام**.
2. من القائمة: **Extensions ← Apps Script** (الإضافات ← Apps Script).
3. احذف كل ما في المحرر، والصق محتوى الملف `google-apps-script/Code.gs` كاملاً، ثم احفظ (Ctrl+S).
4. من الشريط الأيسر افتح ⚙️ **Project Settings**، وفي أسفل الصفحة **Script Properties** أضف خاصيتين (للنقل فقط):
   - `SUPABASE_URL` ← رابط مشروعك، مثل `https://xxxx.supabase.co` (Supabase ← Project Settings ← API)
   - `SUPABASE_SERVICE_KEY` ← مفتاح **service_role** من نفس الصفحة
5. ارجع إلى المحرر، واختر الدالة **`setup`** من القائمة أعلاه، ثم اضغط **Run**.
   - ستطلب Google الإذن: اختر حسابك ← **Advanced** ← **Go to … (unsafe)** ← **Allow**. هذا طبيعي لأن السكربت لك أنت.
6. اختر الدالة **`migrateFromSupabase`** واضغط **Run**. في السجل (Execution log) يظهر عدد الأعضاء والمهام والمشاريع والصور المنقولة.
   - ✅ ستجد في الشيت ورقة **«لوحة المهام»** تعرض المهام بأسماء مفهومة.
   - 🔑 **كلمة مرور كل الأعضاء أصبحت `0000`**، والتطبيق سيطلب من كل واحد تغييرها عند الدخول.
7. انشر السكربت: **Deploy ← New deployment** ← رمز ⚙️ ← **Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
   - اضغط **Deploy** وانسخ الرابط الذي ينتهي بـ `/exec`. هذا هو **رابط الخادم**.

> 💡 إذا عدّلت `Code.gs` مستقبلاً: **Deploy ← Manage deployments ← ✏️ ← Version: New version ← Deploy**. بهذه الطريقة يبقى الرابط نفسه.

---

## الخطوة 2: Firebase (للتنبيهات فقط)

1. ادخل [console.firebase.google.com](https://console.firebase.google.com) ← **Create a project** (يمكنك إيقاف Google Analytics).
2. ⚙️ **Project settings ← General** ← في أسفل الصفحة اختر رمز الويب **`</>`** ← سمِّ التطبيق ← **Register app**.
   انسخ القيم الظاهرة في `firebaseConfig` (apiKey و authDomain و …) إلى `FIREBASE_CONFIG` في الملف `lib/config.ts`.
3. تبويب **Cloud Messaging**:
   - تأكد أن **Firebase Cloud Messaging API (V1)** مفعّل (Enabled).
   - في **Web Push certificates** اضغط **Generate key pair**، وانسخ المفتاح إلى `FIREBASE_VAPID_KEY` في `lib/config.ts`.
4. تبويب **Service accounts** ← **Generate new private key** ← سيُنزَّل ملف JSON.
   افتحه بمحرر نصوص وانسخ **كل محتواه**، ثم في Apps Script ← Project Settings ← Script Properties أضف:
   - `FCM_SERVICE_ACCOUNT` ← المحتوى كاملاً
   > 🔒 هذا الملف سري: لا ترفعه إلى GitHub ولا ترسله لأحد.
5. ضع **رابط الخادم** (من الخطوة 1) في `API_URL` داخل `lib/config.ts`.

---

## الخطوة 3: النشر المجاني على GitHub Pages (رابط الحاسوب)

1. أنشئ حساباً على [github.com](https://github.com) إن لم يكن لديك.
2. أنشئ مستودعاً جديداً (**New repository**) **اسمه بالضبط**: `اسم-المستخدم.github.io`
   (مثلاً إن كان اسمك `bmsalah` فالمستودع `bmsalah.github.io`)، واجعله **Public**.
   > هذا الاسم ضروري ليعمل تطبيق الأندرويد بدون شريط عنوان. الكود العام لا يحتوي أي سر، فالبيانات تبقى في الشيت الخاص بك.
3. ارفع **كل محتويات** هذا المجلد إلى المستودع (بعد تعديل `lib/config.ts`)، **بما فيها مجلد `.github`**.
   الأسهل استعمال [GitHub Desktop](https://desktop.github.com)، أو **Add file ← Upload files** مع سحب المجلدات.
4. في المستودع: **Settings ← Pages ← Source: GitHub Actions**.
5. افتح تبويب **Actions** وانتظر علامة ✅ (دقيقتان تقريباً).
6. افتح `https://اسم-المستخدم.github.io` ← سجّل الدخول ببريدك وكلمة المرور `0000` ← غيّرها ← ⚙️ ← **تفعيل التنبيهات**.

**على الحاسوب:** افتح الرابط في Chrome أو Edge واضغط زر **📲 تثبيت التطبيق** (أو أيقونة التثبيت في شريط العنوان)، فيصبح تطبيقاً بأيقونة ونافذة مستقلة.

> 💡 أي تعديل ترفعه على GitHub يُنشر تلقائياً، ويصل إلى الحاسوب والـ APK دون إعادة تثبيت.

---

## الخطوة 4: ملف APK للأندرويد

1. افتح [pwabuilder.com](https://www.pwabuilder.com) وأدخل رابطك `https://اسم-المستخدم.github.io` ← **Start**.
2. **Package For Stores ← Android ← Generate Package**. في الخيارات:
   - **Package ID**: مثل `io.github.bmsalah.tasks`
   - اترك **Notification delegation** مفعّلاً
   - **Signing key: Create new**
3. ستُنزّل ملف zip فيه:
   - `*.apk` ← **هذا ملف التطبيق** الذي توزّعه على الأعضاء
   - `*.aab` ← لمتجر Google Play إن أردت النشر فيه لاحقاً
   - `signing.keystore` و `signing-key-info.txt` ← 🔒 **احفظهما في مكان آمن**، فبدونهما لا يمكنك إصدار تحديث للـ APK بنفس الهوية
   - `assetlinks.json`
4. ارفع `assetlinks.json` إلى المستودع في المسار **`public/.well-known/assetlinks.json`**، وانتظر النشر.
   تحقق أن هذا الرابط يفتح: `https://اسم-المستخدم.github.io/.well-known/assetlinks.json`
   (بدون هذه الخطوة يعمل التطبيق، لكن يظهر شريط عنوان في أعلاه.)
5. أرسل ملف APK للأعضاء. عند التثبيت يُطلب السماح بـ «تثبيت من مصادر غير معروفة»، وهذا طبيعي لأنه ليس من المتجر.
   بعد الدخول، على كل عضو تفعيل التنبيهات مرة واحدة من ⚙️.

> 📱 **iPhone:** يفتح الرابط في Safari ← مشاركة ← **إضافة إلى الشاشة الرئيسية**، ثم يفعّل التنبيهات من داخل التطبيق.

---

## الخطوة 5: التجربة ثم الإيقاف

- **تجربة التنبيه:** في Apps Script شغّل الدالة `testPushToAdmins` (يجب أن تكون قد فعّلت التنبيهات من التطبيق قبلها).
- **التنبيه اليومي:** يصل بين **9:00 و 9:15** صباحاً بتوقيت الجزائر، لكل عضو عنده مهام حلّ موعدها أو تأخرت.
- بعد أسبوع من التشغيل السليم:
  - احذف `SUPABASE_SERVICE_KEY` و `SUPABASE_URL` من Script Properties.
  - أوقف مشروع Supabase واحذف مشروع Vercel.

---

## ملاحظات مهمة

- **المزامنة:** يتحقق التطبيق من التغييرات كل 4 ثوانٍ (`SYNC_SECONDS` في `lib/config.ts`)، فيظهر التعديل على الأجهزة الأخرى خلال ثوانٍ.
- **التعديل من الشيت مباشرة** ممكن (الأوراق: `tasks` و `projects` و `wishlist_items` و `profiles`)، ويظهر في التطبيق خلال ثوانٍ. لكن **لا تغيّر العناوين ولا عمود `id`**، ولا تكتب في ورقة «لوحة المهام» لأنها معادلات.
- **النسخ الاحتياطي:** الشيت يحفظ سجل الإصدارات تلقائياً (File ← Version history)، ويمكنك عمل نسخة دورية (File ← Make a copy).
- **أول حساب** يُنشأ في شيت فارغ (إن لم تنقل البيانات) يصبح **مسؤولاً** تلقائياً.
- الخطة المجانية لـ Google تكفي بسهولة لفريق من بضع عشرات من الأعضاء.

## ما الذي تغيّر في الكود؟

الواجهة كما هي بالضبط. التغييرات:

| الملف | التغيير |
|---|---|
| `lib/supabase.ts` | أصبح طبقة توافق تتصل بالسكربت بدل Supabase (نفس الواجهة البرمجية، لذلك بقي `page.tsx` كما هو) |
| `lib/config.ts` | جديد: كل الإعدادات في مكان واحد |
| `lib/fcm.ts` | جديد: الحصول على رمز التنبيهات من Firebase |
| `app/page.tsx` | فقط دالتا تفعيل/إيقاف التنبيهات، ودالة `notifyAssignee` (أصبح الخادم يرسل التنبيه تلقائياً) |
| `public/sw.js` | يقرأ رسائل Firebase |
| `public/icons/` | أيقونات ثابتة بدل المسار `/pwa-icon` |
| `google-apps-script/Code.gs` | جديد: الخادم كاملاً |
| محذوف | `app/api/*` و `app/pwa-icon` و `lib/push.ts` و `lib/supabase-admin.ts` |
