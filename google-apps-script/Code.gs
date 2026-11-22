/**
 * الخادم الخلفي لتطبيق "مهام قسم الإعلام والتوثيق"
 * يحل محل Supabase و Vercel: قاعدة البيانات (Google Sheets)، تسجيل الدخول، الصلاحيات،
 * صور قائمة التفكير (Google Drive)، والتنبيهات (Firebase Cloud Messaging).
 *
 * الدوال التي تُشغَّل يدوياً من المحرر:
 *   setup()                 ← مرة واحدة: ينشئ الأوراق ومجلد الصور ومؤقت الساعة 9
 *   migrateFromSupabase()   ← مرة واحدة: ينقل البيانات من Supabase
 *   testPushToAdmins()      ← لتجربة التنبيهات
 */

const TZ = 'Africa/Algiers';
const SESSION_DAYS = 180;
const WISH_BUCKET = 'wishlist-images';
const DEFAULT_PASSWORD = '0000';

const SCHEMA = {
  profiles: {
    cols: ['id', 'full_name', 'email', 'avatar_url', 'role', 'status', 'password_changed', 'created_at', 'password_hash', 'salt'],
    hidden: ['password_hash', 'salt'],
    types: { password_changed: 'b' },
  },
  projects: { cols: ['id', 'name', 'color', 'status', 'created_by', 'created_at'] },
  tasks: {
    cols: ['id', 'title', 'description', 'project_id', 'assignee_id', 'created_by', 'due_date', 'remind_days',
      'priority', 'status', 'created_at', 'completed_at', 'completed_by', 'cancelled_at'],
    types: { remind_days: 'n' },
  },
  wishlist_items: {
    cols: ['id', 'title', 'details', 'status', 'created_by', 'created_at', 'acquired_at', 'image_urls'],
    types: { image_urls: 'j' },
  },
  push_tokens: { cols: ['id', 'user_id', 'token', 'created_at'] },
};

const TASK_STATUSES = ['pending', 'completed', 'cancelled', 'deferred'];

/* ============================== نقطة الدخول ============================== */

function doGet() {
  return ContentService.createTextOutput('OK — خادم مهام قسم الإعلام والتوثيق يعمل.');
}

