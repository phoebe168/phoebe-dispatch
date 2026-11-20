/**
 * phoebe 派案進度追蹤 後端（Google Apps Script）
 *
 * 放在 phoebe Google 帳號的試算表裡：擴充功能 > Apps Script，把本檔全部貼上。
 * 第一次使用：
 *   1. 修改下面 SETUP_ADMIN 的姓名、手機
 *   2. 執行 setup()，在「執行記錄」看管理者 PIN
 *   3. 測試時可再執行 createTestData()
 *   4. 部署 > 新增部署作業 > 網頁應用程式（執行身分：我；存取權：所有人）
 */

// ===== 設定 =====
var TZ = 'Asia/Taipei';
var NORMAL_DAYS = 7;        // 第 1~7 天為正常
var MAX_DAYS = 15;          // 最多到第 15 天
var ADMIN_SESSION_HOURS = 12;
var TEACHER_SESSION_DAYS = 365;
var MAX_FAILED = 5;         // PIN 連續錯誤幾次鎖定
var LOCK_MINUTES = 15;

var SETUP_ADMIN = { name: '美英', phone: '0900000000' };

var ST = {
  WAIT_REPLY: '待回覆',
  WAIT_SERVE: '待服務',
  DONE: '已完成',
  CANNOT: '無法服務',
  CANCELED: '已取消'
};
var CH = { PENDING: '待審', APPROVED: '核准', REJECTED: '駁回', VOID: '作廢' };

// ===== 資料表結構 =====
var SCHEMA = {
  users: { name: '帳號', cols: [
    ['id', '帳號編號'], ['name', '姓名'], ['phone', '手機'], ['role', '角色'],
    ['active', '啟用'], ['pinHash', 'PIN雜湊'], ['salt', '鹽'], ['ver', '登入版本'],
    ['failed', '錯誤次數'], ['lockedUntil', '鎖定至'], ['createdAt', '建立時間']
  ]},
  sessions: { name: '登入', cols: [
    ['token', '憑證'], ['userId', '帳號編號'], ['ver', '登入版本'],
    ['createdAt', '建立時間'], ['expiresAt', '到期時間']
  ]},
  cases: { name: '派案', cols: [
    ['id', '派案編號'], ['caseNo', '個案編號'], ['caseName', '個案姓名'],
    ['service', '服務項目'], ['region', '區域'], ['dispatchDate', '派案日期'],
    ['teacherId', '老師編號'], ['teacherName', '老師姓名'], ['note', '備註'],
    ['status', '狀態'], ['firstDate', '首次服務日'], ['day', '第幾天'],
    ['overReason', '超過7天原因'], ['repliedAt', '回覆時間'], ['doneAt', '完成時間'],
    ['cannotReason', '無法服務原因'], ['cannotAt', '無法服務時間'], ['reassignCount', '改派次數'],
    ['notified', '已通報'], ['notifiedAt', '通報時間'], ['notifiedBy', '通報人'],
    ['cancelReason', '取消原因'], ['createdAt', '建立時間'], ['createdBy', '建立人'], ['updatedAt', '更新時間']
  ]},
  changes: { name: '異動申請', cols: [
    ['id', '申請編號'], ['caseId', '派案編號'], ['teacherId', '老師編號'], ['teacherName', '老師姓名'],
    ['oldDate', '原日期'], ['oldDay', '原第幾天'], ['newDate', '新日期'], ['newDay', '新第幾天'],
    ['reason', '原因'], ['requestedAt', '申請時間'], ['status', '狀態'],
    ['reviewer', '審核人'], ['reviewedAt', '審核時間'], ['comment', '審核意見']
  ]},
  options: { name: '選項', cols: [
    ['category', '類別'], ['value', '選項'], ['sort', '排序']
  ]},
  logs: { name: '紀錄', cols: [
    ['at', '時間'], ['user', '操作人'], ['action', '動作'], ['caseId', '派案編號'], ['detail', '內容']
  ]}
};
var OPTION_CATEGORIES = ['服務項目', '區域'];

// ===== 入口 =====
function doGet() {
  return json_({ ok: true, data: { app: 'phoebe-dispatch', time: now_() } });
}

