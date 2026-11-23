// طبقة توافق: تقدّم نفس واجهة supabase-js التي يستعملها التطبيق،
// لكنها تتصل بسكربت Google Apps Script (قاعدة البيانات في Google Sheets).
//
// لتكون سريعة رغم بطء Google النسبي:
//  • يحتفظ التطبيق بنسخة من البيانات على الجهاز، فالقراءة فورية.
//  • الحفظ (إضافة/تعديل/حذف) يظهر فوراً على الشاشة ويُرسل في الخلفية.
//    إن رفضه الخادم تظهر رسالة وتعود البيانات كما كانت.
//  • التعديلات التي لم تُرسل بعد (انقطاع الإنترنت مثلاً) تُحفظ وتُرسل لاحقاً.
//  • كل بضع ثوانٍ يتحقق التطبيق من وجود تغييرات من الأجهزة الأخرى.
import { API_URL, SYNC_SECONDS } from "./config";

/* eslint-disable @typescript-eslint/no-explicit-any */
type ApiError = { message: string; code?: string };
type Result<T = any> = { data: T; error: ApiError | null };
type Row = Record<string, any>;
type Op = Record<string, any>;
type User = { id: string; email: string };
type Session = { access_token: string; user: User };
type Snapshot = { version: string; tables: Record<string, Row[]> };

const isBrowser = typeof window !== "undefined";
const SESSION_KEY = "tasks-session";
const OPTIMISTIC = new Set(["tasks", "projects", "wishlist_items"]);
const NET_ERROR: ApiError = { message: "تعذر الاتصال بالخادم. تحقق من الإنترنت." };

let session: Session | null = null;
let base: Snapshot | null = null; // آخر نسخة مؤكدة من الخادم
let view: Snapshot | null = null; // النسخة المعروضة = base + التعديلات غير المرسلة
let outbox: Op[] = [];             // تعديلات تنتظر الإرسال
let writing = false;
const authListeners = new Set<(event: string, s: Session | null) => void>();
const changeListeners = new Set<() => void>();

/* ===================== التخزين المحلي ===================== */

function readJSON<T>(key: string): T | null {
  try { const raw = isBrowser && key ? localStorage.getItem(key) : null; return raw ? JSON.parse(raw) as T : null; } catch { return null; }
}
function writeJSON(key: string, value: unknown) {
  try { if (!isBrowser || !key) return; if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(value)); } catch { /* التخزين ممتلئ أو غير متاح */ }
}
const snapKey = () => (session ? "tasks-snapshot:" + session.user.id : "");
const outKey = () => (session ? "tasks-outbox:" + session.user.id : "");

function loadLocal() {
  base = readJSON<Snapshot>(snapKey());
  outbox = readJSON<Op[]>(outKey()) || [];
  recompute();
}
function saveLocal() {
  writeJSON(snapKey(), base);
  writeJSON(outKey(), outbox.length ? outbox : null);
}

/* ===================== تطبيق التعديلات محلياً ===================== */

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const nil = (v: unknown) => (v === undefined || v === "" ? null : v);
const nowIso = () => new Date().toISOString();
const matches = (r: Row, filters: [string, unknown][] = []) =>
  filters.every(([c, v]) => (v === null || v === undefined ? r[c] == null : String(r[c]) === String(v)));

function newRow(table: string, v: Row): Row {
  const me = session?.user.id || null;
  const now = nowIso();
  if (table === "tasks") {
    return {
      id: v.id, title: String(v.title || "").trim(), description: nil(v.description), project_id: nil(v.project_id),
      assignee_id: nil(v.assignee_id) || me, created_by: me, due_date: nil(v.due_date),
      remind_days: Number(v.remind_days ?? 3), priority: v.priority || "normal", status: v.status || "pending",
      created_at: v.created_at || now, completed_at: null, completed_by: null, cancelled_at: null,
    };
  }
  if (table === "projects") {
    return { id: v.id, name: String(v.name || "").trim(), color: v.color || "#b45309", status: "active", created_by: me, created_at: v.created_at || now };
  }
  return {
    id: v.id, title: String(v.title || "").trim(), details: nil(v.details), status: v.status || "thinking",
    created_by: me, created_at: now, acquired_at: null, image_urls: Array.isArray(v.image_urls) ? v.image_urls : [],
  };
}