function doPost(e) {
  let out;
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    out = handle_(req);
  } catch (err) {
    out = { results: [], error: { message: String((err && err.message) || err) } };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function handle_(req) {
  const ops = Array.isArray(req.ops) ? req.ops : [];
  const ctx = newCtx_(sessionUid_(req.token), req.token);
  const needsLock = ops.some(o => o && o.type !== 'select' && o.type !== 'version');
  const lock = needsLock ? LockService.getScriptLock() : null;
  if (lock) lock.waitLock(30000);
  let results;
  try {
    results = ops.map(op => {
      try {
        return { data: run_(ctx, op || {}) };
      } catch (err) {
        return { error: { message: (err && err.message) || String(err), code: (err && err.code) || 'ERR' } };
      }
    });
    if (ctx.changed) bumpVersion_();
  } finally {
    if (lock) lock.releaseLock();
  }
  // التنبيهات تُرسل بعد تحرير القفل حتى لا تُبطئ بقية المستخدمين
  ctx.notify.forEach(n => {
    try { sendPushToUser(n.userId, n.payload); } catch (err) { console.error('push failed: ' + err); }
  });
  return { results: results, version: getVersion_() };
}

function run_(ctx, op) {
  switch (op.type) {
    case 'version': return getVersion_();
    case 'select': return select_(ctx, op);
    case 'insert': return insert_(ctx, op);
    case 'update': return update_(ctx, op);
    case 'delete': return delete_(ctx, op);
    case 'rpc': return rpc_(ctx, op.name, op.args || {});
    case 'auth': return auth_(ctx, op.action, op.args || {});
    case 'upload': return upload_(ctx, op);
    case 'remove': return remove_(ctx, op);
  }
  throw err_('عملية غير معروفة: ' + op.type);
}

/* ============================== أدوات عامة ============================== */

function newCtx_(uid, token) {
  return { uid: uid || null, token: token || null, tables: {}, notify: [], changed: false, me: undefined };
}

function err_(message, code) {
  const e = new Error(message);
  e.code = code || 'ERR';
  return e;
}

function props_() { return PropertiesService.getScriptProperties(); }

function ss_() {
  const id = props_().getProperty('SPREADSHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}

function sheet_(name) {
  const sh = ss_().getSheetByName(name);
  if (!sh) throw err_('الورقة "' + name + '" غير موجودة. شغّل الدالة setup أولاً.');
  return sh;
}

function getVersion_() { return props_().getProperty('DATA_VERSION') || '0'; }
function bumpVersion_() { props_().setProperty('DATA_VERSION', String(Date.now())); }

function str_(x) { return (x === undefined || x === null || String(x).trim() === '') ? null : String(x); }
function num_(x, def) { const n = Number(x); return isFinite(n) && String(x) !== '' && x !== null ? n : def; }
function now_() { return new Date().toISOString(); }

function normDate_(v) {
  const s = str_(v);
  if (!s) return null;
  const d = s.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw err_('تاريخ غير صالح: ' + s);
  return d;
}

function checkTable_(t) { if (!SCHEMA[t]) throw err_('جدول غير معروف: ' + t); }

/* ============================== قراءة/كتابة الأوراق ============================== */

function toCell_(table, col, v) {
  const t = (SCHEMA[table].types || {})[col];
  if (v === null || v === undefined) return '';
  if (t === 'j') return JSON.stringify(v);
  if (t === 'b') return v ? 'TRUE' : 'FALSE';
  return String(v);
}

function fromCell_(table, col, v) {
  const t = (SCHEMA[table].types || {})[col];
  let s;
  if (v === null || v === undefined) s = '';
  else if (v instanceof Date) s = (col === 'due_date') ? Utilities.formatDate(v, TZ, 'yyyy-MM-dd') : v.toISOString();
  else s = String(v);
  if (t === 'n') return s === '' ? 0 : Number(s);
  if (t === 'b') return s.toUpperCase() === 'TRUE';
  if (t === 'j') { if (!s) return []; try { const a = JSON.parse(s); return Array.isArray(a) ? a : []; } catch (e) { return []; } }
  return s === '' ? null : s;
}

function readTable_(ctx, table) {
  if (ctx.tables[table]) return ctx.tables[table];
  const sh = sheet_(table);
  const cols = SCHEMA[table].cols;
  const last = sh.getLastRow();
  const values = last > 1 ? sh.getRange(2, 1, last - 1, cols.length).getValues() : [];
  const rows = [];
  values.forEach((r, i) => {
    if (!r[0]) return;
    const o = { _row: i + 2 };
    cols.forEach((c, j) => { o[c] = fromCell_(table, c, r[j]); });
    rows.push(o);
  });
  ctx.tables[table] = rows;
  return rows;
}

function rowValues_(table, obj) {
  return SCHEMA[table].cols.map(c => toCell_(table, c, obj[c]));
}

function writeRow_(table, rowNum, obj) {
  const cols = SCHEMA[table].cols;
  sheet_(table).getRange(rowNum, 1, 1, cols.length).setNumberFormat('@').setValues([rowValues_(table, obj)]);
}

function appendRow_(ctx, table, obj) {
  const sh = sheet_(table);
  const rows = readTable_(ctx, table);
  const rowNum = Math.max(sh.getLastRow(), 1) + 1;
  writeRow_(table, rowNum, obj);
  obj._row = rowNum;
  rows.push(obj);
  return obj;
}

function deleteRows_(ctx, table, rowNums) {
  const sh = sheet_(table);
  rowNums.slice().sort((a, b) => b - a).forEach(n => sh.deleteRow(n));
  delete ctx.tables[table];
}

function writeAll_(table, objs) {
  const sh = sheet_(table);
  const cols = SCHEMA[table].cols;
  const last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, cols.length).clearContent();
  if (!objs.length) return;
  sh.getRange(2, 1, objs.length, cols.length).setNumberFormat('@').setValues(objs.map(o => rowValues_(table, o)));
}

function public_(table, row) {
  const hidden = SCHEMA[table].hidden || [];
  const o = {};
  SCHEMA[table].cols.forEach(c => { if (hidden.indexOf(c) < 0) o[c] = row[c] === undefined ? null : row[c]; });
  return o;
}

function applyFilters_(rows, filters) {
  (filters || []).forEach(f => {
    const col = f[0], val = f[1];
    rows = rows.filter(r => (val === null || val === undefined) ? r[col] === null : String(r[col]) === String(val));
  });
  return rows;
}

function single_(arr) {
  if (arr.length !== 1) throw err_(arr.length ? 'أكثر من نتيجة.' : 'غير موجود.', 'PGRST116');
  return arr[0];
}

/* ============================== المستخدم الحالي والصلاحيات ============================== */

function me_(ctx) {
  if (!ctx.uid) throw err_('انتهت الجلسة، سجّل الدخول من جديد.', 'AUTH');
  if (ctx.me === undefined) {
    ctx.me = readTable_(ctx, 'profiles').filter(p => p.id === ctx.uid)[0] || null;
  }
  if (!ctx.me) throw err_('الحساب غير موجود.', 'AUTH');
  return ctx.me;
}

function approved_(ctx) {
  const me = me_(ctx);
  if (me.status !== 'approved') throw err_('الحساب غير مفعّل بعد.', 'FORBIDDEN');
  return me;
}

function isAdmin_(ctx) {
  const me = me_(ctx);
  return me.status === 'approved' && me.role === 'admin';
}

function requireMember_(ctx, id) {
  const ok = readTable_(ctx, 'profiles').some(p => p.id === id && p.status === 'approved');
  if (!ok) throw err_('العضو المكلّف غير موجود أو غير مفعّل.');
}

/* ============================== SELECT ============================== */

function select_(ctx, op) {
  const table = op.table;
  checkTable_(table);
  if (table === 'push_tokens') throw err_('غير مسموح.', 'FORBIDDEN');
  let rows;
  if (table === 'profiles') {
    const me = me_(ctx);
    rows = readTable_(ctx, 'profiles');
    if (me.status !== 'approved') rows = rows.filter(r => r.id === me.id);
  } else {
    approved_(ctx);
    rows = readTable_(ctx, table);
  }
  rows = applyFilters_(rows, op.filters);
  if (op.order && op.order.col) {
    const c = op.order.col;
    const asc = op.order.asc !== false;
    const textual = !/(_at|_date)$/.test(c);
    rows = rows.slice().sort((a, b) => {
      const x = a[c] === null || a[c] === undefined ? '' : String(a[c]);
      const y = b[c] === null || b[c] === undefined ? '' : String(b[c]);
      const r = textual ? x.localeCompare(y, 'ar') : (x < y ? -1 : x > y ? 1 : 0);
      return asc ? r : -r;
    });
  }
  const out = rows.map(r => public_(table, r));
  return op.single ? single_(out) : out;
}

/* ============================== INSERT ============================== */

function insert_(ctx, op) {
  const table = op.table;
  checkTable_(table);
  const me = approved_(ctx);
  const list = Array.isArray(op.values) ? op.values : [op.values || {}];
  const created = list.map(v => appendRow_(ctx, table, build_(ctx, table, v || {}, me)));
  ctx.changed = true;
  if (!op.returning) return null;
  const out = created.map(r => public_(table, r));
  return op.single ? single_(out) : out;
}

function build_(ctx, table, v, me) {
  const now = now_();
  if (table === 'tasks') {
    if (!str_(v.title)) throw err_('عنوان المهمة مطلوب.');
    const assignee = str_(v.assignee_id) || me.id;
    requireMember_(ctx, assignee);
    const status = TASK_STATUSES.indexOf(v.status) >= 0 ? v.status : 'pending';
    const row = {
      id: Utilities.getUuid(), title: String(v.title).trim(), description: str_(v.description),
      project_id: str_(v.project_id), assignee_id: assignee, created_by: me.id,
      due_date: normDate_(v.due_date), remind_days: num_(v.remind_days, 3), priority: str_(v.priority) || 'normal',
      status: status, created_at: str_(v.created_at) || now,
      completed_at: status === 'completed' ? now : null, completed_by: status === 'completed' ? me.id : null,
      cancelled_at: status === 'cancelled' ? now : null,
    };
    if (assignee !== me.id) ctx.notify.push({ userId: assignee, payload: newTaskPayload_(me, row) });
    return row;
  }
  if (table === 'projects') {
    if (!str_(v.name)) throw err_('اسم المشروع مطلوب.');
    return {
      id: Utilities.getUuid(), name: String(v.name).trim(), color: str_(v.color) || '#b45309',
      status: 'active', created_by: me.id, created_at: str_(v.created_at) || now,
    };
  }
  if (table === 'wishlist_items') {
    if (!str_(v.title)) throw err_('اسم العنصر مطلوب.');
    return {
      id: Utilities.getUuid(), title: String(v.title).trim(), details: str_(v.details),
      status: v.status === 'acquired' ? 'acquired' : 'thinking', created_by: me.id, created_at: now,
      acquired_at: v.status === 'acquired' ? now : null,
      image_urls: Array.isArray(v.image_urls) ? v.image_urls.map(String) : [],
    };
  }
  throw err_('غير مسموح.', 'FORBIDDEN');
}

function newTaskPayload_(me, task) {
  return {
    title: 'مهمة جديدة',
    body: (me.full_name || 'أحد الأعضاء') + ' كلّفك بمهمة: ' + task.title,
    url: '/',
    tag: 'task-' + task.id,
  };
}

/* ============================== UPDATE ============================== */

function update_(ctx, op) {
  const table = op.table;
  checkTable_(table);
  if (table === 'push_tokens') throw err_('غير مسموح.', 'FORBIDDEN');
  const me = me_(ctx);
  if (table !== 'profiles') approved_(ctx);
  if (!op.filters || !op.filters.length) throw err_('التحديث يتطلب تحديد السجل.');
  const v = op.values || {};
  const rows = applyFilters_(readTable_(ctx, table), op.filters);
  const updated = rows.map(row => {
    const next = patch_(ctx, table, row, v, me);
    writeRow_(table, row._row, next);
    Object.keys(next).forEach(k => { row[k] = next[k]; });
    return row;
  });
  if (updated.length) ctx.changed = true;
  if (!op.returning) return null;
  const out = updated.map(r => public_(table, r));
  return op.single ? single_(out) : out;
}

function patch_(ctx, table, row, v, me) {
  const next = {};
  Object.keys(row).forEach(k => { next[k] = row[k]; });
  const has = k => Object.prototype.hasOwnProperty.call(v, k);
  const now = now_();
  const admin = isAdmin_(ctx);

  if (table === 'tasks') {
    const canManage = admin || row.assignee_id === me.id || row.created_by === me.id;
    const canProgress = admin || row.assignee_id === me.id;
    const EDIT = ['title', 'description', 'project_id', 'assignee_id', 'due_date', 'remind_days', 'priority', 'created_at'];
    if (EDIT.some(has) && !canManage) throw err_('لا تملك صلاحية تعديل هذه المهمة.', 'FORBIDDEN');
    if (has('title')) { if (!str_(v.title)) throw err_('عنوان المهمة مطلوب.'); next.title = String(v.title).trim(); }
    if (has('description')) next.description = str_(v.description);
    if (has('project_id')) next.project_id = str_(v.project_id);
    if (has('assignee_id')) {
      const a = str_(v.assignee_id);
      if (!a) throw err_('تحديد المكلف بالمهمة واجب لحفظها.');
      requireMember_(ctx, a);
      next.assignee_id = a;
    }
    if (has('due_date')) next.due_date = normDate_(v.due_date);
    if (has('remind_days')) next.remind_days = num_(v.remind_days, row.remind_days);
    if (has('priority')) next.priority = str_(v.priority) || 'normal';
    if (has('created_at')) next.created_at = str_(v.created_at) || row.created_at;
    if (has('status')) {
      const st = String(v.status);
      if (TASK_STATUSES.indexOf(st) < 0) throw err_('حالة غير صالحة.');
      const cancelRelated = st === 'cancelled' || row.status === 'cancelled';
      if (!(cancelRelated ? canManage : canProgress)) {
        throw err_(cancelRelated ? 'لا تملك صلاحية إلغاء هذه المهمة.' : 'الإنجاز والتأجيل لصاحب المهمة أو المسؤول فقط.', 'FORBIDDEN');
      }
      next.status = st;
      next.completed_at = st === 'completed' ? (row.status === 'completed' && row.completed_at ? row.completed_at : now) : null;
      next.completed_by = st === 'completed' ? (row.status === 'completed' && row.completed_by ? row.completed_by : me.id) : null;
      next.cancelled_at = st === 'cancelled' ? (row.status === 'cancelled' && row.cancelled_at ? row.cancelled_at : now) : null;
    }
    if (next.assignee_id !== row.assignee_id && next.assignee_id !== me.id) {
      ctx.notify.push({ userId: next.assignee_id, payload: newTaskPayload_(me, next) });
    }
    return next;
  }

  if (table === 'projects') {
    if (has('name')) { if (!str_(v.name)) throw err_('اسم المشروع مطلوب.'); next.name = String(v.name).trim(); }
    if (has('color')) next.color = str_(v.color) || row.color;
    if (has('created_at')) next.created_at = str_(v.created_at) || row.created_at;
    if (has('status')) {
      if (['active', 'cancelled'].indexOf(v.status) < 0) throw err_('حالة غير صالحة.');
      next.status = v.status;
    }
    return next;
  }

  if (table === 'wishlist_items') {
    if (has('title')) { if (!str_(v.title)) throw err_('اسم العنصر مطلوب.'); next.title = String(v.title).trim(); }
    if (has('details')) next.details = str_(v.details);
    if (has('image_urls')) next.image_urls = Array.isArray(v.image_urls) ? v.image_urls.map(String) : [];
    if (has('created_at')) next.created_at = str_(v.created_at) || row.created_at;
    if (has('acquired_at')) next.acquired_at = str_(v.acquired_at);
    if (has('status')) {
      if (['thinking', 'acquired'].indexOf(v.status) < 0) throw err_('حالة غير صالحة.');
      next.status = v.status;
    }
    return next;
  }

  if (table === 'profiles') {
    const self = row.id === me.id;
    if (!self && !admin) throw err_('لا تملك صلاحية تعديل هذا العضو.', 'FORBIDDEN');
    if (has('full_name')) next.full_name = str_(v.full_name) || row.full_name;
    if (has('avatar_url')) next.avatar_url = str_(v.avatar_url);
    if (has('password_changed')) {
      if (!self) throw err_('غير مسموح.', 'FORBIDDEN');
      next.password_changed = !!v.password_changed;
    }
    if (has('status') || has('role')) {
      if (!admin) throw err_('هذا الإجراء للمسؤول فقط.', 'FORBIDDEN');
      if (has('status')) {
        if (['pending', 'approved', 'rejected'].indexOf(v.status) < 0) throw err_('حالة غير صالحة.');
        next.status = v.status;
      }
      if (has('role')) {
        if (['admin', 'member'].indexOf(v.role) < 0) throw err_('صلاحية غير صالحة.');
        next.role = v.role;
      }
      const admins = readTable_(ctx, 'profiles')
        .map(p => (p.id === row.id ? next : p))
        .filter(p => p.status === 'approved' && p.role === 'admin');
      if (!admins.length) throw err_('لا يمكن إزالة آخر مسؤول.', 'FORBIDDEN');
    }
    return next;
  }

  throw err_('غير مسموح.', 'FORBIDDEN');
}

/* ============================== DELETE ============================== */

function delete_(ctx, op) {
  const table = op.table;
  checkTable_(table);
  const me = approved_(ctx);
  const admin = isAdmin_(ctx);
  if (!op.filters || !op.filters.length) throw err_('الحذف يتطلب تحديد السجل.');
  const rows = applyFilters_(readTable_(ctx, table), op.filters);

  if (table === 'tasks' || table === 'projects') {
    if (!admin) throw err_('الحذف النهائي من صلاحيات المسؤولين فقط.', 'FORBIDDEN');
  } else if (table === 'wishlist_items') {
    rows.forEach(r => {
      if (!admin && r.created_by !== me.id) throw err_('الحذف لمن أدرج العنصر أو للمسؤول فقط.', 'FORBIDDEN');
    });
  } else {
    throw err_('غير مسموح.', 'FORBIDDEN');
  }

  const out = rows.map(r => public_(table, r));
  if (rows.length) {
    deleteRows_(ctx, table, rows.map(r => r._row));
    if (table === 'projects') {
      // المهام المرتبطة تبقى بدون مشروع (مثل ON DELETE SET NULL)
      const ids = rows.map(r => r.id);
      readTable_(ctx, 'tasks').forEach(t => {
        if (t.project_id && ids.indexOf(t.project_id) >= 0) {
          t.project_id = null;
          writeRow_('tasks', t._row, t);
        }
      });
    }
    ctx.changed = true;
  }
  return op.returning ? (op.single ? single_(out) : out) : null;
}

/* ============================== RPC ============================== */

function rpc_(ctx, name, args) {
  if (name === 'register_push') {
    const me = me_(ctx);
    const token = str_(args.p_token);
    if (!token) throw err_('رمز التنبيهات مفقود.');
    const rows = readTable_(ctx, 'push_tokens').filter(t => t.token === token);
    if (rows.length) {
      rows.forEach(r => { r.user_id = me.id; writeRow_('push_tokens', r._row, r); });
    } else {
      appendRow_(ctx, 'push_tokens', { id: Utilities.getUuid(), user_id: me.id, token: token, created_at: now_() });
    }
    return null;
  }
  if (name === 'unregister_push') {
    me_(ctx);
    const token = str_(args.p_token);
    if (!token) return null;
    const rows = readTable_(ctx, 'push_tokens').filter(t => t.token === token);
    if (rows.length) deleteRows_(ctx, 'push_tokens', rows.map(r => r._row));
    return null;
  }
  if (name === 'admin_reset_password') {
    if (!isAdmin_(ctx)) throw err_('هذا الإجراء للمسؤول فقط.', 'FORBIDDEN');
    const target = readTable_(ctx, 'profiles').filter(p => p.id === args.target)[0];
    if (!target) throw err_('العضو غير موجود.');
    setPassword_(target, DEFAULT_PASSWORD);
    target.password_changed = false;
    writeRow_('profiles', target._row, target);
    revokeUserSessions_(target.id, null);
    ctx.changed = true;
    return null;
  }
  if (name === 'push_test') {
    const me = me_(ctx);
    return sendPushToUser(me.id, { title: 'تنبيه تجريبي ✅', body: 'إذا ظهر لك هذا التنبيه فإعداد التنبيهات سليم.', url: '/', tag: 'test' });
  }
  throw err_('دالة غير معروفة: ' + name);
}

/* ============================== تسجيل الدخول ============================== */

function hash_(pw, salt) {
  let h = Utilities.computeHmacSha256Signature(String(pw), String(salt), Utilities.Charset.UTF_8);
  const key = Utilities.newBlob(String(salt)).getBytes();
  for (let i = 0; i < 300; i++) h = Utilities.computeHmacSha256Signature(h, key);
  return Utilities.base64Encode(h);
}

function setPassword_(profile, pw) {
  profile.salt = Utilities.getUuid();
  profile.password_hash = hash_(pw, profile.salt);
}

function newSession_(uid, email) {
  const token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  props_().setProperty('S_' + token, JSON.stringify({ u: uid, e: Date.now() + SESSION_DAYS * 864e5 }));
  return { access_token: token, user: { id: uid, email: email } };
}

function sessionUid_(token) {
  if (!token || typeof token !== 'string' || token.length > 100) return null;
  const raw = props_().getProperty('S_' + token);
  if (!raw) return null;
  try {
    const s = JSON.parse(raw);
    if (s.e < Date.now()) { props_().deleteProperty('S_' + token); return null; }
    return s.u;
  } catch (e) { return null; }
}

function pruneSessions_() {
  const p = props_();
  const all = p.getProperties();
  const now = Date.now();
  Object.keys(all).forEach(k => {
    if (k.indexOf('S_') !== 0) return;
    try { if (JSON.parse(all[k]).e < now) p.deleteProperty(k); } catch (e) { p.deleteProperty(k); }
  });
}

function revokeUserSessions_(uid, exceptToken) {
  const p = props_();
  const all = p.getProperties();
  Object.keys(all).forEach(k => {
    if (k.indexOf('S_') !== 0 || k === 'S_' + exceptToken) return;
    try { if (JSON.parse(all[k]).u === uid) p.deleteProperty(k); } catch (e) { /* تجاهل */ }
  });
}

function auth_(ctx, action, a) {
  if (action === 'signup') {
    const email = String(a.email || '').trim().toLowerCase();
    const password = String(a.password || '');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw err_('البريد الإلكتروني غير صالح.');
    if (password.length < 6) throw err_('كلمة المرور يجب أن تكون 6 أحرف على الأقل.');
    const profiles = readTable_(ctx, 'profiles');
    if (profiles.some(p => String(p.email || '').toLowerCase() === email)) throw err_('هذا البريد مسجّل مسبقاً. سجّل الدخول بدلاً من ذلك.');
    // أول حساب في نظام فارغ يصبح مسؤولاً تلقائياً
    const bootstrap = !profiles.some(p => p.status === 'approved' && p.role === 'admin');
    const row = {
      id: Utilities.getUuid(), full_name: str_(a.full_name) || email.split('@')[0], email: email,
      avatar_url: str_(a.avatar_url), role: bootstrap ? 'admin' : 'member', status: bootstrap ? 'approved' : 'pending',
      password_changed: true, created_at: now_(),
    };
    setPassword_(row, password);
    appendRow_(ctx, 'profiles', row);
    ctx.changed = true;
    const session = newSession_(row.id, email);
    return { session: session, user: session.user };
  }
  if (action === 'login') {
    const email = String(a.email || '').trim().toLowerCase();
    const p = readTable_(ctx, 'profiles').filter(x => String(x.email || '').toLowerCase() === email)[0];
    if (!p || !p.salt || hash_(String(a.password || ''), p.salt) !== p.password_hash) {
      throw err_('Invalid login credentials', 'INVALID_LOGIN');
    }
    pruneSessions_();
    const session = newSession_(p.id, p.email);
    return { session: session, user: session.user };
  }
  if (action === 'logout') {
    if (ctx.token) props_().deleteProperty('S_' + ctx.token);
    return null;
  }
  if (action === 'update_password') {
    const me = me_(ctx);
    const password = String(a.password || '');
    if (password.length < 6) throw err_('كلمة المرور يجب أن تكون 6 أحرف على الأقل.');
    setPassword_(me, password);
    me.password_changed = true;
    writeRow_('profiles', me._row, me);
    revokeUserSessions_(me.id, ctx.token);
    ctx.changed = true;
    return { user: { id: me.id, email: me.email } };
  }
  if (action === 'get_user') {
    const me = me_(ctx);
    return { user: { id: me.id, email: me.email } };
  }
  throw err_('إجراء غير معروف: ' + action);
}

/* ============================== الصور (Google Drive) ============================== */

function wishFolder_() {
  const p = props_();
  const id = p.getProperty('WISH_FOLDER_ID');
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (e) { /* أُنشئ من جديد */ }
  }
  const folder = DriveApp.createFolder('صور التفكير — مهام الإعلام');
  p.setProperty('WISH_FOLDER_ID', folder.getId());
  return folder;
}

function driveUrl_(id) {
  // الجزء بعد # لا يُرسل للخادم، ويسمح للتطبيق باستخراج معرّف الملف عند الحذف
  return 'https://drive.google.com/thumbnail?id=' + id + '&sz=w1600#/' + WISH_BUCKET + '/' + id;
}

function saveImage_(blob, name) {
  const file = wishFolder_().createFile(blob.setName(name));
  try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (e) {
    console.error('setSharing failed: ' + e);
  }
  return file.getId();
}

function upload_(ctx, op) {
  approved_(ctx);
  if (!op.base64) throw err_('الصورة فارغة.');
  const name = String(op.path || 'image.jpg').split('/').pop();
  const blob = Utilities.newBlob(Utilities.base64Decode(op.base64), op.contentType || 'image/jpeg', name);
  const id = saveImage_(blob, name);
  return { path: op.path, id: id, publicUrl: driveUrl_(id) };
}

function remove_(ctx, op) {
  approved_(ctx);
  const folderId = wishFolder_().getId();
  (op.paths || []).forEach(id => {
    try {
      const f = DriveApp.getFileById(String(id));
      const parents = f.getParents();
      while (parents.hasNext()) {
        if (parents.next().getId() === folderId) { f.setTrashed(true); break; }
      }
    } catch (e) { /* الملف غير موجود */ }
  });
  return null;
}

/* ============================== التنبيهات (FCM) ============================== */

function fcmConfig_() {
  const raw = props_().getProperty('FCM_SERVICE_ACCOUNT');
  if (!raw) throw err_('خاصية FCM_SERVICE_ACCOUNT غير مضبوطة في إعدادات السكربت.');
  return JSON.parse(raw);
}

function fcmAccessToken_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get('FCM_TOKEN');
  if (cached) return cached;
  const sa = fcmConfig_();
  const b64 = s => Utilities.base64EncodeWebSafe(s).replace(/=+$/, '');
  const now = Math.floor(Date.now() / 1000);
  const input = b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' })) + '.' + b64(JSON.stringify({
    iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  }));
  const sig = Utilities.base64EncodeWebSafe(Utilities.computeRsaSha256Signature(input, sa.private_key)).replace(/=+$/, '');
  const res = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', {
    method: 'post', muteHttpExceptions: true,
    payload: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: input + '.' + sig },
  });
  const j = JSON.parse(res.getContentText());
  if (!j.access_token) throw err_('تعذر الحصول على مفتاح FCM: ' + res.getContentText());
  cache.put('FCM_TOKEN', j.access_token, 3000);
  return j.access_token;
}