function doPost(e) {
  var req;
  try {
    req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, error: '資料格式錯誤' });
  }
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);
  } catch (err) {
    return json_({ ok: false, error: '系統忙碌中，請稍後再試' });
  }
  try {
    var data = route_(req);
    return json_({ ok: true, data: data });
  } catch (err) {
    var msg = (err && err.userMsg) ? err.userMsg : '系統錯誤：' + (err && err.message ? err.message : err);
    return json_({ ok: false, error: msg, code: err && err.code });
  } finally {
    lock.releaseLock();
  }
}

function route_(req) {
  var a = req.action;
  if (a === 'login') return login_(req.phone, req.pin);

  var me = auth_(req.token);
  var admin = me.role === '管理者';
  var teacherActions = { reply: 1, complete: 1, cannotServe: 1, requestChange: 1, cancelChange: 1 };
  var adminActions = { createCase: 1, updateCase: 1, cancelCase: 1, reassign: 1, reviewChange: 1,
    markNotified: 1, createUser: 1, updateUser: 1, resetPin: 1, saveOptions: 1, complete: 1 };

  if (a === 'bootstrap') return bootstrap_(me);
  if (a === 'logout') { logout_(req.token); return {}; }
  if (admin && !adminActions[a]) fail_('管理者沒有這個功能');
  if (!admin && !teacherActions[a]) fail_('沒有權限');

  var extra = {};
  switch (a) {
    case 'reply': reply_(me, req); break;
    case 'complete': complete_(me, req); break;
    case 'cannotServe': cannotServe_(me, req); break;
    case 'requestChange': requestChange_(me, req); break;
    case 'cancelChange': cancelChange_(me, req); break;
    case 'createCase': createCase_(me, req); break;
    case 'updateCase': updateCase_(me, req); break;
    case 'cancelCase': cancelCase_(me, req); break;
    case 'reassign': reassign_(me, req); break;
    case 'reviewChange': reviewChange_(me, req); break;
    case 'markNotified': markNotified_(me, req); break;
    case 'createUser': extra.pin = createUser_(me, req); break;
    case 'updateUser': updateUser_(me, req); break;
    case 'resetPin': extra.pin = resetPin_(me, req); break;
    case 'saveOptions': saveOptions_(me, req); break;
    default: fail_('未知的動作');
  }
  var out = bootstrap_(me);
  out.result = extra;
  return out;
}

// ===== 登入 =====
function login_(phone, pin) {
  phone = normPhone_(phone);
  pin = String(pin || '').trim();
  if (!phone || !/^\d{4}$/.test(pin)) fail_('請輸入手機號碼與 4 碼 PIN');
  var users = rows_('users');
  var u = find_(users, function (x) { return normPhone_(x.phone) === phone; });
  if (!u || u.active !== 'Y') fail_('手機號碼或 PIN 不正確');

  var now = new Date();
  if (u.lockedUntil && u.lockedUntil > fmtTime_(now)) {
    fail_('PIN 錯誤次數過多，請 ' + LOCK_MINUTES + ' 分鐘後再試，或請管理者重設');
  }
  if (hash_(u.salt, pin) !== u.pinHash) {
    var f = Number(u.failed || 0) + 1;
    u.failed = String(f);
    if (f >= MAX_FAILED) {
      u.failed = '0';
      u.lockedUntil = fmtTime_(new Date(now.getTime() + LOCK_MINUTES * 60000));
    }
    save_('users', u);
    fail_('手機號碼或 PIN 不正確');
  }
  u.failed = '0';
  u.lockedUntil = '';
  save_('users', u);

  cleanSessions_();
  var isAdmin = u.role === '管理者';
  var ms = isAdmin ? ADMIN_SESSION_HOURS * 3600000 : TEACHER_SESSION_DAYS * 86400000;
  var token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');
  insert_('sessions', {
    token: token, userId: u.id, ver: u.ver || '1',
    createdAt: fmtTime_(now), expiresAt: fmtTime_(new Date(now.getTime() + ms))
  });
  log_(u.name, '登入', '', '');
  return { token: token, user: publicUser_(u) };
}