// الترتيب المشترك للمهام (نفس قواعد الخادم)
function compareTasks(a: Row, b: Row) {
  const s = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
  if (a.due_date && b.due_date) return s(a.due_date, b.due_date) || s(a.created_at || "", b.created_at || "");
  if (a.due_date) return -1;
  if (b.due_date) return 1;
  return s(a.created_at || "", b.created_at || "");
}
function mergedOrder(tasks: Row[], order: string[]): string[] {
  const list = tasks.filter(t => t.status === "pending" || t.status === "deferred").sort(compareTasks);
  const rank = new Map<string, number>();
  order.forEach((id, i) => { if (!rank.has(id)) rank.set(id, i); });
  const out = list.filter(t => rank.has(t.id)).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
  list.filter(t => !rank.has(t.id)).forEach(u => {
    let idx = out.findIndex(r => rank.has(r.id) && compareTasks(u, r) < 0);
    if (idx < 0) idx = out.length;
    out.splice(idx, 0, u);
  });
  return out.map(t => t.id);
}
function setLocalOrder(snap: Snapshot, order: string[]) {
  const rows = snap.tables.settings || (snap.tables.settings = []);
  const row = rows.find(r => r.key === "task_order");
  if (row) row.value = order; else rows.push({ key: "task_order", value: order });
}

function applyOp(snap: Snapshot, op: Op) {
  if (op.type === "rpc") {
    const order = ((snap.tables.settings || []).find(r => r.key === "task_order")?.value as string[]) || [];
    if (op.name === "reset_task_order") setLocalOrder(snap, []);
    if (op.name === "move_task") {
      const full = mergedOrder(snap.tables.tasks || [], order).filter(x => x !== op.args.id);
      const at = full.indexOf(op.args.anchor);
      if (at < 0) full.push(op.args.id); else full.splice(op.args.where === "after" ? at + 1 : at, 0, op.args.id);
      setLocalOrder(snap, full);
    }
    return;
  }
  const rows = snap.tables[op.table];
  if (!rows) return;
  if (op.type === "insert") {
    (Array.isArray(op.values) ? op.values : [op.values]).forEach((v: Row) => {
      if (!rows.some(r => r.id === v.id)) rows.push(newRow(op.table, v));
    });
  } else if (op.type === "update") {
    const vals: Row = {};
    Object.keys(op.values || {}).forEach(k => { vals[k] = k === "remind_days" ? Number(op.values[k]) : nil(op.values[k]); });
    rows.forEach(r => { if (matches(r, op.filters)) Object.assign(r, vals); });
  } else if (op.type === "delete") {
    const removed = rows.filter(r => matches(r, op.filters)).map(r => r.id);
    snap.tables[op.table] = rows.filter(r => !removed.includes(r.id));
    if (op.table === "projects") {
      (snap.tables.tasks || []).forEach(t => { if (removed.includes(t.project_id)) t.project_id = null; });
    }
  }
}

function recompute() {
  if (!base) { view = null; return; }
  const v = clone(base);
  outbox.forEach(op => applyOp(v, op));
  view = v;
}

function acceptSnapshot(version: string, tables: Record<string, Row[]> | null | undefined, force = false) {
  if (!tables) return false;
  if (!force && base && Number(version) < Number(base.version)) return false; // نسخة أقدم مما لدينا
  base = { version: String(version), tables };
  recompute();
  saveLocal();
  return true;
}

const emitChange = () => changeListeners.forEach(cb => { try { cb(); } catch { /* تجاهل */ } });

/* ===================== الجلسة ===================== */

function setSession(s: Session | null, event: string) {
  session = s;
  writeJSON(SESSION_KEY, s);
  base = null; view = null; outbox = [];
  if (s) { loadLocal(); startPolling(); flushOutbox(); }
  authListeners.forEach(cb => { try { cb(event, s); } catch { /* تجاهل */ } });
}

/* ===================== الاتصال بالخادم ===================== */