// يرسل تنبيهاً إلى كل أجهزة المستخدم، ويحذف الرموز المنتهية
function sendPushToUser(userId, payload) {
  const ctx = newCtx_();
  const subs = readTable_(ctx, 'push_tokens').filter(t => t.user_id === userId && t.token);
  const result = { total: subs.length, sent: 0, errors: [] };
  if (!subs.length) return result;
  const sa = fcmConfig_();
  const access = fcmAccessToken_();
  const data = {
    title: String(payload.title || ''), body: String(payload.body || ''),
    url: String(payload.url || '/'), tag: String(payload.tag || ''),
  };
  const responses = UrlFetchApp.fetchAll(subs.map(s => ({
    url: 'https://fcm.googleapis.com/v1/projects/' + sa.project_id + '/messages:send',
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + access },
    payload: JSON.stringify({ message: { token: s.token, data: data, webpush: { headers: { Urgency: 'high', TTL: '86400' } } } }),
  })));
  const dead = [];
  responses.forEach((r, i) => {
    const code = r.getResponseCode();
    if (code === 200) { result.sent++; return; }
    const text = r.getContentText();
    result.errors.push(code + ' ' + text.slice(0, 300));
    if (code === 404 || /UNREGISTERED|registration token/i.test(text)) dead.push(subs[i].id);
  });
  if (dead.length) {
    const lock = LockService.getScriptLock();
    if (lock.tryLock(10000)) {
      try {
        const c2 = newCtx_();
        const rows = readTable_(c2, 'push_tokens').filter(t => dead.indexOf(t.id) >= 0);
        if (rows.length) deleteRows_(c2, 'push_tokens', rows.map(r => r._row));
      } finally { lock.releaseLock(); }
    }
  }
  return result;
}