function auth_(token) {
  if (!token) fail_('請重新登入', 'AUTH');
  var s = find_(rows_('sessions'), function (x) { return x.token === token; });
  if (!s) fail_('登入已失效，請重新登入', 'AUTH');
  if (s.expiresAt < fmtTime_(new Date())) fail_('登入已逾時，請重新登入', 'AUTH');
  var u = find_(rows_('users'), function (x) { return x.id === s.userId; });
  if (!u || u.active !== 'Y' || String(u.ver || '1') !== String(s.ver || '1')) fail_('登入已失效，請重新登入', 'AUTH');
  return u;
}

function logout_(token) {
  var sh = sheet_('sessions');
  var list = rows_('sessions');
  for (var i = list.length - 1; i >= 0; i--) {
    if (list[i].token === token) sh.deleteRow(list[i]._row);
  }
}

function cleanSessions_() {
  var sh = sheet_('sessions');
  var list = rows_('sessions');
  var now = fmtTime_(new Date());
  for (var i = list.length - 1; i >= 0; i--) {
    if (list[i].expiresAt < now) sh.deleteRow(list[i]._row);
  }
}

// ===== 讀取 =====
function bootstrap_(me) {
  var isAdmin = me.role === '管理者';
  var cases = rows_('cases');
  var changes = rows_('changes');
  var out = { user: publicUser_(me), today: today_(), rules: { normal: NORMAL_DAYS, max: MAX_DAYS } };
  if (isAdmin) {
    out.cases = cases.map(clean_);
    out.changes = changes.map(clean_);
    out.users = rows_('users').map(publicUser_);
    out.options = optionsMap_();
  } else {
    var mine = cases.filter(function (c) { return c.teacherId === me.id && c.status !== ST.CANCELED; });
    var ids = {};
    mine.forEach(function (c) { ids[c.id] = 1; });
    out.cases = mine.map(function (c) {
      var x = clean_(c);
      delete x.notified; delete x.notifiedAt; delete x.notifiedBy;
      return x;
    });
    out.changes = changes.filter(function (h) { return ids[h.caseId] && h.teacherId === me.id; }).map(clean_);
  }
  return out;
}

function optionsMap_() {
  var m = {};
  OPTION_CATEGORIES.forEach(function (k) { m[k] = []; });
  rows_('options').sort(function (a, b) { return Number(a.sort) - Number(b.sort); }).forEach(function (o) {
    if (!m[o.category]) m[o.category] = [];
    m[o.category].push(o.value);
  });
  return m;
}

// ===== 老師動作 =====
function myCase_(me, id) {
  var c = getCase_(id);
  if (me.role !== '管理者' && c.teacherId !== me.id) fail_('這不是你的派案');
  return c;
}

function getCase_(id) {
  var c = find_(rows_('cases'), function (x) { return x.id === id; });
  if (!c) fail_('找不到派案');
  return c;
}

function checkDate_(c, date, reason) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) fail_('請選擇日期');
  var d = dayDiff_(c.dispatchDate, date);
  if (d < 0 || d > MAX_DAYS) fail_('日期必須在派案日起 ' + MAX_DAYS + ' 天內');
  if (date < today_()) fail_('不能選擇已經過去的日期');
  if (d > NORMAL_DAYS && !String(reason || '').trim()) fail_('超過 ' + NORMAL_DAYS + ' 天，必須填寫原因');
  return d;
}

function reply_(me, req) {
  var c = myCase_(me, req.caseId);
  if (c.status !== ST.WAIT_REPLY) fail_('這筆派案目前不是待回覆狀態');
  var reason = String(req.reason || '').trim();
  var d = checkDate_(c, req.date, reason);
  c.firstDate = req.date;
  c.day = String(d);
  c.overReason = d > NORMAL_DAYS ? reason : '';
  c.status = ST.WAIT_SERVE;
  c.repliedAt = now_();
  c.updatedAt = now_();
  save_('cases', c);
  log_(me.name, '回覆首次服務日', c.id, req.date + '（第' + d + '天）' + (c.overReason ? ' 原因：' + c.overReason : ''));
}

