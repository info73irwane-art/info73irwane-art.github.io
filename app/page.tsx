"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { FIREBASE_VAPID_KEY } from "@/lib/config";
import { getFcmToken, deleteFcmToken } from "@/lib/fcm";
import {
  Check, CheckCircle2, Circle, ClipboardList, FolderKanban, Plus,
  LogOut, RefreshCw, Search, Users, X, CalendarDays, User, Globe, Settings, Edit3, Trash2, RotateCcw, ChevronDown, Printer, FileText, Clock, ShieldCheck, Bell, Lightbulb, Camera, Image as ImageIcon, ChevronLeft, ChevronRight
} from "lucide-react";

type Profile = { id: string; full_name: string; email: string; avatar_url?: string; role: string; status?: string; password_changed?: boolean };
type Project = { id: string; name: string; color: string; status: string; created_at?: string };
type Task = {
  id: string; title: string; description: string | null; project_id: string | null;
  assignee_id: string | null; created_by: string | null; due_date: string | null;
  remind_days: number; priority: string; status: string; created_at: string;
  completed_at?: string | null;
};

function dayDiff(date: string) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const due = new Date(date + "T00:00:00");
  return Math.round((due.getTime() - today.getTime()) / 86400000);
}

function fmtDate(value: string) {
  const d = value.length <= 10 ? new Date(value + "T00:00:00") : new Date(value);
  return d.toLocaleDateString("ar-DZ-u-nu-latn", { day: "numeric", month: "long", year: "numeric" });
}

type WishItem = {
  id: string; title: string; details: string | null; status: string;
  created_by: string | null; created_at: string; acquired_at: string | null; image_urls: string[];
};
type PickedFile = { file: File; preview: string };

const WISH_BUCKET = "wishlist-images";
const MAX_IMAGES = 5;

// صور Google Drive: نطلب الحجم المناسب فقط (صغير للمصغّرات، كبير للعرض) من خوادم Google السريعة
function driveId(url: string) {
  const m = url.match(/[?&]id=([\w-]+)/);
  return url.includes("drive.google.com") && m ? m[1] : null;
}
function imgUrl(url: string, width: number) {
  const id = driveId(url);
  return id ? `https://lh3.googleusercontent.com/d/${id}=w${width}` : url;
}

function WishImg({ src, width, ...rest }: { src: string; width: number } & React.ImgHTMLAttributes<HTMLImageElement>) {
  const [failed, setFailed] = useState(false);
  const id = driveId(src);
  const url = failed && id ? `https://drive.google.com/thumbnail?id=${id}&sz=w${width}` : imgUrl(src, width);
  return <img loading="lazy" decoding="async" {...rest} src={url} alt="" onError={() => setFailed(true)} />;
}

// عارض الصور داخل التطبيق: تكبير، وتنقل بالسحب أو بالأسهم
function ImageViewer({ urls, index, onClose }: { urls: string[]; index: number; onClose: () => void }) {
  const [i, setI] = useState(index);
  const [loaded, setLoaded] = useState(false);
  const touchX = useRef<number | null>(null);
  const many = urls.length > 1;
  const go = (d: number) => { setLoaded(false); setI(p => (p + d + urls.length) % urls.length); };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (many && e.key === "ArrowLeft") go(1);
      else if (many && e.key === "ArrowRight") go(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [many, onClose]);

  // تحميل الصورة التالية والسابقة مسبقاً
  useEffect(() => {
    if (!many) return;
    [i + 1, i - 1].forEach(j => { const im = new Image(); im.src = imgUrl(urls[(j + urls.length) % urls.length], 1600); });
  }, [i, many, urls]);

  return (
    <div
      className="viewer"
      onClick={onClose}
      onTouchStart={e => { touchX.current = e.touches[0].clientX; }}
      onTouchEnd={e => {
        if (touchX.current === null) return;
        const dx = e.changedTouches[0].clientX - touchX.current;
        touchX.current = null;
        if (many && Math.abs(dx) > 50) go(dx < 0 ? 1 : -1);
      }}
    >
      <div className="viewer-stage">
        {!loaded && <WishImg key={"s" + i} src={urls[i]} width={300} loading="eager" className="blur" />}
        <WishImg key={"f" + i} src={urls[i]} width={1600} loading="eager" style={{ opacity: loaded ? 1 : 0 }} onLoad={() => setLoaded(true)} />
      </div>
      <button type="button" className="viewer-btn viewer-close" onClick={onClose} aria-label="إغلاق"><X size={22} /></button>
      {many && (
        <>
          <button type="button" className="viewer-btn viewer-nav prev" onClick={e => { e.stopPropagation(); go(-1); }} aria-label="السابقة"><ChevronRight size={26} /></button>
          <button type="button" className="viewer-btn viewer-nav next" onClick={e => { e.stopPropagation(); go(1); }} aria-label="التالية"><ChevronLeft size={26} /></button>
          <span className="viewer-count">{i + 1} / {urls.length}</span>
        </>
      )}
    </div>
  );
}

// قيمة منطقية تُحفظ في المتصفح (لحفظ حالة الطي/التوسيع)
function usePersistentBool(key: string, initial: boolean) {
  const [value, setValue] = useState(initial);
  useEffect(() => {
    try {
      const v = localStorage.getItem(key);
      if (v !== null) setValue(v === "1");
    } catch { /* التخزين غير متاح */ }
  }, [key]);
  const set = (v: boolean | ((p: boolean) => boolean)) =>
    setValue(prev => {
      const next = typeof v === "function" ? v(prev) : v;
      try { localStorage.setItem(key, next ? "1" : "0"); } catch { /* التخزين غير متاح */ }
      return next;
    });
  return [value, set] as const;
}

// تصغير الصورة قبل الرفع (صور الهاتف كبيرة)
async function compressImage(file: File, maxSide = 1280, quality = 0.8): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, w, h);
    const blob: Blob | null = await new Promise(res => canvas.toBlob(res, "image/jpeg", quality));
    return blob || file;
  } catch {
    return file;
  }
}

function pickFiles(current: PickedFile[], existingCount: number, incoming: File[]): PickedFile[] {
  const room = Math.max(0, MAX_IMAGES - existingCount - current.length);
  const added = incoming
    .filter(f => f.type.startsWith("image/"))
    .slice(0, room)
    .map(file => ({ file, preview: URL.createObjectURL(file) }));
  return [...current, ...added];
}