function list_(titles) {
  return titles.slice(0, 3).join('، ') + (titles.length > 3 ? '…' : '');
}

// يعمل يومياً الساعة 9 صباحاً بتوقيت الجزائر: تنبيه واحد لكل عضو بمهامه التي حلّ موعدها أو تأخرت
function dailyDue() {
  const ctx = newCtx_();
  const today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  const tasks = readTable_(ctx, 'tasks').filter(t =>
    t.assignee_id && t.due_date && t.due_date <= today && (t.status === 'pending' || t.status === 'deferred'));
  const users = {};
  tasks.forEach(t => {
    const e = users[t.assignee_id] || (users[t.assignee_id] = { dueToday: [], overdue: [] });
    if (t.due_date === today) e.dueToday.push(t.title); else e.overdue.push(t.title);
  });
  let notified = 0;
  Object.keys(users).forEach(uid => {
    const u = users[uid];
    const parts = [];
    if (u.dueToday.length) parts.push('موعد تسليمها اليوم (' + u.dueToday.length + '): ' + list_(u.dueToday));
    if (u.overdue.length) parts.push('متأخرة (' + u.overdue.length + '): ' + list_(u.overdue));
    try {
      const r = sendPushToUser(uid, {
        title: u.overdue.length && !u.dueToday.length ? '⚠️ مهام متأخرة' : '⏰ موعد تسليم',
        body: parts.join(' — '), url: '/', tag: 'due-' + today,
      });
      if (r.sent > 0) notified++;
      if (r.errors.length) console.error(uid + ': ' + r.errors.join(' | '));
    } catch (e) { console.error(uid + ': ' + e); }
  });
  console.log('dailyDue ' + today + ': tasks=' + tasks.length + ' users=' + Object.keys(users).length + ' notified=' + notified);
}