function complete_(me, req) {
  var c = myCase_(me, req.caseId);
  if (c.status !== ST.WAIT_SERVE) fail_('這筆派案目前不是待服務狀態');
  if (c.firstDate > today_()) fail_('還沒到服務日期，不能回報完成');
  if (pendingChange_(c.id)) fail_('這筆派案有異動申請待審，請等管理者審核');
  c.status = ST.DONE;
  c.doneAt = now_();
  c.updatedAt = now_();
  save_('cases', c);
  log_(me.name, '回報完成', c.id, c.firstDate);
}

function cannotServe_(me, req) {
  var c = myCase_(me, req.caseId);
  if (c.status !== ST.WAIT_REPLY && c.status !== ST.WAIT_SERVE) fail_('這筆派案目前不能設為無法服務');
  var reason = String(req.reason || '').trim();
  if (!reason) fail_('請填寫無法服務的原因');
  voidPending_(c.id);
  c.status = ST.CANNOT;
  c.cannotReason = reason;
  c.cannotAt = now_();
  c.updatedAt = now_();
  save_('cases', c);
  log_(me.name, '無法服務', c.id, reason);
}

function requestChange_(me, req) {
  var c = myCase_(me, req.caseId);
  if (c.status !== ST.WAIT_SERVE) fail_('只有待服務的派案可以申請異動');
  if (pendingChange_(c.id)) fail_('已經有一筆異動申請待審');
  var reason = String(req.reason || '').trim();
  if (!reason) fail_('請填寫異動原因');
  if (req.date === c.firstDate) fail_('新日期和原日期相同');
  var d = checkDate_(c, req.date, reason);
  insert_('changes', {
    id: newId_('R'), caseId: c.id, teacherId: me.id, teacherName: me.name,
    oldDate: c.firstDate, oldDay: c.day, newDate: req.date, newDay: String(d),
    reason: reason, requestedAt: now_(), status: CH.PENDING
  });
  log_(me.name, '申請異動', c.id, c.firstDate + ' → ' + req.date + '（第' + d + '天） 原因：' + reason);
}

function cancelChange_(me, req) {
  var h = pendingChange_(req.caseId);
  if (!h || h.teacherId !== me.id) fail_('找不到可撤回的申請');
  h.status = CH.VOID;
  h.comment = '老師撤回';
  h.reviewedAt = now_();
  save_('changes', h);
  log_(me.name, '撤回異動申請', h.caseId, '');
}

function pendingChange_(caseId) {
  return find_(rows_('changes'), function (h) { return h.caseId === caseId && h.status === CH.PENDING; });
}

function voidPending_(caseId) {
  rows_('changes').forEach(function (h) {
    if (h.caseId === caseId && h.status === CH.PENDING) {
      h.status = CH.VOID;
      h.comment = '派案狀態變更，自動作廢';
      h.reviewedAt = now_();
      save_('changes', h);
    }
  });
}

// ===== 管理者動作 =====
function teacherById_(id) {
  var t = find_(rows_('users'), function (u) { return u.id === id; });
  if (!t || t.role !== '老師' || t.active !== 'Y') fail_('請選擇啟用中的老師');
  return t;
}

function caseFields_(req, c) {
  var f = req.fields || {};
  ['caseNo', 'caseName', 'service', 'region', 'note'].forEach(function (k) {
    if (f[k] !== undefined) c[k] = String(f[k]).trim();
  });
  if (!c.caseName) fail_('請填寫個案姓名');
  if (!c.service) fail_('請選擇服務項目');
}

function createCase_(me, req) {
  var f = req.fields || {};
  var c = { id: newId_('C'), status: ST.WAIT_REPLY, reassignCount: '0', createdAt: now_(), createdBy: me.name, updatedAt: now_() };
  caseFields_(req, c);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.dispatchDate || '')) fail_('請選擇派案日期');
  if (f.dispatchDate > today_()) fail_('派案日期不能是未來的日期');
  c.dispatchDate = f.dispatchDate;
  var t = teacherById_(f.teacherId);
  c.teacherId = t.id;
  c.teacherName = t.name;
  insert_('cases', c);
  log_(me.name, '建立派案', c.id, c.caseName + ' 派給 ' + t.name + '（' + c.dispatchDate + '）');
}

