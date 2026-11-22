// طبقة توافق: تقدّم نفس واجهة supabase-js التي يستعملها التطبيق،
// لكنها تتصل بسكربت Google Apps Script (قاعدة البيانات في Google Sheets).
// بفضلها بقي page.tsx كما هو تقريباً.
import { API_URL, SYNC_SECONDS } from "./config";

type ApiError = { message: string; code?: string };
type Result<T = any> = { data: T; error: ApiError | null }; // eslint-disable-line @typescript-eslint/no-explicit-any
type User = { id: string; email: string };
type Session = { access_token: string; user: User };

const SESSION_KEY = "tasks-session";
let session: Session | null = null;
let lastVersion: string | null = null;
const authListeners = new Set<(event: string, s: Session | null) => void>();

function readStoredSession(): Session | null {
  try {
    const raw = typeof window !== "undefined" ? localStorage.getItem(SESSION_KEY) : null;
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}
if (typeof window !== "undefined") session = readStoredSession();

function setSession(s: Session | null, event: string) {
  session = s;
  try {
    if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else localStorage.removeItem(SESSION_KEY);
  } catch { /* التخزين غير متاح */ }
  authListeners.forEach(cb => { try { cb(event, s); } catch { /* تجاهل */ } });
}

// ===== تجميع الطلبات: كل العمليات في نفس اللحظة تُرسل في طلب واحد =====
type Pending = { op: Record<string, unknown>; resolve: (r: Result) => void };
let queue: Pending[] = [];
let scheduled = false;

function call(op: Record<string, unknown>): Promise<Result> {
  return new Promise(resolve => {
    queue.push({ op, resolve });
    if (!scheduled) {
      scheduled = true;
      setTimeout(flush, 0);
    }
  });
}

async function flush() {
  const batch = queue;
  queue = [];
  scheduled = false;
  const token = session?.access_token;
  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ token, ops: batch.map(b => b.op) }),
      redirect: "follow",
    });
    const json = await res.json();
    if (json.version) lastVersion = String(json.version);
    const results: { data?: unknown; error?: ApiError }[] = json.results || [];
    let authLost = false;
    batch.forEach((b, i) => {
      const r = results[i] || { error: json.error || { message: "استجابة غير صالحة من الخادم" } };
      if (r.error?.code === "AUTH" && token) authLost = true;
      b.resolve({ data: r.data ?? null, error: r.error ?? null });
    });
    if (authLost && session?.access_token === token) setSession(null, "SIGNED_OUT");
  } catch {
    batch.forEach(b => b.resolve({ data: null, error: { message: "تعذر الاتصال بالخادم. تحقق من الإنترنت." } }));
  }
}

// ===== منشئ الاستعلامات (from) =====
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

  then<A = Result, B = never>(onOk?: ((v: Result) => A | PromiseLike<A>) | null, onErr?: ((e: unknown) => B | PromiseLike<B>) | null): PromiseLike<A | B> {
    return call({
      type: this.kind, table: this.table, values: this.values, filters: this.filters,
      order: this.orderBy, single: this.isSingle, returning: this.returning,
    }).then(onOk, onErr);
  }
}

// ===== الصور (Google Drive) =====
const uploadedUrls = new Map<string, string>();

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// ===== المزامنة: التحقق الدوري من رقم إصدار البيانات =====
type Channel = { on: (...args: unknown[]) => Channel; subscribe: () => Channel; _stop?: () => void };

function makeChannel(): Channel {
  let callback: (() => void) | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  const ch: Channel = {
    on: (...args: unknown[]) => {
      const cb = args[args.length - 1];
      if (typeof cb === "function") callback = cb as () => void;
      return ch;
    },
    subscribe: () => {
      let busy = false;
      timer = setInterval(async () => {
        if (busy || !callback || !session || document.visibilityState !== "visible") return;
        busy = true;
        const before = lastVersion;
        const { data } = await call({ type: "version" });
        busy = false;
        if (data && before && String(data) !== before) callback();
      }, SYNC_SECONDS * 1000);
      return ch;
    },
  };
  ch._stop = () => { if (timer) clearInterval(timer); };
  return ch;
}

export const supabase = {
  auth: {
    async getSession() {
      if (!session) session = readStoredSession();
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
      if (session) await call({ type: "auth", action: "logout" });
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
    return call({ type: "rpc", name, args: args || {} });
  },

  storage: {
    from(bucket: string) {
      return {
        async upload(path: string, blob: Blob, opts?: { contentType?: string }) {
          try {
            const base64 = await blobToBase64(blob);
            const r = await call({ type: "upload", bucket, path, base64, contentType: opts?.contentType || blob.type || "image/jpeg" });
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
        remove(paths: string[]) {
          return call({ type: "remove", bucket, paths });
        },
      };
    },
  },

  channel(_name: string) {
    void _name;
    return makeChannel();
  },

  removeChannel(ch: Channel) {
    ch._stop?.();
  },
};