function testPushToAdmins() {
  const ctx = newCtx_();
  readTable_(ctx, 'profiles').filter(p => p.status === 'approved' && p.role === 'admin').forEach(p => {
    const r = sendPushToUser(p.id, { title: 'تنبيه تجريبي ✅', body: 'إذا ظهر لك هذا التنبيه فإعداد التنبيهات سليم.', url: '/', tag: 'test' });
    console.log((p.full_name || p.email) + ': ' + JSON.stringify(r));
  });
}

/* ============================== الإعداد ============================== */

function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  props_().setProperty('SPREADSHEET_ID', ss.getId());
  Object.keys(SCHEMA).forEach(name => {
    const sh = ss.getSheetByName(name) || ss.insertSheet(name);
    const cols = SCHEMA[name].cols;
    sh.getRange(1, 1, sh.getMaxRows(), cols.length).setNumberFormat('@');
    sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold').setBackground('#fef3c7');
    sh.setFrozenRows(1);
  });
  ss.getSheetByName('profiles').hideColumns(9, 2); // password_hash, salt
  ss.getSheetByName('push_tokens').hideSheet();
  buildDashboard_(ss);
  ss.getSheets().forEach(sh => {
    if (!SCHEMA[sh.getName()] && sh.getName() !== DASHBOARD && sh.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(sh);
  });
  wishFolder_();
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'dailyDue')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('dailyDue').timeBased().atHour(9).nearMinute(0).everyDays(1).inTimezone(TZ).create();
  bumpVersion_();
  console.log('تم الإعداد بنجاح.');
}