function updateCase_(me, req) {
  var c = getCase_(req.caseId);
  if (c.status === ST.CANCELED) fail_('已取消的派案不能修改');
  caseFields_(req, c);
  var f = req.fields || {};
  if (f.dispatchDate && f.dispatchDate !== c.dispatchDate) {
    if (c.status !== ST.WAIT_REPLY) fail_('老師回覆後就不能改派案日期');
    if (f.dispatchDate > today_()) fail_('派案日期不能是未來的日期');
    c.dispatchDate = f.dispatchDate;
  }
  c.updatedAt = now_();
  save_('cases', c);
  log_(me.name, '修改派案', c.id, '');
}

function cancelCase_(me, req) {
  var c = getCase_(req.caseId);
  if (c.status === ST.DONE || c.status === ST.CANCELED) fail_('這筆派案不能取消');
  var reason = String(req.reason || '').trim();
  if (!reason) fail_('請填寫取消原因');
  voidPending_(c.id);
  c.status = ST.CANCELED;
  c.cancelReason = reason;
  c.updatedAt = now_();
  save_('cases', c);
  log_(me.name, '取消派案', c.id, reason);
}

function reassign_(me, req) {
  var c = getCase_(req.caseId);
  if (c.status === ST.DONE || c.status === ST.CANCELED) fail_('這筆派案不能改派');
  var t = teacherById_(req.teacherId);
  if (t.id === c.teacherId && c.status !== ST.CANNOT) fail_('請選擇不同的老師');
  var old = c.teacherName;
  voidPending_(c.id);
  c.teacherId = t.id;
  c.teacherName = t.name;
  c.status = ST.WAIT_REPLY;
  c.firstDate = ''; c.day = ''; c.overReason = ''; c.repliedAt = '';
  c.cannotReason = ''; c.cannotAt = '';
  c.notified = ''; c.notifiedAt = ''; c.notifiedBy = '';
  c.reassignCount = String(Number(c.reassignCount || 0) + 1);
  c.updatedAt = now_();
  save_('cases', c);
  log_(me.name, '改派', c.id, old + ' → ' + t.name + '（派案日不變：' + c.dispatchDate + '）');
}

function reviewChange_(me, req) {
  var h = find_(rows_('changes'), function (x) { return x.id === req.changeId; });
  if (!h || h.status !== CH.PENDING) fail_('找不到待審的申請');
  var c = getCase_(h.caseId);
  h.reviewer = me.name;
  h.reviewedAt = now_();
  h.comment = String(req.comment || '').trim();
  if (req.approve) {
    if (c.status !== ST.WAIT_SERVE) fail_('派案已不是待服務狀態，無法核准');
    var d = dayDiff_(c.dispatchDate, h.newDate);
    if (d < 0 || d > MAX_DAYS) fail_('新日期已超出 ' + MAX_DAYS + ' 天範圍');
    h.status = CH.APPROVED;
    c.firstDate = h.newDate;
    c.day = String(d);
    c.overReason = d > NORMAL_DAYS ? h.reason : '';
    if (c.notified === 'Y') { c.notified = ''; c.notifiedAt = ''; c.notifiedBy = ''; }
    c.updatedAt = now_();
    save_('cases', c);
    log_(me.name, '核准異動', c.id, h.oldDate + ' → ' + h.newDate + '（第' + d + '天）');
  } else {
    h.status = CH.REJECTED;
    log_(me.name, '駁回異動', c.id, h.comment);
  }
  save_('changes', h);
}

function markNotified_(me, req) {
  var c = getCase_(req.caseId);
  if (req.value) {
    if (!(Number(c.day) > NORMAL_DAYS) || (c.status !== ST.WAIT_SERVE && c.status !== ST.DONE)) fail_('這筆派案不在異動通報清單內');
    c.notified = 'Y'; c.notifiedAt = now_(); c.notifiedBy = me.name;
  } else {
    c.notified = ''; c.notifiedAt = ''; c.notifiedBy = '';
  }
  save_('cases', c);
  log_(me.name, req.value ? '標記已通報' : '取消已通報', c.id, '');
}