function ImagePicker({ existing, files, onAdd, onRemoveExisting, onRemoveFile }: {
  existing: string[];
  files: PickedFile[];
  onAdd: (files: File[]) => void;
  onRemoveExisting: (url: string) => void;
  onRemoveFile: (index: number) => void;
}) {
  const camRef = useRef<HTMLInputElement>(null);
  const galRef = useRef<HTMLInputElement>(null);
  const total = existing.length + files.length;
  const full = total >= MAX_IMAGES;
  return (
    <div className="img-picker">
      <div className="img-actions">
        <button type="button" className="secondary" disabled={full} onClick={() => camRef.current?.click()}>
          <Camera size={15} /> التقاط صورة
        </button>
        <button type="button" className="secondary" disabled={full} onClick={() => galRef.current?.click()}>
          <ImageIcon size={15} /> من المعرض
        </button>
        <span className="muted" style={{ fontSize: 12 }}>{total}/{MAX_IMAGES} صور</span>
      </div>
      <input
        ref={camRef} type="file" accept="image/*" capture="environment" style={{ display: "none" }}
        onChange={e => { onAdd(Array.from(e.target.files || [])); e.target.value = ""; }}
      />
      <input
        ref={galRef} type="file" accept="image/*" multiple style={{ display: "none" }}
        onChange={e => { onAdd(Array.from(e.target.files || [])); e.target.value = ""; }}
      />
      {total > 0 && (
        <div className="img-thumbs">
          {existing.map(url => (
            <div className="img-thumb" key={url}>
              <WishImg src={url} width={200} />
              <button type="button" onClick={() => onRemoveExisting(url)} aria-label="حذف الصورة"><X size={12} /></button>
            </div>
          ))}
          {files.map((f, i) => (
            <div className="img-thumb" key={f.preview}>
              <img src={f.preview} alt="" />
              <button type="button" onClick={() => onRemoveFile(i)} aria-label="حذف الصورة"><X size={12} /></button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const VAPID_PUBLIC_KEY = FIREBASE_VAPID_KEY;

// هل اشتراك التنبيهات الحالي أُنشئ بنفس مفتاح VAPID العام الحالي؟
function subMatchesKey(sub: PushSubscription) {
  const raw = sub.options?.applicationServerKey;
  if (!raw || !VAPID_PUBLIC_KEY) return false;
  const cur = new Uint8Array(raw);
  const key = urlBase64ToUint8Array(VAPID_PUBLIC_KEY);
  return cur.length === key.length && cur.every((b, i) => b === key[i]);
}

function urlBase64ToUint8Array(base64: string) {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function toDateInput(value: string) {
  if (value.length <= 10) return value;
  const d = new Date(value);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function fromDateInput(value: string) {
  return new Date(value + "T12:00:00").toISOString();
}

function dayOf(value: string) {
  const d = value.length <= 10 ? new Date(value + "T00:00:00") : new Date(value);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

// المهمة المؤجلة تعود إلى "قيد التنفيذ" عند وصول وقت التنبيه (إن كان لها موعد تسليم)
function effStatus(t: Task): string {
  if (t.status === "deferred" && t.due_date && dayDiff(t.due_date) <= t.remind_days) return "pending";
  return t.status;
}

// الأقرب موعداً أولاً، ثم المهام بدون موعد بحسب تاريخ الاستلام الأقدم فالأقدم
function compareTasks(a: Task, b: Task) {
  if (a.due_date && b.due_date) return a.due_date.localeCompare(b.due_date) || a.created_at.localeCompare(b.created_at);
  if (a.due_date) return -1;
  if (b.due_date) return 1;
  return a.created_at.localeCompare(b.created_at);
}

function taskStatusInfo(t: Task): { label: string; kind: string } {
  const st = effStatus(t);
  if (st === "completed") return { label: "مكتملة", kind: "done" };
  if (st === "cancelled") return { label: "ملغاة", kind: "cancelled" };
  if (st === "deferred") return { label: "مؤجلة", kind: "deferred" };
  const returned = t.status === "deferred" ? " · عادت من التأجيل" : "";
  if (!t.due_date) return { label: "بدون موعد" + returned, kind: "none" };
  const d = dayDiff(t.due_date);
  if (d < 0) return { label: `متأخرة ${Math.abs(d)} يوم` + returned, kind: "late" };
  if (d === 0) return { label: "تُسلم اليوم" + returned, kind: "soon" };
  return { label: `باقي ${d} يوم` + returned, kind: d <= t.remind_days ? "soon" : "ok" };
}

// فرق الأيام بين موعد التسليم وتاريخ التسليم الفعلي (موجب = قبل الموعد، سالب = تأخر)
function deliveryDiff(t: Task): number | null {
  if (t.status !== "completed" || !t.due_date || !t.completed_at) return null;
  return Math.round((dayOf(t.due_date).getTime() - dayOf(t.completed_at).getTime()) / 86400000);
}

function reportNote(t: Task): { text: string; kind: string } {
  const st = effStatus(t);
  if (st === "completed") {
    const dd = deliveryDiff(t);
    if (dd === null) return { text: "—", kind: "" };
    if (dd > 0) return { text: `قبل الموعد بـ ${dd} يوم`, kind: "ahead" };
    if (dd === 0) return { text: "في الموعد", kind: "ahead" };
    return { text: `متأخرة ${-dd} يوم`, kind: "late" };
  }
  if (st === "cancelled") return { text: "ملغاة", kind: "" };
  if (st === "deferred") return { text: "مؤجلة", kind: "" };
  if (!t.due_date) return { text: "بدون موعد", kind: "" };
  const d = dayDiff(t.due_date);
  if (d < 0) return { text: `متأخرة ${-d} يوم (لم تُسلَّم)`, kind: "late" };
  if (d === 0) return { text: "تُسلَّم اليوم", kind: "" };
  return { text: `متبقٍ ${d} يوم`, kind: "" };
}

const STATUS_LABEL: Record<string, string> = {
  pending: "قيد التنفيذ", completed: "مكتملة", cancelled: "ملغاة", deferred: "مؤجلة",
};

const emptyProjectTask = { title: "", description: "", assignee_id: "", due_date: "", remind_days: 3 };

export default function Home() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [session, setSession] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  // المصادقة
  const [isSignUp, setIsSignUp] = useState(false);
  const [fullName, setFullName] = useState("");
  const [avatarUrl, setAvatarUrl] = useState("");
  const [email, setEmail] = useState("");
  const [showReport, setShowReport] = useState(false);
  const [wishlist, setWishlist] = useState<WishItem[]>([]);
  const [showWishlist, setShowWishlist] = useState(false);
  const [wishFilter, setWishFilter] = useState<"thinking" | "acquired" | "all">("thinking");
  const [openWish, setOpenWish] = useState<Record<string, boolean>>({});
  const [viewer, setViewer] = useState<{ urls: string[]; index: number } | null>(null);
  const [showWishForm, setShowWishForm] = usePersistentBool("ui:wishForm", true);
  const [showAddTask, setShowAddTask] = usePersistentBool("ui:addTask", true);
  const [wishForm, setWishForm] = useState({ title: "", details: "" });
  const [wishFiles, setWishFiles] = useState<PickedFile[]>([]);
  const [editingWishId, setEditingWishId] = useState<string | null>(null);
  const [wishEdit, setWishEdit] = useState({ title: "", details: "", created_date: "", acquired_date: "", images: [] as string[], removed: [] as string[] });
  const [wishEditFiles, setWishEditFiles] = useState<PickedFile[]>([]);
  const [reportMember, setReportMember] = useState("all");
  const [reportPeriod, setReportPeriod] = useState<"all" | "range">("range");
  const [reportFrom, setReportFrom] = useState(toDateInput(new Date().toISOString()).slice(0, 8) + "01");
  const [reportTo, setReportTo] = useState(toDateInput(new Date().toISOString()));
  const [password, setPassword] = useState("");
  const [myProfile, setMyProfile] = useState<Profile | null>(null);
  const [profileLoaded, setProfileLoaded] = useState(false);
  const [allProfiles, setAllProfiles] = useState<Profile[]>([]);
  const [showAdmin, setShowAdmin] = useState(false);
  const [passwordForm, setPasswordForm] = useState({ pw1: "", pw2: "" });
  const [pushOn, setPushOn] = useState(false);

  const approved = myProfile?.status === "approved";
  const isAdmin = approved && myProfile?.role === "admin";
  const [authError, setAuthError] = useState("");
  const [authSuccess, setAuthSuccess] = useState("");

  // بيانات التطبيق
  const [tasks, setTasks] = useState<Task[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [members, setMembers] = useState<Profile[]>([]);

  // التنقل والفلاتر (مهامي الشخصية أولاً)
  const [viewMode, setViewMode] = useState<"my" | "team">("my");
  const [selectedMemberFilter, setSelectedMemberFilter] = useState<string>("all");
  const [filter, setFilter] = useState("pending_and_overdue");
  const [search, setSearch] = useState("");

  // نموذج إضافة مهمة
  const [form, setForm] = useState({
    title: "", description: "", project_id: "", assignee_id: "",
    due_date: "", remind_days: 3, priority: "normal"
  });

  // النوافذ المنبثقة
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [showProjectForm, setShowProjectForm] = useState(false);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [newProject, setNewProject] = useState({ name: "", color: "#b45309", created_date: "" });

  const [profileForm, setProfileForm] = useState({ full_name: "", avatar_url: "" });
  const [busy, setBusy] = useState(false);
  const [confirmDialog, setConfirmDialog] = useState<{ message: string; onConfirm: () => void; title?: string; confirmLabel?: string } | null>(null);
  const [projectFilter, setProjectFilter] = useState("all");
  const [openTasks, setOpenTasks] = useState<Record<string, boolean>>({});
  const [showProjects, setShowProjects] = useState(true);
  const [showTasks, setShowTasks] = useState(true);
  const [showTeam, setShowTeam] = useState(false);
  const [viewingProjectId, setViewingProjectId] = useState<string | null>(null);
  const [addTaskProject, setAddTaskProject] = useState<Project | null>(null);
  const [projectTaskForm, setProjectTaskForm] = useState({ ...emptyProjectTask });

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      if (data.session?.user) {
        loadUserProfile(data.session.user.id);
      }
      setLoading(false);
    });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
      if (s?.user) loadUserProfile(s.user.id);
    });
    return () => listener.subscription.unsubscribe();
  }, []);

  async function loadUserProfile(userId: string) {
    const { data } = await supabase
      .from("profiles")
      .select("id,full_name,email,avatar_url,role,status,password_changed")
      .eq("id", userId)
      .single();
    if (data) {
      setMyProfile(data as Profile);
      setProfileForm({ full_name: data.full_name || "", avatar_url: data.avatar_url || "" });
    }
    setProfileLoaded(true);
  }

  useEffect(() => {
    if (session && approved) {
      loadData(true);
      const channel = supabase
        .channel("realtime-tasks")
        .on("postgres_changes", { event: "*", schema: "public" }, () => loadData())
        .subscribe();
      const refresh = () => { if (document.visibilityState === "visible") loadData(); };
      document.addEventListener("visibilitychange", refresh);
      window.addEventListener("focus", refresh);
      window.addEventListener("online", refresh);
      const timer = setInterval(refresh, 30000);
      return () => {
        supabase.removeChannel(channel);
        document.removeEventListener("visibilitychange", refresh);
        window.removeEventListener("focus", refresh);
        window.removeEventListener("online", refresh);
        clearInterval(timer);
      };
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.user?.id, approved]);

  // أثناء انتظار الموافقة: إعادة فحص الحالة كل 15 ثانية
  useEffect(() => {
    if (!session?.user?.id || approved || !profileLoaded) return;
    const t = setInterval(() => loadUserProfile(session.user.id), 15000);
    return () => clearInterval(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.user?.id, approved, profileLoaded]);

  // حالة التنبيهات على هذا الجهاز
  useEffect(() => {
    if (!showProfileModal || typeof window === "undefined" || !("serviceWorker" in navigator) || !("PushManager" in window)) return;
    navigator.serviceWorker.ready
      .then(reg => reg.pushManager.getSubscription())
      .then(sub => setPushOn(!!sub && subMatchesKey(sub)))
      .catch(() => {});
  }, [showProfileModal]);

  async function loadData(showSpinner = false) {
    if (showSpinner) setLoading(true);
    const [t, p, m, w] = await Promise.all([
      supabase.from("tasks").select("*").order("created_at", { ascending: false }),
      supabase.from("projects").select("*").order("name"),
      supabase.from("profiles").select("id,full_name,email,avatar_url,role,status,password_changed").order("full_name"),
      supabase.from("wishlist_items").select("*").order("created_at", { ascending: false })
    ]);
    if (t.error || p.error || m.error) {
      setAuthError("تعذر تحميل البيانات.");
    } else {
      setTasks(t.data || []);
      setProjects(p.data || []);
      const profs = (m.data || []) as Profile[];
      setAllProfiles(profs);
      setMembers(profs.filter(p => p.status === "approved"));
      setMyProfile(prev => profs.find(p => p.id === prev?.id) ?? prev);
      if (!w.error) setWishlist((w.data || []) as WishItem[]);
      setAuthError("");
    }
    setLoading(false);
  }

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    const mail = email.trim().toLowerCase();
    if (!mail || !password) return;
    setBusy(true);
    setAuthError("");
    setAuthSuccess("");

    if (isSignUp) {
      if (password.length < 6) {
        setAuthError("كلمة المرور يجب أن تكون 6 أحرف على الأقل.");
        setBusy(false);
        return;
      }
      const name = fullName.trim() || mail.split("@")[0];
      const { data, error } = await supabase.auth.signUp({
        email: mail,
        password,
        options: {
          data: {
            full_name: name,
            avatar_url: avatarUrl.trim() || `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(name)}`
          }
        }
      });
      if (error) {
        setAuthError("تعذر إرسال الطلب: " + error.message);
      } else if (!data.session) {
        setAuthSuccess("تم إنشاء الحساب. افتح رسالة التأكيد في بريدك إن وصلتك، ثم سجّل الدخول وسيراجع المسؤول طلبك.");
        setIsSignUp(false);
      }
      // إن وُجدت جلسة، ينتقل التطبيق تلقائياً إلى شاشة "بانتظار الموافقة"
    } else {
      const { error } = await supabase.auth.signInWithPassword({ email: mail, password });
      if (error) setAuthError("البريد الإلكتروني أو كلمة المرور غير صحيحة.");
    }
    setBusy(false);
  }

  async function updateProfile(e: React.FormEvent) {
    e.preventDefault();
    if (!session?.user?.id) return;
    setBusy(true);
    const { data, error } = await supabase.from("profiles").update({
      full_name: profileForm.full_name.trim(),
      avatar_url: profileForm.avatar_url.trim()
    }).eq("id", session.user.id).select("id");

    if (error) alert("تعذر تحديث البروفايل: " + error.message);
    else if (!data || data.length === 0) alert("لم يتم حفظ التعديلات. تأكد من سياسة التعديل (RLS) على جدول profiles في Supabase.");
    else {
      setShowProfileModal(false);
      await loadData();
    }
    setBusy(false);
  }

  async function changePassword() {
    const { pw1, pw2 } = passwordForm;
    if (pw1.length < 6) { alert("كلمة المرور الجديدة يجب أن تكون 6 أحرف على الأقل."); return; }
    if (pw1 !== pw2) { alert("كلمتا المرور غير متطابقتين."); return; }
    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password: pw1 });
    if (error) {
      alert("تعذر تغيير كلمة المرور: " + error.message);
    } else {
      await supabase.from("profiles").update({ password_changed: true }).eq("id", session.user.id);
      setMyProfile(prev => (prev ? { ...prev, password_changed: true } : prev));
      setPasswordForm({ pw1: "", pw2: "" });
      alert("تم تغيير كلمة المرور بنجاح.");
    }
    setBusy(false);
  }

  async function enableNotifications() {
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
      alert("هذا المتصفح لا يدعم التنبيهات. على iPhone ثبّت التطبيق على الشاشة الرئيسية ثم افتحه منها.");
      return;
    }
    if (!VAPID_PUBLIC_KEY) {
      alert("مفتاح التنبيهات (FIREBASE_VAPID_KEY) غير مضبوط في ملف lib/config.ts.");
      return;
    }
    const perm = await Notification.requestPermission();
    if (perm !== "granted") {
      alert("لم يُسمح بالتنبيهات. فعّلها من إعدادات المتصفح لهذا الموقع ثم أعد المحاولة.");
      return;
    }
    try {
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      // اشتراك قديم أُنشئ بمفتاح مختلف: نلغيه وننشئ اشتراكاً جديداً
      if (sub && !subMatchesKey(sub)) {
        await sub.unsubscribe();
        sub = null;
      }
      // Firebase ينشئ الاشتراك (بنفس المفتاح) ويعطينا رمز هذا الجهاز
      const token = await getFcmToken(reg);
      const { error } = await supabase.rpc("register_push", { p_token: token });
      if (error) { alert("تعذر حفظ اشتراك التنبيهات: " + error.message); return; }
      setPushOn(true);
    } catch (err) {
      alert("تعذر تفعيل التنبيهات: " + (err instanceof Error ? err.message : ""));
    }
  }

  async function disableNotifications() {
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        const token = await getFcmToken(reg).catch(() => null);
        if (token) await supabase.rpc("unregister_push", { p_token: token });
        await deleteFcmToken().catch(() => {});
        await sub.unsubscribe().catch(() => false);
      }
      setPushOn(false);
    } catch {
      alert("تعذر إيقاف التنبيهات.");
    }
  }

  // تنبيه المكلَّف يرسله الخادم (Apps Script) تلقائياً عند حفظ المهمة، فلا حاجة لطلب إضافي
  async function notifyAssignee(taskId: string) {
    void taskId;
  }

  async function setMemberStatus(p: Profile, status: "approved" | "rejected") {
    const { data, error } = await supabase.from("profiles").update({ status }).eq("id", p.id).select("id");
    if (error) alert("تعذر تحديث العضو: " + error.message);
    else if (!data || data.length === 0) alert("لم يتم التحديث. تأكد من تشغيل سكربت الإعداد في Supabase.");
    else await loadData();
  }

  async function setMemberRole(p: Profile, role: "admin" | "member") {
    const { data, error } = await supabase.from("profiles").update({ role }).eq("id", p.id).select("id");
    if (error) alert("تعذر تحديث الصلاحية: " + error.message);
    else if (!data || data.length === 0) alert("لم يتم التحديث. تأكد من تشغيل سكربت الإعداد في Supabase.");
    else await loadData();
  }

  function askResetPassword(p: Profile) {
    setConfirmDialog({
      title: "إعادة كلمة المرور",
      message: `إعادة كلمة مرور "${p.full_name || p.email}" إلى 0000؟ سيُطلب منه تغييرها بعد الدخول.`,
      confirmLabel: "نعم، أعدها",
      onConfirm: async () => {
        const { error } = await supabase.rpc("admin_reset_password", { target: p.id });
        if (error) alert("تعذرت إعادة كلمة المرور: " + error.message);
        else { alert("تمت إعادة كلمة المرور إلى 0000."); await loadData(); }
      },
    });
  }

  function askSuspend(p: Profile) {
    setConfirmDialog({
      title: "إيقاف العضو",
      message: `إيقاف حساب "${p.full_name || p.email}"؟ لن يتمكن من الدخول إلى المهام، وتبقى مهامه كما هي.`,
      confirmLabel: "نعم، أوقفه",
      onConfirm: () => setMemberStatus(p, "rejected"),
    });
  }

  function toggleWish(id: string) {
    setOpenWish(prev => ({ ...prev, [id]: !prev[id] }));
  }

  async function uploadWishImages(files: PickedFile[]): Promise<string[]> {
    const urls: string[] = [];
    for (const f of files) {
      const blob = await compressImage(f.file);
      const ext = blob.type === "image/png" ? "png" : blob.type === "image/webp" ? "webp" : "jpg";
      const path = `${session.user.id}/${crypto.randomUUID()}.${ext}`;
      const { error } = await supabase.storage.from(WISH_BUCKET).upload(path, blob, { contentType: blob.type || "image/jpeg" });
      if (error) throw new Error(error.message);
      urls.push(supabase.storage.from(WISH_BUCKET).getPublicUrl(path).data.publicUrl);
    }
    return urls;
  }

  async function removeWishImages(urls: string[]) {
    const paths = urls.map(u => u.split(`/${WISH_BUCKET}/`)[1]).filter(Boolean);
    if (paths.length > 0) await supabase.storage.from(WISH_BUCKET).remove(paths);
  }

  async function addWish(e: React.FormEvent) {
    e.preventDefault();
    if (!wishForm.title.trim() || !session?.user?.id) return;
    setBusy(true);
    try {
      const urls = await uploadWishImages(wishFiles);
      const { error } = await supabase.from("wishlist_items").insert({
        title: wishForm.title.trim(),
        details: wishForm.details.trim() || null,
        status: "thinking",
        created_by: session.user.id,
        image_urls: urls
      });
      if (error) {
        alert("تعذرت الإضافة: " + error.message);
        await removeWishImages(urls);
      } else {
        wishFiles.forEach(f => URL.revokeObjectURL(f.preview));
        setWishForm({ title: "", details: "" });
        setWishFiles([]);
        await loadData();
      }
    } catch (err) {
      alert("تعذر رفع الصور: " + (err instanceof Error ? err.message : ""));
    }
    setBusy(false);
  }

  async function toggleAcquired(w: WishItem) {
    const acquiring = w.status !== "acquired";
    const { data, error } = await supabase.from("wishlist_items").update({
      status: acquiring ? "acquired" : "thinking",
      acquired_at: acquiring ? new Date().toISOString() : null
    }).eq("id", w.id).select("id");
    if (error) alert("تعذر التحديث: " + error.message);
    else if (!data || data.length === 0) alert("لم يتم التحديث. تأكد من تشغيل سكربت التفكير في Supabase.");
    else await loadData();
  }

  function startEditWish(w: WishItem) {
    setEditingWishId(w.id);
    setWishEdit({
      title: w.title,
      details: w.details || "",
      created_date: toDateInput(w.created_at),
      acquired_date: w.acquired_at ? toDateInput(w.acquired_at) : "",
      images: [...(w.image_urls || [])],
      removed: []
    });
    setWishEditFiles([]);
  }

  function cancelEditWish() {
    wishEditFiles.forEach(f => URL.revokeObjectURL(f.preview));
    setEditingWishId(null);
    setWishEditFiles([]);
  }

  async function saveWishEdit(e: React.FormEvent, w: WishItem) {
    e.preventDefault();
    if (!wishEdit.title.trim()) return;
    setBusy(true);
    try {
      const newUrls = await uploadWishImages(wishEditFiles);
      const patch: Record<string, string | string[] | null> = {
        title: wishEdit.title.trim(),
        details: wishEdit.details.trim() || null,
        image_urls: [...wishEdit.images, ...newUrls]
      };
      if (wishEdit.created_date && wishEdit.created_date !== toDateInput(w.created_at)) {
        patch.created_at = fromDateInput(wishEdit.created_date);
      }
      if (w.status === "acquired" && wishEdit.acquired_date &&
          wishEdit.acquired_date !== (w.acquired_at ? toDateInput(w.acquired_at) : "")) {
        patch.acquired_at = fromDateInput(wishEdit.acquired_date);
      }
      const { data, error } = await supabase.from("wishlist_items").update(patch).eq("id", w.id).select("id");
      if (error) {
        alert("تعذر الحفظ: " + error.message);
        await removeWishImages(newUrls);
      } else if (!data || data.length === 0) {
        alert("لم يتم الحفظ. تأكد من تشغيل سكربت التفكير في Supabase.");
        await removeWishImages(newUrls);
      } else {
        await removeWishImages(wishEdit.removed);
        wishEditFiles.forEach(f => URL.revokeObjectURL(f.preview));
        setEditingWishId(null);
        setWishEditFiles([]);
        await loadData();
      }
    } catch (err) {
      alert("تعذر رفع الصور: " + (err instanceof Error ? err.message : ""));
    }
    setBusy(false);
  }

  function askDeleteWish(w: WishItem) {
    setConfirmDialog({
      message: `حذف "${w.title}" من قائمة التفكير نهائياً؟`,
      onConfirm: async () => {
        const { data, error } = await supabase.from("wishlist_items").delete().eq("id", w.id).select("id");
        if (error) alert("تعذر الحذف: " + error.message);
        else if (!data || data.length === 0) alert("لم يتم الحذف. الحذف لمن أدرج العنصر أو للمسؤول فقط.");
        else {
          await removeWishImages(w.image_urls || []);
          await loadData();
        }
      },
    });
  }

  async function signOut() {
    await supabase.auth.signOut();
    setTasks([]); setProjects([]); setMembers([]); setAllProfiles([]);
    setMyProfile(null); setProfileLoaded(false); setPassword(""); setShowAdmin(false); setShowProfileModal(false);
    setWishlist([]); setShowWishlist(false);
    setAuthSuccess(""); setAuthError("");
  }

  async function addProject(e: React.FormEvent) {
    e.preventDefault();
    if (!newProject.name.trim() || !session?.user?.id) return;
    setBusy(true);
    const { error } = await supabase.from("projects").insert({
      name: newProject.name.trim(),
      color: newProject.color,
      created_by: session.user.id,
      ...(newProject.created_date ? { created_at: fromDateInput(newProject.created_date) } : {})
    });
    if (!error) {
      setNewProject({ name: "", color: "#b45309", created_date: "" });
      setShowProjectForm(false);
      await loadData();
    }
    setBusy(false);
  }

  async function updateProject(e: React.FormEvent) {
    e.preventDefault();
    if (!editingProject) return;
    setBusy(true);
    const { error } = await supabase.from("projects").update({
      name: editingProject.name,
      color: editingProject.color,
      ...(editingProject.created_at ? { created_at: editingProject.created_at } : {})
    }).eq("id", editingProject.id);

    if (!error) {
      setEditingProject(null);
      await loadData();
    }
    setBusy(false);
  }

  async function addTask(e: React.FormEvent) {
    e.preventDefault();
    if (!form.title.trim() || !session?.user?.id) return;
    setBusy(true);
    const assignedUser = form.assignee_id || session.user.id;
    const { data: created, error } = await supabase.from("tasks").insert({
      title: form.title.trim(),
      description: form.description.trim() || null,
      project_id: activeProjects.some(p => p.id === form.project_id) ? form.project_id : null,
      assignee_id: assignedUser,
      created_by: session.user.id,
      due_date: form.due_date || null,
      remind_days: Number(form.remind_days),
      priority: form.priority,
      status: "pending"
    }).select("id").single();
    if (error) alert("لم نتمكن من إضافة المهمة: " + error.message);
    else {
      if (created?.id) notifyAssignee(created.id);
      setForm({ title: "", description: "", project_id: "", assignee_id: "", due_date: "", remind_days: 3, priority: "normal" });
      await loadData();
    }
    setBusy(false);
  }

  async function updateTask(e: React.FormEvent) {
    e.preventDefault();
    if (!editingTask || !editingTask.title.trim()) return;
    const original = tasks.find(t => t.id === editingTask.id);
    if (original && !canManage(original)) {
      alert("لا تملك صلاحية تعديل هذه المهمة.");
      return;
    }
    if (!editingTask.assignee_id) {
      alert("تحديد المكلف بالمهمة واجب لحفظها.");
      return;
    }
    setBusy(true);
    const { error } = await supabase.from("tasks").update({
      title: editingTask.title.trim(),
      description: editingTask.description?.trim() || null,
      project_id: editingTask.project_id || null,
      assignee_id: editingTask.assignee_id,
      due_date: editingTask.due_date || null,
      remind_days: Number(editingTask.remind_days),
      priority: editingTask.priority,
      created_at: editingTask.created_at
    }).eq("id", editingTask.id);

    if (error) alert("تعذر تعديل المهمة: " + error.message);
    else {
      if (editingTask.assignee_id && editingTask.assignee_id !== tasks.find(t => t.id === editingTask.id)?.assignee_id) notifyAssignee(editingTask.id);
      setEditingTask(null);
      await loadData();
    }
    setBusy(false);
  }

  async function setTaskStatus(task: Task, status: "pending" | "completed" | "cancelled" | "deferred") {
    const cancelRelated = status === "cancelled" || task.status === "cancelled";
    if (!(cancelRelated ? canManage(task) : canProgress(task))) {
      alert(cancelRelated ? "لا تملك صلاحية إلغاء هذه المهمة." : "الإنجاز والتأجيل لصاحب المهمة أو المسؤول فقط.");
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const patch: any = { status };
    if (status === "completed") {
      patch.completed_at = new Date().toISOString();
      patch.completed_by = session.user.id;
    } else {
      patch.completed_at = null;
      patch.completed_by = null;
    }
    if (status === "cancelled") patch.cancelled_at = new Date().toISOString();
    else patch.cancelled_at = null;
    const { error } = await supabase.from("tasks").update(patch).eq("id", task.id);
    if (error) alert("تعذر تحديث المهمة: " + error.message);
    else await loadData();
  }

  function toggleTask(id: string) {
    setOpenTasks(prev => ({ ...prev, [id]: !prev[id] }));
  }

  async function addTaskToProject(e: React.FormEvent) {
    e.preventDefault();
    if (!addTaskProject || !projectTaskForm.title.trim() || !session?.user?.id) return;
    setBusy(true);
    const { data: created, error } = await supabase.from("tasks").insert({
      title: projectTaskForm.title.trim(),
      description: projectTaskForm.description.trim() || null,
      project_id: addTaskProject.id,
      assignee_id: projectTaskForm.assignee_id || session.user.id,
      created_by: session.user.id,
      due_date: projectTaskForm.due_date || null,
      remind_days: Number(projectTaskForm.remind_days),
      priority: "normal",
      status: "pending"
    }).select("id").single();
    if (error) alert("لم نتمكن من إضافة المهمة: " + error.message);
    else {
      if (created?.id) notifyAssignee(created.id);
      setAddTaskProject(null);
      setProjectTaskForm({ ...emptyProjectTask });
      await loadData();
    }
    setBusy(false);
  }

  function deleteTask(task: Task) {
    if (!isAdmin) { alert("الحذف النهائي من صلاحيات المسؤولين فقط."); return; }
    setConfirmDialog({
      message: `حذف المهمة "${task.title}" نهائياً؟ لا يمكن التراجع عن هذا الإجراء.`,
      onConfirm: () => doDeleteTask(task),
    });
  }

  function deleteProject(p: Project) {
    if (!isAdmin) { alert("الحذف النهائي من صلاحيات المسؤولين فقط."); return; }
    const count = tasks.filter(t => t.project_id === p.id).length;
    const note = count > 0 ? ` ستبقى ${count} مهمة مرتبطة به بدون مشروع.` : "";
    setConfirmDialog({
      message: `حذف المشروع "${p.name}" نهائياً؟${note} لا يمكن التراجع عن هذا الإجراء.`,
      onConfirm: () => doDeleteProject(p),
    });
  }

  async function doDeleteTask(task: Task) {
    const { data, error } = await supabase.from("tasks").delete().eq("id", task.id).select("id");
    if (error) alert("تعذر حذف المهمة: " + error.message);
    else if (!data || data.length === 0) alert("لم يتم الحذف. تأكد من سياسة الحذف (RLS) في Supabase.");
    else await loadData();
  }

  async function setProjectStatus(p: Project, status: "active" | "cancelled") {
    const { error } = await supabase.from("projects").update({ status }).eq("id", p.id);
    if (error) alert("تعذر تحديث المشروع: " + error.message);
    else {
      setEditingProject(null);
      await loadData();
    }
  }

  async function doDeleteProject(p: Project) {
    setBusy(true);
    // المهام المرتبطة تبقى بدون مشروع تلقائياً (ON DELETE SET NULL في قاعدة البيانات)
    const { data, error } = await supabase.from("projects").delete().eq("id", p.id).select("id");
    if (error) alert("تعذر حذف المشروع: " + error.message);
    else if (!data || data.length === 0) alert("لم يتم الحذف. تأكد من سياسة الحذف (RLS) في Supabase.");
    else {
      setEditingProject(null);
      await loadData();
    }
    setBusy(false);
  }

  const getMember = (id: string | null) => members.find(m => m.id === id);
  const projectObj = (id: string | null) => projects.find(p => p.id === id);
  const currentUserProfile = getMember(session?.user?.id);
  // التعديل والإلغاء: المسؤول، أو المكلَّف بالمهمة، أو من أنشأها
  const canManage = (t: Task) =>
    isAdmin || (!!session?.user?.id && (t.assignee_id === session.user.id || t.created_by === session.user.id));
  // الإنجاز والتأجيل والاستئناف: المسؤول، أو المكلَّف بالمهمة
  const canProgress = (t: Task) => isAdmin || (!!session?.user?.id && t.assignee_id === session.user.id);
  const pendingProfiles = allProfiles.filter(p => p.status === "pending");
  const approvedProfiles = allProfiles.filter(p => p.status === "approved");
  const rejectedProfiles = allProfiles.filter(p => p.status === "rejected");
  const adminCount = approvedProfiles.filter(p => p.role === "admin").length;
  const thinkingCount = wishlist.filter(w => w.status !== "acquired").length;
  const acquiredCount = wishlist.length - thinkingCount;
  const wishFiltered = wishlist
    .filter(w => wishFilter === "all" || (wishFilter === "acquired" ? w.status === "acquired" : w.status !== "acquired"))
    .sort((a, b) =>
      (a.status === b.status ? 0 : a.status === "acquired" ? 1 : -1) ||
      (b.acquired_at || b.created_at).localeCompare(a.acquired_at || a.created_at));
  const activeProjects = projects.filter(p => p.status !== "cancelled");

  useEffect(() => {
    setForm(prev =>
      prev.project_id && !projects.some(p => p.id === prev.project_id && p.status !== "cancelled")
        ? { ...prev, project_id: "" }
        : prev
    );
  }, [projects]);

  const baseTasks = useMemo(() => {
    if (viewMode === "my") {
      return tasks.filter(t => t.assignee_id === session?.user?.id);
    }
    if (selectedMemberFilter !== "all") {
      return tasks.filter(t => t.assignee_id === selectedMemberFilter);
    }
    return tasks;
  }, [tasks, viewMode, selectedMemberFilter, session?.user?.id]);

  const scopedTasks = useMemo(() => {
    if (projectFilter === "all") return baseTasks;
    if (projectFilter === "none") return baseTasks.filter(t => !t.project_id);
    return baseTasks.filter(t => t.project_id === projectFilter);
  }, [baseTasks, projectFilter]);

  const filtered = useMemo(() => scopedTasks.filter(t => {
    const st = effStatus(t);
    const isOverdue = st === "pending" && !!t.due_date && dayDiff(t.due_date) < 0;
    const matchesFilter =
      filter === "all" ||
      (filter === "pending_and_overdue" && st === "pending") ||
      (filter === "overdue" && isOverdue) ||
      (filter === "deferred" && st === "deferred") ||
      (filter === "completed" && st === "completed") ||
      (filter === "cancelled" && st === "cancelled");

    const q = search.trim().toLowerCase();
    return matchesFilter && (!q || t.title.toLowerCase().includes(q) || (t.description || "").toLowerCase().includes(q));
  }).sort(compareTasks), [scopedTasks, filter, search]);

  const pendingAndOverdueCount = baseTasks.filter(t => effStatus(t) === "pending").length;
  const overdueCount = baseTasks.filter(t => effStatus(t) === "pending" && !!t.due_date && dayDiff(t.due_date) < 0).length;
  const completedCount = baseTasks.filter(t => t.status === "completed").length;
  const tc = {
    pending: scopedTasks.filter(t => effStatus(t) === "pending").length,
    overdue: scopedTasks.filter(t => effStatus(t) === "pending" && !!t.due_date && dayDiff(t.due_date) < 0).length,
    deferred: scopedTasks.filter(t => effStatus(t) === "deferred").length,
    completed: scopedTasks.filter(t => t.status === "completed").length,
    cancelled: scopedTasks.filter(t => t.status === "cancelled").length,
    all: scopedTasks.length,
  };

  const statusOrder: Record<string, number> = { pending: 0, deferred: 1, completed: 2, cancelled: 3 };
  const viewProj = projects.find(p => p.id === viewingProjectId) ?? null;
  const viewTasks = viewProj
    ? tasks
        .filter(t => t.project_id === viewProj.id)
        .sort((a, b) =>
          (statusOrder[effStatus(a)] ?? 4) - (statusOrder[effStatus(b)] ?? 4) || compareTasks(a, b))
    : [];
  const viewDone = viewTasks.filter(t => t.status === "completed").length;

  // ===== التقارير =====
  const reportTasks = tasks
    .filter(t =>
      (reportMember === "all" || t.assignee_id === reportMember) &&
      (reportPeriod === "all" ||
        [t.created_at, t.due_date, t.completed_at].some(v => {
          if (!v) return false;
          const d = toDateInput(v);
          return (!reportFrom || d >= reportFrom) && (!reportTo || d <= reportTo);
        })))
    .sort(compareTasks);

  const rs = { total: reportTasks.length, completed: 0, onTime: 0, lateDone: 0, inProgress: 0, overdue: 0, deferred: 0, cancelled: 0 };
  reportTasks.forEach(t => {
    const st = effStatus(t);
    if (st === "completed") {
      rs.completed++;
      const dd = deliveryDiff(t);
      if (dd !== null) { if (dd >= 0) rs.onTime++; else rs.lateDone++; }
    } else if (st === "pending") {
      rs.inProgress++;
      if (t.due_date && dayDiff(t.due_date) < 0) rs.overdue++;
    } else if (st === "deferred") rs.deferred++;
    else if (st === "cancelled") rs.cancelled++;
  });

  const reportScope = reportMember === "all" ? "كامل الفريق" : (getMember(reportMember)?.full_name || "عضو");
  const reportPeriodLabel = reportPeriod === "all" || (!reportFrom && !reportTo)
    ? "كامل الفترة"
    : `${reportFrom ? "من " + fmtDate(reportFrom) : ""}${reportFrom && reportTo ? " " : ""}${reportTo ? "إلى " + fmtDate(reportTo) : ""}`;

  const renderReport = () => (
    <div className="report">
      <div className="report-head">
        <img src="/logo.png" alt="" className="report-logo" />
        <div>
          <h2>تقرير مهام قسم الإعلام والتوثيق</h2>
          <p><b>{reportScope}</b> · {reportPeriodLabel}</p>
          <p>تاريخ الطباعة: {fmtDate(new Date().toISOString())}</p>
        </div>
      </div>
      <div className="report-summary">
        <span>الإجمالي: {rs.total}</span>
        <span>قيد التنفيذ: {rs.inProgress} (منها متأخرة: {rs.overdue})</span>
        <span>مكتملة: {rs.completed} (في الموعد: {rs.onTime} · متأخرة: {rs.lateDone})</span>
        <span>مؤجلة: {rs.deferred}</span>
        <span>ملغاة: {rs.cancelled}</span>
      </div>
      {reportTasks.length === 0 ? (
        <div className="empty compact">لا توجد مهام ضمن هذا الاختيار.</div>
      ) : (
        <div className="report-table-wrap">
          <table className="report-table">
            <thead>
              <tr>
                <th>#</th><th>المهمة</th><th>المكلف</th><th>المشروع</th><th>تاريخ الاستلام</th>
                <th>موعد التسليم</th><th>تاريخ التسليم</th><th>الحالة</th><th>التقدم / التأخر</th>
              </tr>
            </thead>
            <tbody>
              {reportTasks.map((t, i) => {
                const note = reportNote(t);
                return (
                  <tr key={t.id}>
                    <td>{i + 1}</td>
                    <td>{t.title}</td>
                    <td>{getMember(t.assignee_id)?.full_name || "—"}</td>
                    <td>{projectObj(t.project_id)?.name || "—"}</td>
                    <td>{fmtDate(t.created_at)}</td>
                    <td>{t.due_date ? fmtDate(t.due_date) : "—"}</td>
                    <td>{t.status === "completed" && t.completed_at ? fmtDate(t.completed_at) : "—"}</td>
                    <td>{STATUS_LABEL[effStatus(t)] || t.status}</td>
                    <td className={note.kind}>{note.text}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );

  if (loading && !session) return <main className="center-screen">جارٍ التحميل...</main>;

  if (!session) return (
    <main className="login-shell">
      <section className="login-card">
        <div className="brand-mark-img"><img src="/logo.png" alt="شعار" /></div>
        <h1>مهام قسم الإعلام والتوثيق</h1>
        <p className="muted">تسجيل الدخول للمنصة المشتركة</p>
        <form onSubmit={handleLogin} className="stack">
          {isSignUp && (
            <>
              <label>الاسم الكامل (يظهر للفريق)
                <input type="text" required value={fullName} onChange={e => setFullName(e.target.value)} placeholder="مثال: أحمد سعيد" />
              </label>
              <label>رابط الصورة الشخصية (اختياري)
                <input type="url" value={avatarUrl} onChange={e => setAvatarUrl(e.target.value)} placeholder="https://..." dir="ltr" />
              </label>
            </>
          )}
          <label>البريد الإلكتروني
            <input type="email" required value={email} onChange={e => setEmail(e.target.value)} placeholder="name@example.com" dir="ltr" autoComplete="email" />
          </label>
          <label>{isSignUp ? "كلمة المرور (6 أحرف على الأقل)" : "كلمة المرور"}
            <input type="password" required value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••" dir="ltr" autoComplete={isSignUp ? "new-password" : "current-password"} />
          </label>
          {authError && <div className="error">{authError}</div>}
          {authSuccess && <div className="success-msg">{authSuccess}</div>}
          <button className="primary full" disabled={busy}>
            {busy ? "جارٍ المعالجة..." : (isSignUp ? "إرسال طلب الانضمام" : "تسجيل الدخول")}
          </button>
        </form>
        <button type="button" className="switch-auth-btn" onClick={() => { setIsSignUp(!isSignUp); setAuthError(""); setAuthSuccess(""); }}>
          {isSignUp ? "لديك حساب؟ سجّل الدخول" : "عضو جديد؟ قدّم طلب انضمام"}
        </button>
      </section>
    </main>
  );

  if (!profileLoaded) return <main className="center-screen">جارٍ التحميل...</main>;

  if (!approved) return (
    <main className="login-shell">
      <section className="login-card">
        <div className="brand-mark-img"><img src="/logo.png" alt="شعار" /></div>
        <h1>{myProfile?.status === "rejected" ? "الحساب غير مفعّل" : "طلبك قيد المراجعة"}</h1>
        <p className="muted">
          {myProfile?.status === "rejected"
            ? "تم إيقاف هذا الحساب أو رفض طلب الانضمام. تواصل مع مسؤول الفريق."
            : "تم استلام طلب انضمامك، وسيظهر لك التطبيق فور موافقة المسؤول. تُفحص الحالة تلقائياً."}
        </p>
        <div className="stack">
          <button className="primary full" onClick={() => session?.user?.id && loadUserProfile(session.user.id)}>تحديث الحالة</button>
          <button className="secondary full" onClick={signOut}>تسجيل الخروج</button>
        </div>
      </section>
    </main>
  );

  return (
    <>
    <main className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand-box">
          <img src="/logo.png" alt="شعار المؤسسة" className="sidebar-main-logo" />
          <img src="/script.png" alt="قسم الإعلام والتوثيق" className="sidebar-title-script" />
        </div>

        <nav>
          <button
            className={viewMode === "my" ? "nav-item active" : "nav-item"}
            onClick={() => { setViewMode("my"); setSelectedMemberFilter("all"); }}
          >
            <User size={18} /> مهامي الشخصية
          </button>
          <button
            className={viewMode === "team" ? "nav-item active" : "nav-item"}
            onClick={() => setViewMode("team")}
          >
            <Globe size={18} /> مهام الجميع
          </button>

          <div className="nav-caption">مساحة العمل</div>
          <button className="nav-item" onClick={() => setShowProjectForm(true)}><FolderKanban size={18} /> + مشروع جديد <span className="nav-count">{activeProjects.length}</span></button>
          <button className="nav-item" onClick={() => setShowProfileModal(true)}><Settings size={18} /> إعدادات البروفايل</button>
          <button className="nav-item" onClick={() => setShowTeam(true)}><Users size={18} /> أعضاء الفريق <span className="nav-count">{members.length}</span></button>
          <button className="nav-item" onClick={() => setShowReport(true)}><FileText size={18} /> تقارير وطباعة</button>
          <button className="nav-item" onClick={() => setShowWishlist(true)}>
            <Lightbulb size={18} /> التفكير
            {thinkingCount > 0 && <span className="nav-count">{thinkingCount}</span>}
          </button>
          {isAdmin && (
            <button className="nav-item" onClick={() => setShowAdmin(true)}>
              <ShieldCheck size={18} /> إدارة الفريق
              {pendingProfiles.length > 0 && <span className="nav-count nav-alert">{pendingProfiles.length}</span>}
            </button>
          )}
        </nav>

        <div className="sidebar-bottom">
          <div className="user-mini" onClick={() => setShowProfileModal(true)} style={{ cursor: 'pointer' }} title="انقر لتعديل البروفايل">
            {currentUserProfile?.avatar_url ? (
              <img src={currentUserProfile.avatar_url} alt="Avatar" className="avatar-img" />
            ) : (
              <div className="avatar">{(currentUserProfile?.full_name || "م")[0]}</div>
            )}
            <div>
              <b>{currentUserProfile?.full_name || "عضو القسم"}</b>
              <small>تعديل البروفايل ⚙️</small>
            </div>
          </div>
          <button className="nav-item" onClick={signOut}><LogOut size={18} /> تسجيل الخروج</button>
        </div>
      </aside>

      <section className="main-panel">
        <header className="topbar">
          <div>
            <span className="eyebrow">منصة المتابعة الداخلية</span>
            <h2>{viewMode === "my" ? "مهامي الشخصية" : "مهام الجميع"}</h2>
          </div>
          <div className="top-actions">
            <button className="icon-btn" onClick={() => setShowProfileModal(true)} title="التنبيهات والإعدادات"><Bell size={18} /></button>
            <button className="icon-btn" onClick={() => loadData(true)} title="تحديث"><RefreshCw size={18} /></button>
            <button className="icon-btn mobile-only" onClick={signOut} title="تسجيل الخروج"><LogOut size={18} /></button>
          </div>
        </header>

        {myProfile?.password_changed === false && (
          <div className="notice-bar">
            <span>🔐 كلمة المرور الحالية افتراضية. غيّرها الآن لحماية حسابك.</span>
            <button className="secondary" onClick={() => setShowProfileModal(true)}>تغيير كلمة المرور</button>
          </div>
        )}

        {/* الإحصائيات العلوية */}
        <div className="stats-grid">
          <div className="stat-card"><span>قيد التنفيذ</span><strong>{pendingAndOverdueCount}</strong><Circle /></div>
          <div className="stat-card danger-stat"><span>المتأخرة</span><strong>{overdueCount}</strong><CalendarDays /></div>
          <div className="stat-card"><span>مكتملة</span><strong>{completedCount}</strong><CheckCircle2 /></div>
          <div className="stat-card"><span>الكل</span><strong>{baseTasks.length}</strong><ClipboardList /></div>
        </div>

        {/* مربع إضافة مهمة جديدة مدمج بأعراض أصغر */}
        <section className="content-card add-task-box">
          <div className="section-head tasks-head" style={{ marginBottom: showAddTask ? 10 : 0 }}>
            <button type="button" className="collapse-head" onClick={() => setShowAddTask(v => !v)} aria-expanded={showAddTask}>
              <div>
                <h3>➕ إضافة مهمة جديدة</h3>
                <p className="muted">{showAddTask ? "أدخل تفاصيل المهمة لتضاف مباشرة للقائمة." : "المساحة مطوية، انقر للإظهار."}</p>
              </div>
            </button>
            <button type="button" className="chevron-btn collapse-chevron" onClick={() => setShowAddTask(v => !v)} aria-label="إظهار أو إخفاء إضافة المهمة" title={showAddTask ? "طي" : "توسيع"}>
              <ChevronDown size={20} className={showAddTask ? "chev open" : "chev"} />
            </button>
          </div>
          {showAddTask && (
          <form onSubmit={addTask} className="task-form-grid-compact">
            <div className="form-group">
              <label>عنوان المهمة</label>
              <input
                type="text"
                required
                value={form.title}
                onChange={e => setForm({ ...form, title: e.target.value })}
                placeholder="مثلاً: إعداد التقرير"
              />
            </div>
            <div className="form-group">
              <label>المكلف بالمهمة</label>
              <select value={form.assignee_id} onChange={e => setForm({ ...form, assignee_id: e.target.value })}>
                <option value="">أنا ({currentUserProfile?.full_name || "حسابي"})</option>
                {members.map(m => <option key={m.id} value={m.id}>{m.full_name || "عضو"}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label>تاريخ التسليم</label>
              <input type="date" value={form.due_date} onChange={e => setForm({ ...form, due_date: e.target.value })} />
            </div>
            <div className="form-group">
              <label>التنبيه قبل</label>
              <select value={form.remind_days} onChange={e => setForm({ ...form, remind_days: Number(e.target.value) })}>
                {[0, 1, 2, 3, 5, 7, 10, 14, 30].map(n => <option key={n} value={n}>{n} يوم</option>)}
              </select>
            </div>
            <div className="form-group">
              <label>المشروع</label>
              <select value={form.project_id} onChange={e => setForm({ ...form, project_id: e.target.value })}>
                <option value="">بدون مشروع</option>
                {activeProjects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label>تفاصيل إضافية</label>
              <input
                type="text"
                value={form.description}
                onChange={e => setForm({ ...form, description: e.target.value })}
                placeholder="وصف إضافي..."
              />
            </div>
            <div className="form-submit-row">
              <button type="submit" className="primary full" disabled={busy}>
                {busy ? "جارٍ الحفظ..." : "حفظ المهمة"}
              </button>
            </div>
          </form>
          )}
        </section>

        {/* عرض قائمة المهام */}
        <section className="content-card" id="tasks-section">
          <div className="section-head tasks-head">
            <button type="button" className="collapse-head" onClick={() => setShowTasks(v => !v)} aria-expanded={showTasks}>
              <div>
                <h3>قائمة مهام القسم</h3>
                <p className="muted">{showTasks ? "انقر على أي مهمة لعرض تفاصيلها." : "القائمة مخفية، انقر للإظهار."}</p>
              </div>
            </button>
            {showTasks && (
            <div className="list-tools">
              <select className="project-select" value={projectFilter} onChange={e => setProjectFilter(e.target.value)} aria-label="تصفية حسب المشروع">
                <option value="all">كل المشاريع</option>
                <option value="none">بدون مشروع</option>
                {projects.map(p => <option key={p.id} value={p.id}>{p.name}{p.status === "cancelled" ? " (ملغى)" : ""}</option>)}
              </select>
              <div className="searchbox">
                <Search size={17} />
                <input placeholder="ابحث عن مهمة..." value={search} onChange={e => setSearch(e.target.value)} />
              </div>
            </div>
            )}
            <button type="button" className="chevron-btn collapse-chevron" onClick={() => setShowTasks(v => !v)} aria-label="إظهار أو إخفاء المهام" title={showTasks ? "إخفاء المهام" : "إظهار المهام"}>
              <ChevronDown size={20} className={showTasks ? "chev open" : "chev"} />
            </button>
          </div>

          {showTasks && (
          <>
          {viewMode === "team" && (
            <div className="member-pills">
              <button
                className={selectedMemberFilter === "all" ? "pill active-pill" : "pill"}
                onClick={() => setSelectedMemberFilter("all")}
              >
                الجميع ({tasks.length})
              </button>
              {members.map(m => (
                <button
                  key={m.id}
                  className={selectedMemberFilter === m.id ? "pill active-pill" : "pill"}
                  onClick={() => setSelectedMemberFilter(m.id)}
                >
                  {m.avatar_url && <img src={m.avatar_url} alt="" className="pill-avatar" />}
                  {m.full_name || "عضو"}
                </button>
              ))}
            </div>
          )}

          <div className="filters">
            {[
              ["pending_and_overdue", `قيد التنفيذ (${tc.pending})`],
              ["overdue", `المتأخرة (${tc.overdue})`],
              ["deferred", `مؤجلة (${tc.deferred})`],
              ["completed", `مكتملة (${tc.completed})`],
              ["cancelled", `ملغاة (${tc.cancelled})`],
              ["all", `الكل (${tc.all})`]
            ].map(([v, l]) => (
              <button key={v} className={filter === v ? "filter active-filter" : "filter"} onClick={() => setFilter(v)}>
                {l}
              </button>
            ))}
          </div>

          {authError && <div className="error">{authError}</div>}
          {loading ? <div className="empty">جارٍ تحميل المهام...</div> : filtered.length === 0 ? <div className="empty">لا توجد مهام في هذا القسم حالياً.</div> : (
            <div className="task-list">
              {filtered.map(task => {
                const open = !!openTasks[task.id];
                const info = taskStatusInfo(task);
                const assignee = getMember(task.assignee_id);
                const creator = getMember(task.created_by);
                const proj = projectObj(task.project_id);
                const canProg = canProgress(task);
                const canEdit = canManage(task);
                const showBadge = info.kind === "late" || info.kind === "soon" || info.kind === "cancelled" || info.kind === "deferred";

                return (
                  <article className={"task-row" + (task.status === "completed" ? " is-complete" : "") + (open ? " is-open" : "")} key={task.id}>
                    <div className="task-summary">
                      <button
                        className="check-button"
                        disabled={!canProg}
                        onClick={() => setTaskStatus(task, task.status === "completed" ? "pending" : "completed")}
                        title={canProg ? "شطب / إتمام المهمة" : "الإنجاز لصاحب المهمة أو المسؤول فقط"}
                      >
                        {task.status === "completed" ? <CheckCircle2 /> : <Circle />}
                      </button>

                      <div
                        className="task-head"
                        role="button"
                        tabIndex={0}
                        aria-expanded={open}
                        onClick={() => toggleTask(task.id)}
                        onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleTask(task.id); } }}
                      >
                        <div className="task-title-line">
                          <strong>{task.title}</strong>
                          {showBadge && <span className={"deadline " + info.kind}>{info.label}</span>}
                        </div>
                        <div className="task-meta">
                          <span className="owner-badge">
                            {assignee?.avatar_url ? (
                              <img src={assignee.avatar_url} alt="" className="mini-avatar" />
                            ) : (
                              <User size={12} />
                            )}
                            {assignee?.full_name || "غير محدد"}
                          </span>
                          {proj && (
                            <span className="project-badge" style={{ borderRight: `3px solid ${proj.color}` }}>
                              {proj.name}
                            </span>
                          )}
                          {task.due_date && <span>📅 {task.due_date}</span>}
                        </div>
                      </div>

                      <button type="button" className="chevron-btn" onClick={() => toggleTask(task.id)} aria-label="التفاصيل">
                        <ChevronDown size={18} className={open ? "chev open" : "chev"} />
                      </button>
                    </div>

                    {open && (
                      <div className="task-details">
                        {task.description && <p className="task-desc">{task.description}</p>}
                        <dl className="detail-grid">
                          <div className="detail-item"><dt>المكلف بالمهمة</dt><dd>{assignee?.full_name || "غير محدد"}</dd></div>
                          <div className="detail-item"><dt>أضافها</dt><dd>{creator?.full_name || "—"}</dd></div>
                          <div className="detail-item hide-mobile"><dt>تاريخ الاستلام</dt><dd>{fmtDate(task.created_at)}</dd></div>
                          <div className="detail-item"><dt>موعد التسليم</dt><dd>{task.due_date ? fmtDate(task.due_date) : "غير محدد"}</dd></div>
                          <div className="detail-item"><dt>الحالة</dt><dd><span className={"deadline " + info.kind}>{info.label}</span></dd></div>
                          <div className="detail-item"><dt>المشروع</dt><dd>{proj?.name || "بدون مشروع"}</dd></div>
                          {task.status === "completed" && task.completed_at && (
                            <div className="detail-item"><dt>تاريخ الإنجاز</dt><dd>{fmtDate(task.completed_at)}</dd></div>
                          )}
                        </dl>
                        <div className="task-actions">
                          {canEdit && (
                            <button className="subtle-btn" onClick={() => setEditingTask(task)} title="تعديل المهمة">
                              <Edit3 size={16} /><span>تعديل</span>
                            </button>
                          )}
                          {canProg && task.status === "pending" && (
                            <button className="subtle-btn" onClick={() => setTaskStatus(task, "deferred")} title="تأجيل المهمة (تعود تلقائياً عند اقتراب موعدها)">
                              <Clock size={16} /><span>تأجيل</span>
                            </button>
                          )}
                          {canProg && task.status === "deferred" && (
                            <button className="subtle-btn" onClick={() => setTaskStatus(task, "pending")} title="استئناف المهمة الآن">
                              <RotateCcw size={16} /><span>استئناف</span>
                            </button>
                          )}
                          {canEdit && (task.status !== "cancelled" ? (
                            <button className="subtle-btn" onClick={() => setTaskStatus(task, "cancelled")} title="إلغاء المهمة (تبقى في قائمة الملغاة)">
                              <X size={16} /><span>إلغاء</span>
                            </button>
                          ) : (
                            <button className="subtle-btn" onClick={() => setTaskStatus(task, "pending")} title="إعادة فتح">
                              <RotateCcw size={16} /><span>إعادة</span>
                            </button>
                          ))}
                          {isAdmin && (
                            <button className="subtle-btn danger-btn" onClick={() => deleteTask(task)} title="حذف نهائي">
                              <Trash2 size={16} /><span>حذف</span>
                            </button>
                          )}
                          {!canEdit && !canProg && <span className="muted view-only">مهمة عضو آخر: للعرض فقط</span>}
                        </div>
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          )}
          </>
          )}
        </section>

        {/* المشاريع */}
        <section className="content-card projects-card">
          <div className="section-head projects-head">
            <button type="button" className="collapse-head" onClick={() => setShowProjects(v => !v)} aria-expanded={showProjects}>
              <div>
                <h3>المشاريع ({activeProjects.length})</h3>
                <p className="muted">انقر على أي مشروع لعرض مهامه وتفاصيلها.</p>
              </div>
            </button>
            <button className="secondary" onClick={() => setShowProjectForm(true)}><Plus size={16} /> مشروع جديد</button>
            <button type="button" className="chevron-btn collapse-chevron" onClick={() => setShowProjects(v => !v)} aria-label="إظهار أو إخفاء المشاريع" title={showProjects ? "إخفاء المشاريع" : "إظهار المشاريع"}>
              <ChevronDown size={20} className={showProjects ? "chev open" : "chev"} />
            </button>
          </div>
          {showProjects && (projects.length === 0 ? <div className="empty compact">لم تتم إضافة مشاريع بعد.</div> : (
            <div className="project-grid">
              {projects.map(p => {
                const pt = tasks.filter(t => t.project_id === p.id);
                const done = pt.filter(t => t.status === "completed").length;
                const pct = pt.length ? Math.round((done / pt.length) * 100) : 0;
                const cancelled = p.status === "cancelled";
                return (
                  <div
                    key={p.id}
                    className={"project-chip clickable-project" + (cancelled ? " is-cancelled" : "")}
                    onClick={() => setViewingProjectId(p.id)}
                    title="عرض مهام المشروع"
                  >
                    <span className="project-dot" style={{ background: p.color }} />
                    <strong>{p.name}</strong>
                    <div className="chip-actions">
                      {!cancelled && (
                        <button
                          type="button"
                          className="edit-project-btn"
                          onClick={(e) => { e.stopPropagation(); setProjectTaskForm({ ...emptyProjectTask }); setAddTaskProject(p); }}
                          title="إضافة مهمة لهذا المشروع"
                        >
                          <Plus size={16} />
                        </button>
                      )}
                      <button
                        type="button"
                        className="edit-project-btn"
                        onClick={(e) => { e.stopPropagation(); setEditingProject(p); }}
                        title="تعديل المشروع"
                      >
                        <Edit3 size={14} />
                      </button>
                    </div>
                    <small>{cancelled ? "ملغى · " : ""}{done}/{pt.length} مكتملة</small>
                    <div className="progress"><span style={{ width: pct + "%", background: p.color }} /></div>
                  </div>
                );
              })}
            </div>
          ))}
        </section>
      </section>

      {/* نافذة تفاصيل المشروع */}
      {viewProj && (
        <div className="modal-backdrop" onClick={() => setViewingProjectId(null)}>
          <div className="modal modal-wide" onClick={e => e.stopPropagation()}>
            <div className="modal-head">
              <div>
                <h3><span className="project-dot inline" style={{ background: viewProj.color }} />{viewProj.name}</h3>
                <p className="muted">{viewDone}/{viewTasks.length} مكتملة{viewProj.status === "cancelled" ? " · مشروع ملغى" : ""}{viewProj.created_at ? ` · أُنشئ في ${fmtDate(viewProj.created_at)}` : ""}</p>
              </div>
              <div className="modal-head-actions">
                {viewProj.status !== "cancelled" && (
                  <button type="button" className="primary" onClick={() => { setProjectTaskForm({ ...emptyProjectTask }); setAddTaskProject(viewProj); }}>
                    <Plus size={15} /> مهمة
                  </button>
                )}
                <button type="button" className="icon-btn" onClick={() => setViewingProjectId(null)}><X /></button>
              </div>
            </div>
            {viewTasks.length === 0 ? <div className="empty compact">لا توجد مهام في هذا المشروع بعد.</div> : (
              <div className="proj-task-list">
                {viewTasks.map(t => {
                  const info = taskStatusInfo(t);
                  const owner = getMember(t.assignee_id);
                  const canProg = canProgress(t);
                  const canEdit = canManage(t);
                  return (
                    <div className={"proj-task" + (t.status === "completed" ? " is-complete" : "")} key={t.id}>
                      <div className="proj-task-top">
                        <button
                          className="check-button"
                          disabled={!canProg}
                          onClick={() => setTaskStatus(t, t.status === "completed" ? "pending" : "completed")}
                          title={canProg ? "شطب / إتمام المهمة" : "الإنجاز لصاحب المهمة أو المسؤول فقط"}
                        >
                          {t.status === "completed" ? <CheckCircle2 /> : <Circle />}
                        </button>
                        <div className="proj-task-title">
                          <strong>{t.title}</strong>
                          <span className={"deadline " + info.kind}>{info.label}</span>
                        </div>
                        {canEdit && <button type="button" className="subtle-btn" onClick={() => setEditingTask(t)} title="تعديل المهمة"><Edit3 size={15} /></button>}
                      </div>
                      {t.description && <p className="task-desc">{t.description}</p>}
                      <dl className="detail-grid">
                        <div className="detail-item">
                          <dt>صاحب المهمة</dt>
                          <dd className="with-avatar">
                            {owner?.avatar_url ? <img src={owner.avatar_url} alt="" className="mini-avatar" /> : <User size={13} />}
                            {owner?.full_name || "غير محدد"}
                          </dd>
                        </div>
                        <div className="detail-item hide-mobile"><dt>تاريخ الاستلام</dt><dd>{fmtDate(t.created_at)}</dd></div>
                        <div className="detail-item"><dt>موعد التسليم</dt><dd>{t.due_date ? fmtDate(t.due_date) : "غير محدد"}</dd></div>
                        {t.status === "completed" && t.completed_at && (
                          <div className="detail-item"><dt>تاريخ الإنجاز</dt><dd>{fmtDate(t.completed_at)}</dd></div>
                        )}
                      </dl>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* نافذة أعضاء الفريق */}
      {showTeam && (
        <div className="modal-backdrop" onClick={() => setShowTeam(false)}>
          <div className="modal modal-wide" onClick={e => e.stopPropagation()}>
            <div className="modal-head">
              <div><h3>👥 أعضاء الفريق</h3><p className="muted">{members.length} عضو · انقر على أي عضو لعرض مهامه.</p></div>
              <button type="button" className="icon-btn" onClick={() => setShowTeam(false)}><X /></button>
            </div>
            {members.length === 0 ? <div className="empty compact">لا يوجد أعضاء بعد.</div> : (
              <div className="team-grid">
                {members.map(m => {
                  const mine = tasks.filter(t => t.assignee_id === m.id);
                  const open = mine.filter(t => effStatus(t) === "pending").length;
                  const done = mine.filter(t => t.status === "completed").length;
                  const isMe = m.id === session?.user?.id;
                  return (
                    <button
                      type="button"
                      key={m.id}
                      className="member-card"
                      onClick={() => {
                        setShowTeam(false);
                        setViewMode("team");
                        setSelectedMemberFilter(m.id);
                        setFilter("all");
                        setTimeout(() => document.getElementById("tasks-section")?.scrollIntoView({ behavior: "smooth" }), 80);
                      }}
                      title="عرض مهام هذا العضو"
                    >
                      {m.avatar_url ? <img src={m.avatar_url} alt="" className="avatar-img" /> : <div className="avatar">{(m.full_name || "؟")[0]}</div>}
                      <div className="member-info">
                        <b>{m.full_name || "عضو"}{isMe && <span className="me-tag">أنت</span>}</b>
                        <small dir="ltr">{m.email}</small>
                        <span className="member-stats">{open} قيد التنفيذ · {done} مكتملة</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* نافذة التفكير */}
      {showWishlist && (
        <div className="modal-backdrop" onClick={() => setShowWishlist(false)}>
          <div className="modal modal-xl" onClick={e => e.stopPropagation()}>
            <div className="modal-head">
              <div><h3>💡 التفكير</h3><p className="muted">احتياجات القسم التي نفكر في شرائها أو اقتنائها.</p></div>
              <button type="button" className="icon-btn" onClick={() => setShowWishlist(false)}><X /></button>
            </div>

            <div className="wish-add">
              <button type="button" className="collapse-head" onClick={() => setShowWishForm(v => !v)} aria-expanded={showWishForm}>
                <h4 className="admin-title">➕ إضافة عنصر جديد</h4>
                <ChevronDown size={20} className={showWishForm ? "chev open" : "chev"} />
              </button>
              {showWishForm && (
                <form className="wish-form" onSubmit={addWish}>
                  <label>العنصر المطلوب<input required value={wishForm.title} onChange={e => setWishForm({ ...wishForm, title: e.target.value })} placeholder="مثلاً: كاميرا احترافية" /></label>
                  <label>التفاصيل (اختياري)<textarea rows={2} value={wishForm.details} onChange={e => setWishForm({ ...wishForm, details: e.target.value })} placeholder="المواصفات، السعر التقريبي، رابط..." /></label>
                  <ImagePicker
                    existing={[]}
                    files={wishFiles}
                    onAdd={fs => setWishFiles(cur => pickFiles(cur, 0, fs))}
                    onRemoveExisting={() => {}}
                    onRemoveFile={i => {
                      const f = wishFiles[i];
                      if (f) URL.revokeObjectURL(f.preview);
                      setWishFiles(cur => cur.filter((_, idx) => idx !== i));
                    }}
                  />
                  <div className="modal-actions">
                    <button className="primary" disabled={busy}>{busy ? "جارٍ الحفظ..." : "إضافة إلى التفكير"}</button>
                  </div>
                </form>
              )}
            </div>

            <div className="filters" style={{ margin: 0 }}>
              {([
                ["thinking", `قيد التفكير (${thinkingCount})`],
                ["acquired", `المقتناة (${acquiredCount})`],
                ["all", `الكل (${wishlist.length})`]
              ] as const).map(([v, l]) => (
                <button key={v} type="button" className={wishFilter === v ? "filter active-filter" : "filter"} onClick={() => setWishFilter(v)}>{l}</button>
              ))}
            </div>

            {wishFiltered.length === 0 ? <div className="empty">لا توجد عناصر هنا بعد.</div> : (
              <div className="task-list">
                {wishFiltered.map(w => {
                  const open = !!openWish[w.id];
                  const creator = getMember(w.created_by);
                  const acquired = w.status === "acquired";
                  const editing = editingWishId === w.id;
                  const canDel = isAdmin || (!!session?.user?.id && w.created_by === session.user.id);
                  const imgs = w.image_urls || [];
                  return (
                    <article className={"task-row" + (acquired ? " is-complete" : "") + (open ? " is-open" : "")} key={w.id}>
                      <div className="task-summary">
                        <button
                          className="check-button"
                          onClick={() => toggleAcquired(w)}
                          title={acquired ? "إعادته إلى قيد التفكير" : "تم شراؤه / اقتناؤه"}
                        >
                          {acquired ? <CheckCircle2 /> : <Circle />}
                        </button>
                        <div
                          className="task-head"
                          role="button"
                          tabIndex={0}
                          aria-expanded={open}
                          onClick={() => toggleWish(w.id)}
                          onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleWish(w.id); } }}
                        >
                          <div className="task-title-line">
                            <strong>{w.title}</strong>
                            {acquired && <span className="deadline done">مقتناة</span>}
                          </div>
                          <div className="task-meta">
                            <span className="owner-badge">
                              {creator?.avatar_url ? <img src={creator.avatar_url} alt="" className="mini-avatar" /> : <User size={12} />}
                              {creator?.full_name || "غير معروف"}
                            </span>
                            <span>📅 {fmtDate(w.created_at)}</span>
                            {imgs.length > 0 && <span>🖼️ {imgs.length}</span>}
                          </div>
                        </div>
                        {imgs[0] && <WishImg key={imgs[0]} src={imgs[0]} width={120} className="wish-thumb" onClick={() => setViewer({ urls: imgs, index: 0 })} />}
                        <button type="button" className="chevron-btn" onClick={() => toggleWish(w.id)} aria-label="التفاصيل">
                          <ChevronDown size={18} className={open ? "chev open" : "chev"} />
                        </button>
                      </div>

                      {open && (
                        <div className="task-details">
                          {editing ? (
                            <form className="wish-form" onSubmit={e => saveWishEdit(e, w)}>
                              <label>العنصر<input required value={wishEdit.title} onChange={e => setWishEdit({ ...wishEdit, title: e.target.value })} /></label>
                              <label>التفاصيل<textarea rows={2} value={wishEdit.details} onChange={e => setWishEdit({ ...wishEdit, details: e.target.value })} /></label>
                              <div className="form-grid">
                                <label>تاريخ الإدراج<input type="date" value={wishEdit.created_date} onChange={e => setWishEdit({ ...wishEdit, created_date: e.target.value })} /></label>
                                {acquired && (
                                  <label>تاريخ الاقتناء<input type="date" value={wishEdit.acquired_date} onChange={e => setWishEdit({ ...wishEdit, acquired_date: e.target.value })} /></label>
                                )}
                              </div>
                              <ImagePicker
                                existing={wishEdit.images}
                                files={wishEditFiles}
                                onAdd={fs => setWishEditFiles(cur => pickFiles(cur, wishEdit.images.length, fs))}
                                onRemoveExisting={url => setWishEdit(prev => ({ ...prev, images: prev.images.filter(u => u !== url), removed: [...prev.removed, url] }))}
                                onRemoveFile={i => {
                                  const f = wishEditFiles[i];
                                  if (f) URL.revokeObjectURL(f.preview);
                                  setWishEditFiles(cur => cur.filter((_, idx) => idx !== i));
                                }}
                              />
                              <div className="modal-actions">
                                <button type="button" className="secondary" onClick={cancelEditWish}>إلغاء</button>
                                <button className="primary" disabled={busy}>{busy ? "جارٍ الحفظ..." : "حفظ التعديلات"}</button>
                              </div>
                            </form>
                          ) : (
                            <>
                              {w.details && <p className="task-desc">{w.details}</p>}
                              {imgs.length > 0 && (
                                <div className="img-thumbs big">
                                  {imgs.map((u, idx) => (
                                    <button type="button" key={u} className="img-thumb" onClick={() => setViewer({ urls: imgs, index: idx })} aria-label="عرض الصورة">
                                      <WishImg src={u} width={300} />
                                    </button>
                                  ))}
                                </div>
                              )}
                              <dl className="detail-grid">
                                <div className="detail-item"><dt>أدرجه</dt><dd>{creator?.full_name || "غير معروف"}</dd></div>
                                <div className="detail-item"><dt>تاريخ الإدراج (التفكير)</dt><dd>{fmtDate(w.created_at)}</dd></div>
                                {acquired && (
                                  <div className="detail-item"><dt>تاريخ الاقتناء</dt><dd>{w.acquired_at ? fmtDate(w.acquired_at) : "—"}</dd></div>
                                )}
                              </dl>
                              <div className="task-actions">
                                <button className="subtle-btn" onClick={() => startEditWish(w)} title="تعديل"><Edit3 size={16} /><span>تعديل</span></button>
                                {canDel && (
                                  <button className="subtle-btn danger-btn" onClick={() => askDeleteWish(w)} title="حذف"><Trash2 size={16} /><span>حذف</span></button>
                                )}
                              </div>
                            </>
                          )}
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* نافذة التقارير */}
      {showReport && (
        <div className="modal-backdrop" onClick={() => setShowReport(false)}>
          <div className="modal modal-xl" onClick={e => e.stopPropagation()}>
            <div className="modal-head">
              <div><h3>🖨️ تقارير المهام</h3><p className="muted">اختر العضو والفترة ثم اطبع التقرير أو احفظه PDF.</p></div>
              <div className="modal-head-actions">
                <button type="button" className="primary" onClick={() => window.print()}><Printer size={15} /> طباعة</button>
                <button type="button" className="icon-btn" onClick={() => setShowReport(false)}><X /></button>
              </div>
            </div>
            <div className="form-grid">
              <label>العضو
                <select value={reportMember} onChange={e => setReportMember(e.target.value)}>
                  <option value="all">كامل الفريق</option>
                  {members.map(m => <option key={m.id} value={m.id}>{m.full_name || "عضو"}</option>)}
                </select>
              </label>
              <label>الفترة
                <select value={reportPeriod} onChange={e => setReportPeriod(e.target.value as "all" | "range")}>
                  <option value="range">فترة محددة (من - إلى)</option>
                  <option value="all">كامل الفترة</option>
                </select>
              </label>
              {reportPeriod === "range" && (
                <>
                  <label>من تاريخ<input type="date" value={reportFrom} max={reportTo || undefined} onChange={e => setReportFrom(e.target.value)} /></label>
                  <label>إلى تاريخ<input type="date" value={reportTo} min={reportFrom || undefined} onChange={e => setReportTo(e.target.value)} /></label>
                </>
              )}
            </div>
            <p className="muted" style={{ margin: 0, fontSize: 12 }}>
              يشمل التقرير المهام التي استُلمت أو حلّ موعد تسليمها أو سُلّمت خلال الفترة المختارة.
            </p>
            <div className="report-preview">{renderReport()}</div>
          </div>
        </div>
      )}

      {/* نافذة إدارة الفريق */}
      {showAdmin && isAdmin && (
        <div className="modal-backdrop" onClick={() => setShowAdmin(false)}>
          <div className="modal modal-xl" onClick={e => e.stopPropagation()}>
            <div className="modal-head">
              <div><h3>🛡️ إدارة الفريق</h3><p className="muted">الموافقة على طلبات الانضمام وتحديد المسؤولين.</p></div>
              <button type="button" className="icon-btn" onClick={() => setShowAdmin(false)}><X /></button>
            </div>

            <div>
              <h4 className="admin-title">طلبات الانضمام ({pendingProfiles.length})</h4>
              {pendingProfiles.length === 0 ? <div className="empty compact">لا توجد طلبات معلّقة.</div> : (
                <div className="admin-list">
                  {pendingProfiles.map(p => (
                    <div className="admin-row" key={p.id}>
                      {p.avatar_url ? <img src={p.avatar_url} alt="" className="avatar-img" /> : <div className="avatar">{(p.full_name || "؟")[0]}</div>}
                      <div className="member-info"><b>{p.full_name || "بدون اسم"}</b><small dir="ltr">{p.email}</small></div>
                      <div className="admin-actions">
                        <button type="button" className="primary" onClick={() => setMemberStatus(p, "approved")}>قبول</button>
                        <button type="button" className="danger" onClick={() => setMemberStatus(p, "rejected")}>رفض</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div>
              <h4 className="admin-title">الأعضاء ({approvedProfiles.length})</h4>
              <div className="admin-list">
                {approvedProfiles.map(p => {
                  const isSelf = p.id === session?.user?.id;
                  const lastAdmin = p.role === "admin" && adminCount <= 1;
                  return (
                    <div className="admin-row" key={p.id}>
                      {p.avatar_url ? <img src={p.avatar_url} alt="" className="avatar-img" /> : <div className="avatar">{(p.full_name || "؟")[0]}</div>}
                      <div className="member-info">
                        <b>{p.full_name || "عضو"}{p.role === "admin" && <span className="role-tag">مسؤول</span>}{isSelf && <span className="me-tag">أنت</span>}</b>
                        <small dir="ltr">{p.email}</small>
                      </div>
                      <div className="admin-actions">
                        {p.role === "admin" ? (
                          <button type="button" className="secondary" disabled={lastAdmin} title={lastAdmin ? "لا يمكن إزالة آخر مسؤول" : ""} onClick={() => setMemberRole(p, "member")}>إزالة المسؤولية</button>
                        ) : (
                          <button type="button" className="secondary" onClick={() => setMemberRole(p, "admin")}>جعله مسؤولاً</button>
                        )}
                        {!isSelf && <button type="button" className="secondary" onClick={() => askResetPassword(p)}>كلمة مرور 0000</button>}
                        {!isSelf && <button type="button" className="danger" onClick={() => askSuspend(p)}>إيقاف</button>}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {rejectedProfiles.length > 0 && (
              <div>
                <h4 className="admin-title">الحسابات الموقوفة / المرفوضة ({rejectedProfiles.length})</h4>
                <div className="admin-list">
                  {rejectedProfiles.map(p => (
                    <div className="admin-row" key={p.id}>
                      <div className="avatar">{(p.full_name || "؟")[0]}</div>
                      <div className="member-info"><b>{p.full_name || "بدون اسم"}</b><small dir="ltr">{p.email}</small></div>
                      <div className="admin-actions">
                        <button type="button" className="primary" onClick={() => setMemberStatus(p, "approved")}>إعادة قبول</button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* نافذة إعدادات البروفايل */}
      {showProfileModal && (
        <div className="modal-backdrop" onClick={() => setShowProfileModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-head">
              <div><h3>⚙️ إعدادات البروفايل</h3><p className="muted">الاسم والصورة وكلمة المرور والتنبيهات.</p></div>
              <button type="button" className="icon-btn" onClick={() => setShowProfileModal(false)}><X /></button>
            </div>

            <form className="profile-form" onSubmit={updateProfile}>
              <label>الاسم الكامل<input required value={profileForm.full_name} onChange={e => setProfileForm({ ...profileForm, full_name: e.target.value })} /></label>
              <label>رابط الصورة الشخصية (Avatar URL)<input type="url" value={profileForm.avatar_url} onChange={e => setProfileForm({ ...profileForm, avatar_url: e.target.value })} placeholder="https://..." dir="ltr" /></label>
              <div className="modal-actions">
                <button className="primary" disabled={busy}>{busy ? "جاري الحفظ..." : "حفظ الاسم والصورة"}</button>
              </div>
            </form>

            <div className="profile-section">
              <h4>🔑 تغيير كلمة المرور</h4>
              <label>كلمة المرور الجديدة (6 أحرف على الأقل)
                <input type="password" autoComplete="new-password" dir="ltr" value={passwordForm.pw1} onChange={e => setPasswordForm({ ...passwordForm, pw1: e.target.value })} />
              </label>
              <label>تأكيد كلمة المرور
                <input type="password" autoComplete="new-password" dir="ltr" value={passwordForm.pw2} onChange={e => setPasswordForm({ ...passwordForm, pw2: e.target.value })} />
              </label>
              <div className="modal-actions">
                <button type="button" className="secondary" disabled={busy} onClick={changePassword}>تغيير كلمة المرور</button>
              </div>
            </div>

            <div className="profile-section">
              <h4>🔔 التنبيهات على هذا الجهاز</h4>
              <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                تصلك تنبيهات عند تكليفك بمهمة جديدة، وصباح يوم موعد تسليم أي مهمة لم تُسلَّم بعد.
              </p>
              {pushOn ? (
                <div className="modal-actions" style={{ justifyContent: "space-between", alignItems: "center" }}>
                  <span className="deadline done">✅ التنبيهات مفعّلة</span>
                  <button type="button" className="secondary" onClick={disableNotifications}>إيقاف التنبيهات</button>
                </div>
              ) : (
                <div className="modal-actions">
                  <button type="button" className="primary" onClick={enableNotifications}><Bell size={15} /> تفعيل التنبيهات</button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* نافذة تعديل المهمة */}
      {editingTask && (
        <div className="modal-backdrop" onClick={() => setEditingTask(null)}>
          <form className="modal" onClick={e => e.stopPropagation()} onSubmit={updateTask}>
            <div className="modal-head"><div><h3>تعديل المهمة</h3><p className="muted">تعديل بيانات المهمة.</p></div><button type="button" className="icon-btn" onClick={() => setEditingTask(null)}><X /></button></div>
            <label>عنوان المهمة<input required value={editingTask.title} onChange={e => setEditingTask({ ...editingTask, title: e.target.value })} /></label>
            <label>التفاصيل<textarea value={editingTask.description || ""} onChange={e => setEditingTask({ ...editingTask, description: e.target.value })} rows={3} /></label>
            <div className="form-grid">
              <label>المشروع<select value={editingTask.project_id || ""} onChange={e => setEditingTask({ ...editingTask, project_id: e.target.value })}><option value="">بدون مشروع</option>{activeProjects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
              <label>المكلف بالمهمة<select required value={editingTask.assignee_id || ""} onChange={e => setEditingTask({ ...editingTask, assignee_id: e.target.value })}><option value="" disabled>اختر المكلف</option>{members.map(m => <option key={m.id} value={m.id}>{m.full_name || "عضو"}</option>)}</select></label>
              <label>تاريخ التسليم<input type="date" value={editingTask.due_date || ""} onChange={e => setEditingTask({ ...editingTask, due_date: e.target.value })} /></label>
              <label>تاريخ الاستلام<input type="date" value={toDateInput(editingTask.created_at)} onChange={e => { if (e.target.value) setEditingTask({ ...editingTask, created_at: fromDateInput(e.target.value) }); }} /></label>
              <label>التنبيه قبل الموعد<select value={editingTask.remind_days} onChange={e => setEditingTask({ ...editingTask, remind_days: Number(e.target.value) })}>{[0, 1, 2, 3, 5, 7, 10, 14, 30].map(n => <option key={n} value={n}>{n} يوم</option>)}</select></label>
            </div>
            <div className="modal-actions"><button type="button" className="secondary" onClick={() => setEditingTask(null)}>إلغاء</button><button className="primary" disabled={busy}>حفظ التعديلات</button></div>
          </form>
        </div>
      )}

      {/* نافذة تعديل المشروع */}
      {editingProject && (
        <div className="modal-backdrop" onClick={() => setEditingProject(null)}>
          <form className="modal" onClick={e => e.stopPropagation()} onSubmit={updateProject}>
            <div className="modal-head"><div><h3>تعديل المشروع</h3><p className="muted">تغيير اسم أو لون المشروع.</p></div><button type="button" className="icon-btn" onClick={() => setEditingProject(null)}><X /></button></div>
            <label>اسم المشروع<input required value={editingProject.name} onChange={e => setEditingProject({ ...editingProject, name: e.target.value })} /></label>
            <label>لون المشروع<input type="color" value={editingProject.color} onChange={e => setEditingProject({ ...editingProject, color: e.target.value })} style={{ height: 45, padding: 4 }} /></label>
            <label>تاريخ إنشاء المشروع<input type="date" value={editingProject.created_at ? toDateInput(editingProject.created_at) : ""} onChange={e => { if (e.target.value) setEditingProject({ ...editingProject, created_at: fromDateInput(e.target.value) }); }} /></label>
            <div className="modal-danger-zone">
              {editingProject.status === "cancelled" ? (
                <button type="button" className="secondary" onClick={() => setProjectStatus(editingProject, "active")}><RotateCcw size={15} /> إعادة تفعيل المشروع</button>
              ) : (
                <button type="button" className="secondary" onClick={() => setProjectStatus(editingProject, "cancelled")}><X size={15} /> إلغاء المشروع</button>
              )}
              {isAdmin && <button type="button" className="danger" disabled={busy} onClick={() => deleteProject(editingProject)}><Trash2 size={15} /> حذف نهائي</button>}
            </div>
            <div className="modal-actions"><button type="button" className="secondary" onClick={() => setEditingProject(null)}>إلغاء</button><button className="primary" disabled={busy}>حفظ التعديلات</button></div>
          </form>
        </div>
      )}

      {/* نافذة إضافة مشروع */}
      {showProjectForm && (
        <div className="modal-backdrop" onClick={() => setShowProjectForm(false)}>
          <form className="modal" onClick={e => e.stopPropagation()} onSubmit={addProject}>
            <div className="modal-head"><div><h3>إضافة مشروع جديد</h3><p className="muted">تجميع المهام تحت مشروع.</p></div><button type="button" className="icon-btn" onClick={() => setShowProjectForm(false)}><X /></button></div>
            <label>اسم المشروع<input required autoFocus value={newProject.name} onChange={e => setNewProject({ ...newProject, name: e.target.value })} placeholder="مثال: الحملة الإعلامية" /></label>
            <label>لون المشروع<input type="color" value={newProject.color} onChange={e => setNewProject({ ...newProject, color: e.target.value })} style={{ height: 45, padding: 4 }} /></label>
            <label>تاريخ الإنشاء (اختياري، الافتراضي اليوم)<input type="date" value={newProject.created_date} onChange={e => setNewProject({ ...newProject, created_date: e.target.value })} /></label>
            <div className="modal-actions"><button type="button" className="secondary" onClick={() => setShowProjectForm(false)}>إلغاء</button><button className="primary" disabled={busy}>إضافة المشروع</button></div>
          </form>
        </div>
      )}
      {/* نافذة إضافة مهمة داخل مشروع */}
      {addTaskProject && (
        <div className="modal-backdrop" onClick={() => setAddTaskProject(null)}>
          <form className="modal" onClick={e => e.stopPropagation()} onSubmit={addTaskToProject}>
            <div className="modal-head">
              <div><h3>مهمة جديدة في «{addTaskProject.name}»</h3><p className="muted">ستُضاف المهمة مباشرة إلى هذا المشروع.</p></div>
              <button type="button" className="icon-btn" onClick={() => setAddTaskProject(null)}><X /></button>
            </div>
            <label>عنوان المهمة<input required autoFocus value={projectTaskForm.title} onChange={e => setProjectTaskForm({ ...projectTaskForm, title: e.target.value })} placeholder="مثلاً: إعداد التقرير" /></label>
            <label>التفاصيل<textarea rows={3} value={projectTaskForm.description} onChange={e => setProjectTaskForm({ ...projectTaskForm, description: e.target.value })} /></label>
            <div className="form-grid">
              <label>المكلف بالمهمة
                <select value={projectTaskForm.assignee_id} onChange={e => setProjectTaskForm({ ...projectTaskForm, assignee_id: e.target.value })}>
                  <option value="">أنا ({currentUserProfile?.full_name || "حسابي"})</option>
                  {members.map(m => <option key={m.id} value={m.id}>{m.full_name || "عضو"}</option>)}
                </select>
              </label>
              <label>تاريخ التسليم<input type="date" value={projectTaskForm.due_date} onChange={e => setProjectTaskForm({ ...projectTaskForm, due_date: e.target.value })} /></label>
              <label>التنبيه قبل الموعد
                <select value={projectTaskForm.remind_days} onChange={e => setProjectTaskForm({ ...projectTaskForm, remind_days: Number(e.target.value) })}>
                  {[0, 1, 2, 3, 5, 7, 10, 14, 30].map(n => <option key={n} value={n}>{n} يوم</option>)}
                </select>
              </label>
            </div>
            <div className="modal-actions">
              <button type="button" className="secondary" onClick={() => setAddTaskProject(null)}>إلغاء</button>
              <button className="primary" disabled={busy}>{busy ? "جارٍ الحفظ..." : "حفظ المهمة"}</button>
            </div>
          </form>
        </div>
      )}

      {/* عارض الصور */}
      {viewer && <ImageViewer urls={viewer.urls} index={viewer.index} onClose={() => setViewer(null)} />}

      {/* نافذة تأكيد الحذف */}
      {confirmDialog && (
        <div className="modal-backdrop" style={{ zIndex: 70 }} onClick={() => setConfirmDialog(null)}>
          <div className="modal" style={{ maxWidth: 420 }} onClick={e => e.stopPropagation()}>
            <div className="modal-head"><div><h3>{confirmDialog.title || "تأكيد الحذف"}</h3></div></div>
            <p style={{ margin: 0, lineHeight: 1.9, fontSize: 14 }}>{confirmDialog.message}</p>
            <div className="modal-actions">
              <button type="button" className="secondary" onClick={() => setConfirmDialog(null)}>تراجع</button>
              <button
                type="button"
                className="danger"
                autoFocus
                onClick={() => { const fn = confirmDialog.onConfirm; setConfirmDialog(null); fn(); }}
              >
                {!confirmDialog.confirmLabel && <Trash2 size={15} />} {confirmDialog.confirmLabel || "نعم، احذف"}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
    <div className="print-only">{showReport && renderReport()}</div>
    </>
  );
}