const DASHBOARD = 'لوحة المهام';

// ورقة للقراءة فقط تعرض المهام بأسماء مفهومة (تتحدث تلقائياً بالمعادلات)
function buildDashboard_(ss) {
  const sh = ss.getSheetByName(DASHBOARD) || ss.insertSheet(DASHBOARD, 0);
  sh.clear();
  sh.setRightToLeft(true);
  const headers = ['المهمة', 'المكلف', 'المشروع', 'الحالة', 'موعد التسليم', 'تاريخ الاستلام', 'تاريخ الإنجاز', 'أضافها', 'التفاصيل'];
  sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#b45309').setFontColor('#ffffff');
  sh.setFrozenRows(1);
  const ok = 'tasks!A2:A=""';
  const name = col => '=ARRAYFORMULA(IF(' + ok + ',,IFERROR(VLOOKUP(tasks!' + col + '2:' + col + ',profiles!A2:B,2,FALSE),"")))';
  sh.getRange('A2').setFormula('=ARRAYFORMULA(IF(' + ok + ',,tasks!B2:B))');
  sh.getRange('B2').setFormula(name('E'));
  sh.getRange('C2').setFormula('=ARRAYFORMULA(IF(' + ok + ',,IFERROR(VLOOKUP(tasks!D2:D,projects!A2:B,2,FALSE),"")))');
  sh.getRange('D2').setFormula('=ARRAYFORMULA(IF(' + ok + ',,IFERROR(VLOOKUP(tasks!J2:J,{"pending","قيد التنفيذ";"completed","مكتملة";"cancelled","ملغاة";"deferred","مؤجلة"},2,FALSE),tasks!J2:J)))');
  sh.getRange('E2').setFormula('=ARRAYFORMULA(IF(' + ok + ',,tasks!G2:G))');
  sh.getRange('F2').setFormula('=ARRAYFORMULA(IF(' + ok + ',,LEFT(tasks!K2:K,10)))');
  sh.getRange('G2').setFormula('=ARRAYFORMULA(IF(' + ok + ',,LEFT(tasks!L2:L,10)))');
  sh.getRange('H2').setFormula(name('F'));
  sh.getRange('I2').setFormula('=ARRAYFORMULA(IF(' + ok + ',,tasks!C2:C))');
  sh.setColumnWidth(1, 260);
  sh.setColumnWidth(9, 300);
}