function post(ops: Op[]): Promise<any | null> {
  return postWithToken(ops, session?.access_token);
}

async function postWithToken(ops: Op[], token: string | undefined): Promise<any | null> {
  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ token, ops }),
      redirect: "follow",
    });
    const json = await res.json();
    const results: any[] = json.results || [];
    if (token && session?.access_token === token && results.some(r => r?.error?.code === "AUTH")) {
      setSession(null, "SIGNED_OUT");
    }
    return json;
  } catch {
    return null;
  }
}

// تجميع الطلبات المباشرة التي تصدر في نفس اللحظة في طلب واحد
type Pending = { op: Op; resolve: (r: Result) => void };
let queue: Pending[] = [];
let scheduled = false;
const CHANGES_DATA = new Set(["insert", "update", "delete", "rpc"]);

function call(op: Op): Promise<Result> {
  return new Promise(resolve => {
    queue.push({ op, resolve });
    if (!scheduled) { scheduled = true; setTimeout(flushQueue, 0); }
  });
}

async function flushQueue() {
  const batch = queue;
  queue = [];
  scheduled = false;
  const ops = batch.map(b => b.op);
  // بعد أي تعديل نطلب نسخة محدّثة في نفس الطلب
  const withSnap = !!session && ops.some(o => CHANGES_DATA.has(o.type));
  const json = await post(withSnap ? [...ops, { type: "snapshot" }] : ops);
  if (!json) { batch.forEach(b => b.resolve({ data: null, error: NET_ERROR })); return; }
  const results: any[] = json.results || [];
  if (withSnap) {
    const snap = results[ops.length];
    if (snap?.data && acceptSnapshot(json.version, snap.data)) emitChange();
  }
  batch.forEach((b, i) => {
    const r = results[i] || { error: json.error || { message: "استجابة غير صالحة من الخادم" } };
    b.resolve({ data: r.data ?? null, error: r.error ?? null });
  });
}

let snapshotPromise: Promise<boolean> | null = null;
function fetchSnapshot(): Promise<boolean> {
  if (!snapshotPromise) {
    snapshotPromise = (async () => {
      const json = await post([{ type: "snapshot" }]);
      const r = json?.results?.[0];
      return !!(r?.data && acceptSnapshot(json.version, r.data, true));
    })().finally(() => { snapshotPromise = null; });
  }
  return snapshotPromise;
}

/* ===================== إرسال التعديلات في الخلفية ===================== */

let retryTimer: ReturnType<typeof setTimeout> | null = null;

async function flushOutbox() {
  if (writing || !outbox.length || !session) return;
  writing = true;
  const sending = outbox.slice();
  const json = await post([...sending, { type: "snapshot" }]);
  writing = false;
  if (!json) {
    // لا إنترنت: تبقى التعديلات محفوظة وتُرسل لاحقاً
    if (!retryTimer) retryTimer = setTimeout(() => { retryTimer = null; flushOutbox(); }, 5000);
    return;
  }
  if (!session) return;
  const results: any[] = json.results || [];
  outbox = outbox.slice(sending.length);
  const snap = results[sending.length];
  if (!(snap?.data && acceptSnapshot(json.version, snap.data))) { recompute(); saveLocal(); }
  emitChange();
  const failed = results.slice(0, sending.length).find(r => r?.error);
  if (failed && isBrowser) window.alert("تعذر حفظ التعديل: " + failed.error.message);
  if (outbox.length) flushOutbox();
}

function queueWrite(op: Op): Result {
  if (op.type === "insert") {
    const list = (Array.isArray(op.values) ? op.values : [op.values]).map((v: Row) => ({ ...v, id: v?.id || crypto.randomUUID() }));
    op = { ...op, values: Array.isArray(op.values) ? list : list[0] };
  }
  const before = view ? (view.tables[op.table] || []).filter(r => matches(r, op.filters)).map(r => r.id) : [];
  outbox.push(op);
  recompute();
  saveLocal();
  setTimeout(flushOutbox, 0);

  if (!op.returning) return { data: null, error: null };
  const rows = view?.tables[op.table] || [];
  let out: Row[];
  if (op.type === "insert") {
    const ids = (Array.isArray(op.values) ? op.values : [op.values]).map((v: Row) => v.id);
    out = ids.map((id: string) => rows.find(r => r.id === id) || { id });
  } else if (op.type === "update") {
    out = rows.filter(r => before.includes(r.id));
  } else {
    out = before.map(id => ({ id }));
  }
  out = clone(out);
  if (op.single) {
    return out.length === 1 ? { data: out[0], error: null } : { data: null, error: { message: "غير موجود.", code: "PGRST116" } };
  }
  return { data: out, error: null };
}