function createUser_(me, req) {
  var name = String(req.name || '').trim();
  var phone = normPhone_(req.phone);
  var role = req.role === '管理者' ? '管理者' : '老師';
  if (!name) fail_('請填寫姓名');
  if (!/^09\d{8}$/.test(phone)) fail_('手機號碼格式不正確（09 開頭共 10 碼）');
  if (find_(rows_('users'), function (u) { return normPhone_(u.phone) === phone; })) fail_('這個手機號碼已經有帳號');
  var pin = newPin_();
  var salt = Utilities.getUuid();
  insert_('users', {
    id: newId_('U'), name: name, phone: phone, role: role, active: 'Y',
    pinHash: hash_(salt, pin), salt: salt, ver: '1', failed: '0', lockedUntil: '', createdAt: now_()
  });
  log_(me.name, '建立帳號', '', name + '（' + role + '）');
  return pin;
}

function updateUser_(me, req) {
  var u = find_(rows_('users'), function (x) { return x.id === req.id; });
  if (!u) fail_('找不到帳號');
  var name = String(req.name || '').trim();
  var phone = normPhone_(req.phone);
  if (!name) fail_('請填寫姓名');
  if (!/^09\d{8}$/.test(phone)) fail_('手機號碼格式不正確');
  if (find_(rows_('users'), function (x) { return x.id !== u.id && normPhone_(x.phone) === phone; })) fail_('這個手機號碼已經被其他帳號使用');
  var role = req.role === '管理者' ? '管理者' : '老師';
  var active = req.active ? 'Y' : 'N';
  if (u.id === me.id && (role !== '管理者' || active !== 'Y')) fail_('不能停用自己或取消自己的管理者身分');
  if (u.role === '老師' && (role !== '老師' || active !== 'Y')) {
    var open = rows_('cases').filter(function (c) {
      return c.teacherId === u.id && (c.status === ST.WAIT_REPLY || c.status === ST.WAIT_SERVE);
    });
    if (open.length) fail_('這位老師還有 ' + open.length + ' 筆進行中的派案，請先改派');
  }
  var changedLogin = normPhone_(u.phone) !== phone || u.role !== role || u.active !== active;
  u.name = name; u.phone = phone; u.role = role; u.active = active;
  if (changedLogin) u.ver = String(Number(u.ver || 1) + 1);
  save_('users', u);
  log_(me.name, '修改帳號', '', name);
}

function resetPin_(me, req) {
  var u = find_(rows_('users'), function (x) { return x.id === req.id; });
  if (!u) fail_('找不到帳號');
  var pin = newPin_();
  u.salt = Utilities.getUuid();
  u.pinHash = hash_(u.salt, pin);
  u.ver = String(Number(u.ver || 1) + 1);   // 舊裝置登入全部失效
  u.failed = '0';
  u.lockedUntil = '';
  save_('users', u);
  log_(me.name, '重設PIN', '', u.name);
  return pin;
}

function saveOptions_(me, req) {
  var cat = req.category;
  if (OPTION_CATEGORIES.indexOf(cat) < 0) fail_('未知的選項類別');
  var vals = (req.values || []).map(function (v) { return String(v).trim(); }).filter(function (v) { return v; });
  var seen = {};
  vals = vals.filter(function (v) { if (seen[v]) return false; seen[v] = 1; return true; });
  var sh = sheet_('options');
  var list = rows_('options');
  for (var i = list.length - 1; i >= 0; i--) {
    if (list[i].category === cat) sh.deleteRow(list[i]._row);
  }
  vals.forEach(function (v, i) { insert_('options', { category: cat, value: v, sort: String(i + 1) }); });
  log_(me.name, '修改選項', '', cat + '：' + vals.join('、'));
}