// أي تعديل يدوي في الأوراق يصل إلى التطبيق خلال ثوانٍ
function onEdit(e) {
  try {
    const name = e && e.range && e.range.getSheet().getName();
    if (name && SCHEMA[name]) bumpVersion_();
  } catch (err) { /* تجاهل */ }
}

/* ============================== النقل من Supabase ============================== */

function migrateFromSupabase() {
  const p = props_();
  const url = String(p.getProperty('SUPABASE_URL') || '').replace(/\/$/, '');
  const key = p.getProperty('SUPABASE_SERVICE_KEY');
  if (!url || !key) throw new Error('أضف SUPABASE_URL و SUPABASE_SERVICE_KEY في خصائص السكربت أولاً.');
  const check = newCtx_();
  if (readTable_(check, 'tasks').length || readTable_(check, 'profiles').length) {
    throw new Error('الشيت يحتوي بيانات مسبقاً. امسح صفوف tasks و profiles (مع إبقاء العناوين) إن أردت إعادة النقل.');
  }

  const get = table => {
    let all = [], from = 0;
    for (;;) {
      const res = UrlFetchApp.fetch(url + '/rest/v1/' + table + '?select=*', {
        muteHttpExceptions: true,
        headers: { apikey: key, Authorization: 'Bearer ' + key, Range: from + '-' + (from + 999), 'Range-Unit': 'items' },
      });
      if (res.getResponseCode() >= 300) throw new Error(table + ': ' + res.getContentText());
      const rows = JSON.parse(res.getContentText());
      all = all.concat(rows);
      if (rows.length < 1000) return all;
      from += 1000;
    }
  };
  const iso = v => (v ? new Date(v).toISOString() : null);
  const s = str_;

  const profiles = get('profiles').map(r => {
    const o = {
      id: r.id, full_name: s(r.full_name), email: s(r.email) ? String(r.email).toLowerCase() : null,
      avatar_url: s(r.avatar_url), role: s(r.role) || 'member', status: s(r.status) || 'pending',
      password_changed: false, created_at: iso(r.created_at) || now_(),
    };
    setPassword_(o, DEFAULT_PASSWORD);
    return o;
  });
  writeAll_('profiles', profiles);

  const projects = get('projects').map(r => ({
    id: r.id, name: s(r.name) || 'مشروع', color: s(r.color) || '#b45309', status: s(r.status) || 'active',
    created_by: s(r.created_by), created_at: iso(r.created_at) || now_(),
  }));
  writeAll_('projects', projects);

  const tasks = get('tasks').map(r => ({
    id: r.id, title: s(r.title) || '—', description: s(r.description), project_id: s(r.project_id),
    assignee_id: s(r.assignee_id), created_by: s(r.created_by), due_date: r.due_date ? String(r.due_date).slice(0, 10) : null,
    remind_days: num_(r.remind_days, 3), priority: s(r.priority) || 'normal', status: s(r.status) || 'pending',
    created_at: iso(r.created_at) || now_(), completed_at: iso(r.completed_at), completed_by: s(r.completed_by),
    cancelled_at: iso(r.cancelled_at),
  }));
  writeAll_('tasks', tasks);

  let copied = 0, failed = 0;
  const wish = get('wishlist_items').map(r => {
    const urls = (Array.isArray(r.image_urls) ? r.image_urls : []).map(u => {
      try {
        const res = UrlFetchApp.fetch(u, { muteHttpExceptions: true });
        if (res.getResponseCode() !== 200) throw new Error('HTTP ' + res.getResponseCode());
        const blob = res.getBlob();
        const id = saveImage_(blob, String(u).split('/').pop().split('?')[0] || 'image.jpg');
        copied++;
        return driveUrl_(id);
      } catch (e) {
        failed++;
        console.error('image copy failed: ' + u + ' — ' + e);
        return u;
      }
    });
    return {
      id: r.id, title: s(r.title) || '—', details: s(r.details), status: s(r.status) || 'thinking',
      created_by: s(r.created_by), created_at: iso(r.created_at) || now_(), acquired_at: iso(r.acquired_at), image_urls: urls,
    };
  });
  writeAll_('wishlist_items', wish);

  bumpVersion_();
  console.log('تم النقل: أعضاء=' + profiles.length + ' مشاريع=' + projects.length + ' مهام=' + tasks.length +
    ' تفكير=' + wish.length + ' صور منقولة=' + copied + (failed ? ' صور فشل نقلها=' + failed : '') +
    '. كلمة مرور كل الأعضاء الآن: ' + DEFAULT_PASSWORD);
}