/* ===================== القراءة المحلية ===================== */

function localSelect(op: Op): Result {
  let rows = (view?.tables[op.table] || []).filter(r => matches(r, op.filters));
  if (op.order?.col) {
    const c = op.order.col, asc = op.order.asc !== false;
    const textual = !/(_at|_date)$/.test(c);
    rows = rows.slice().sort((a, b) => {
      const x = a[c] == null ? "" : String(a[c]);
      const y = b[c] == null ? "" : String(b[c]);
      const r = textual ? x.localeCompare(y, "ar") : (x < y ? -1 : x > y ? 1 : 0);
      return asc ? r : -r;
    });
  }
  const out = clone(rows);
  if (op.single) {
    return out.length === 1 ? { data: out[0], error: null } : { data: null, error: { message: "غير موجود.", code: "PGRST116" } };
  }
  return { data: out, error: null };
}

async function select(op: Op): Promise<Result> {
  if (!session) return call(op);
  if (!view) {
    const ok = await fetchSnapshot();
    if (!ok || !view) return { data: null, error: NET_ERROR };
  }
  return localSelect(op);
}

/* ===================== المزامنة مع الأجهزة الأخرى ===================== */

let pollTimer: ReturnType<typeof setInterval> | null = null;
let polling = false;

async function poll() {
  if (polling || writing || outbox.length || !session) return;
  if (isBrowser && document.visibilityState !== "visible") return;
  polling = true;
  try {
    if (!base) { if (await fetchSnapshot()) emitChange(); return; }
    const json = await post([{ type: "version" }]);
    const v = json?.results?.[0]?.data;
    if (v && base && String(v) !== base.version && !writing && !outbox.length) {
      if (await fetchSnapshot()) emitChange();
    }
  } finally {
    polling = false;
  }
}

function startPolling() {
  if (!isBrowser || pollTimer) return;
  pollTimer = setInterval(poll, SYNC_SECONDS * 1000);
  setTimeout(poll, 300);
}

if (isBrowser) {
  session = readJSON<Session>(SESSION_KEY);
  if (session) { loadLocal(); startPolling(); setTimeout(flushOutbox, 0); }
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") poll(); });
  window.addEventListener("online", () => { flushOutbox(); poll(); });
}

/* ===================== منشئ الاستعلامات (from) ===================== */

class Query implements PromiseLike<Result> {
  private kind: "select" | "insert" | "update" | "delete" = "select";
  private values: unknown;
  private filters: [string, unknown][] = [];
  private orderBy: { col: string; asc: boolean } | null = null;
  private isSingle = false;
  private returning = false;

  constructor(private table: string) {}

  select(_columns?: string) { void _columns; if (this.kind !== "select") this.returning = true; return this; }
  insert(values: unknown) { this.kind = "insert"; this.values = values; return this; }
  update(values: unknown) { this.kind = "update"; this.values = values; return this; }
  delete() { this.kind = "delete"; return this; }
  eq(col: string, val: unknown) { this.filters.push([col, val]); return this; }
  order(col: string, opts?: { ascending?: boolean }) { this.orderBy = { col, asc: opts?.ascending !== false }; return this; }
  single() { this.isSingle = true; return this; }

  private run(): Promise<Result> {
    const op: Op = {
      type: this.kind, table: this.table, values: this.values, filters: this.filters,
      order: this.orderBy, single: this.isSingle, returning: this.returning,
    };
    if (this.kind === "select") return select(op);
    // ترتيب المهام الخاص بالعضو يُحفظ فوراً أيضاً
    const ownOrder = this.table === "profiles" && this.kind === "update" &&
      Object.keys((this.values as Record<string, unknown>) || {}).join() === "task_order" &&
      this.filters.length === 1 && this.filters[0][0] === "id" && this.filters[0][1] === session?.user.id;
    if (session && view && (OPTIMISTIC.has(this.table) || ownOrder)) return Promise.resolve(queueWrite(op));
    return call(op);
  }