// ===== 設定與測試資料（在 Apps Script 編輯器手動執行） =====
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(SCHEMA).forEach(function (k) {
    var def = SCHEMA[k];
    var sh = ss.getSheetByName(def.name) || ss.insertSheet(def.name);
    var headers = def.cols.map(function (c) { return c[1]; });
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, sh.getMaxRows(), headers.length).setNumberFormat('@');
  });
  if (!rows_('options').length) {
    var defaults = { '服務項目': ['居家照顧', '專業服務', '喘息服務'], '區域': ['竹北', '竹東', '新埔'] };
    Object.keys(defaults).forEach(function (cat) {
      defaults[cat].forEach(function (v, i) { insert_('options', { category: cat, value: v, sort: String(i + 1) }); });
    });
  }
  var phone = normPhone_(SETUP_ADMIN.phone);
  if (!find_(rows_('users'), function (u) { return normPhone_(u.phone) === phone; })) {
    var pin = createUser_({ name: '系統設定' }, { name: SETUP_ADMIN.name, phone: phone, role: '管理者' });
    Logger.log('管理者 ' + SETUP_ADMIN.name + '（' + phone + '）的 PIN：' + pin);
  } else {
    Logger.log('管理者帳號已存在，若忘記 PIN 請執行 resetAdminPin()');
  }
}

/** 管理者忘記 PIN 時，在編輯器執行，PIN 會顯示在執行記錄 */
function resetAdminPin() {
  var phone = normPhone_(SETUP_ADMIN.phone);
  var u = find_(rows_('users'), function (x) { return normPhone_(x.phone) === phone; });
  if (!u) { Logger.log('找不到 SETUP_ADMIN 的帳號'); return; }
  Logger.log(u.name + ' 的新 PIN：' + resetPin_({ name: '系統設定' }, { id: u.id }));
}

/** 建立測試用老師與派案，老師 PIN 會顯示在執行記錄 */
function createTestData() {
  var sys = { name: '測試資料' };
  var teachers = [['王小美', '0911000001'], ['李大華', '0911000002'], ['陳阿玉', '0911000003']];
  teachers.forEach(function (t) {
    if (find_(rows_('users'), function (u) { return normPhone_(u.phone) === t[1]; })) return;
    var pin = createUser_(sys, { name: t[0], phone: t[1], role: '老師' });
    Logger.log('老師 ' + t[0] + '（' + t[1] + '）PIN：' + pin);
  });
  var users = rows_('users').filter(function (u) { return u.role === '老師'; });
  var opts = optionsMap_();
  var names = ['張○○', '林○○', '黃○○', '吳○○', '劉○○', '蔡○○'];
  var back = [0, 2, 5, 9, 12, 16];
  names.forEach(function (n, i) {
    var t = users[i % users.length];
    createCase_(sys, { fields: {
      caseNo: 'T' + (1001 + i), caseName: n, service: opts['服務項目'][i % opts['服務項目'].length],
      region: opts['區域'][i % opts['區域'].length], note: '測試資料',
      dispatchDate: addDays_(today_(), -back[i]), teacherId: t.id
    }});
  });
  Logger.log('已建立 ' + names.length + ' 筆測試派案');
}

/** 正式上線前清空：刪除所有派案、異動、紀錄、登入，以及所有老師帳號（管理者保留） */
function clearTestData() {
  ['cases', 'changes', 'logs', 'sessions'].forEach(function (k) {
    var sh = sheet_(k);
    if (sh.getLastRow() > 1) sh.deleteRows(2, sh.getLastRow() - 1);
  });
  var sh = sheet_('users');
  var list = rows_('users');
  for (var i = list.length - 1; i >= 0; i--) {
    if (list[i].role !== '管理者') sh.deleteRow(list[i]._row);
  }
  Logger.log('測試資料已清除');
}

// ===== 試算表存取 =====
function sheet_(key) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SCHEMA[key].name);
  if (!sh) fail_('找不到工作表「' + SCHEMA[key].name + '」，請先執行 setup()');
  return sh;
}

function headerIndex_(key, sh) {
  var lastCol = Math.max(sh.getLastColumn(), 1);
  var headers = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  var idx = {};
  SCHEMA[key].cols.forEach(function (c) {
    var i = headers.indexOf(c[1]);
    if (i >= 0) idx[c[0]] = i;
  });
  return { idx: idx, width: lastCol };
}