  then<A = Result, B = never>(onOk?: ((v: Result) => A | PromiseLike<A>) | null, onErr?: ((e: unknown) => B | PromiseLike<B>) | null): PromiseLike<A | B> {
    return this.run().then(onOk, onErr);
  }
}

/* ===================== الصور (Google Drive) ===================== */

const uploadedUrls = new Map<string, string>();

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/* ===================== الواجهة العامة ===================== */

type Channel = { on: (...args: unknown[]) => Channel; subscribe: () => Channel; _stop?: () => void };

export const supabase = {
  auth: {
    async getSession() {
      return { data: { session }, error: null };
    },
    onAuthStateChange(cb: (event: string, s: Session | null) => void) {
      authListeners.add(cb);
      return { data: { subscription: { unsubscribe: () => { authListeners.delete(cb); } } } };
    },
    async signUp({ email, password, options }: { email: string; password: string; options?: { data?: Record<string, string> } }) {
      const r = await call({ type: "auth", action: "signup", args: { email, password, ...(options?.data || {}) } });
      if (r.error) return { data: { session: null, user: null }, error: r.error };
      setSession(r.data.session, "SIGNED_IN");
      return { data: r.data, error: null };
    },
    async signInWithPassword({ email, password }: { email: string; password: string }) {
      const r = await call({ type: "auth", action: "login", args: { email, password } });
      if (r.error) return { data: { session: null, user: null }, error: r.error };
      setSession(r.data.session, "SIGNED_IN");
      return { data: r.data, error: null };
    },
    async signOut() {
      if (session) postWithToken([{ type: "auth", action: "logout" }], session.access_token);
      setSession(null, "SIGNED_OUT");
      return { error: null };
    },
    async updateUser({ password }: { password: string }) {
      const r = await call({ type: "auth", action: "update_password", args: { password } });
      return { data: r.data, error: r.error };
    },
  },

  from(table: string) {
    return new Query(table);
  },

  rpc(name: string, args?: Record<string, unknown>) {
    const op = { type: "rpc", name, args: args || {} };
    // تغيير الترتيب يظهر فوراً ويُرسل في الخلفية
    if (session && view && (name === "move_task" || name === "reset_task_order")) return Promise.resolve(queueWrite(op));
    return call(op);
  },

  storage: {
    from(bucket: string) {
      return {
        async upload(path: string, blob: Blob, opts?: { contentType?: string }) {
          try {
            const b64 = await blobToBase64(blob);
            const r = await call({ type: "upload", bucket, path, base64: b64, contentType: opts?.contentType || blob.type || "image/jpeg" });
            if (r.error) return { data: null, error: r.error };
            uploadedUrls.set(path, r.data.publicUrl);
            return { data: { path }, error: null };
          } catch {
            return { data: null, error: { message: "تعذر قراءة الصورة" } };
          }
        },
        getPublicUrl(path: string) {
          return { data: { publicUrl: uploadedUrls.get(path) || "" } };
        },
        async remove(paths: string[]) {
          call({ type: "remove", bucket, paths }); // في الخلفية
          return { data: null, error: null };
        },
      };
    },
  },

  // التطبيق يشترك هنا ليعيد تحميل البيانات عند وصول تغييرات من الأجهزة الأخرى
  channel(_name: string) {
    void _name;
    let cb: (() => void) | null = null;
    const ch: Channel = {
      on: (...args: unknown[]) => {
        const f = args[args.length - 1];
        if (typeof f === "function") cb = f as () => void;
        return ch;
      },
      subscribe: () => { if (cb) changeListeners.add(cb); startPolling(); return ch; },
      _stop: () => { if (cb) changeListeners.delete(cb); },
    };
    return ch;
  },

  removeChannel(ch: Channel) {
    ch._stop?.();
  },
};