function rows_(key) {
  var sh = sheet_(key);
  var h = headerIndex_(key, sh);
  var last = sh.getLastRow();
  if (last < 2) return [];
  var values = sh.getRange(2, 1, last - 1, h.width).getValues();
  var out = [];
  values.forEach(function (r, i) {
    var o = { _row: i + 2 };
    var empty = true;
    Object.keys(h.idx).forEach(function (k) {
      var v = cell_(r[h.idx[k]]);
      if (v !== '') empty = false;
      o[k] = v;
    });
    if (!empty) out.push(o);
  });
  return out;
}

function toRow_(key, obj, h, base) {
  var row = base ? base.slice() : new Array(h.width).fill('');
  Object.keys(h.idx).forEach(function (k) {
    if (obj[k] === undefined) return;
    var v = obj[k] === null ? '' : String(obj[k]);
    row[h.idx[k]] = v === '' ? '' : "'" + v;    // 強制文字，避免 09 開頭與日期被轉格式
  });
  return row;
}

function insert_(key, obj) {
  var sh = sheet_(key);
  var h = headerIndex_(key, sh);
  sh.appendRow(toRow_(key, obj, h));
}

function save_(key, obj) {
  var sh = sheet_(key);
  var h = headerIndex_(key, sh);
  var cur = sh.getRange(obj._row, 1, 1, h.width).getValues()[0];
  sh.getRange(obj._row, 1, 1, h.width).setValues([toRow_(key, obj, h, cur)]);
}

function cell_(v) {
  if (v === null || v === undefined) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    var t = Utilities.formatDate(v, TZ, 'HH:mm:ss');
    return t === '00:00:00' ? Utilities.formatDate(v, TZ, 'yyyy-MM-dd') : Utilities.formatDate(v, TZ, 'yyyy-MM-dd HH:mm:ss');
  }
  return String(v);
}

// ===== 工具 =====
function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
function fail_(msg, code) { var e = new Error(msg); e.userMsg = msg; e.code = code || ''; throw e; }
function find_(arr, fn) { for (var i = 0; i < arr.length; i++) if (fn(arr[i])) return arr[i]; return null; }
function clean_(o) { var x = {}; Object.keys(o).forEach(function (k) { if (k !== '_row') x[k] = o[k]; }); return x; }
function publicUser_(u) {
  return { id: u.id, name: u.name, phone: u.phone, role: u.role, active: u.active === 'Y',
    locked: !!(u.lockedUntil && u.lockedUntil > fmtTime_(new Date())) };
}
function now_() { return fmtTime_(new Date()); }
function fmtTime_(d) { return Utilities.formatDate(d, TZ, 'yyyy-MM-dd HH:mm:ss'); }
function today_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'); }
function ymd_(s) { var p = s.split('-'); return Date.UTC(+p[0], +p[1] - 1, +p[2]); }
function dayDiff_(from, to) { return Math.round((ymd_(to) - ymd_(from)) / 86400000); }
function addDays_(s, n) {
  var d = new Date(ymd_(s) + n * 86400000);
  return d.getUTCFullYear() + '-' + ('0' + (d.getUTCMonth() + 1)).slice(-2) + '-' + ('0' + d.getUTCDate()).slice(-2);
}
function normPhone_(p) {
  var s = String(p || '').replace(/\D/g, '');
  if (s.length === 9 && s.charAt(0) === '9') s = '0' + s;
  return s;
}
function newId_(prefix) {
  return prefix + Utilities.formatDate(new Date(), TZ, 'yyMMdd') + '-' + Utilities.getUuid().replace(/-/g, '').slice(0, 6);
}
function newPin_() { return ('000' + Math.floor(Math.random() * 10000)).slice(-4); }
function hash_(salt, pin) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + ':' + pin, Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join('');
}
function log_(user, action, caseId, detail) {
  insert_('logs', { at: now_(), user: user, action: action, caseId: caseId, detail: detail });
}
