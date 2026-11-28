(function () {
  'use strict';

  // ===== 儲存 =====
  var store = {
    get: function (k, session) { try { return (session ? sessionStorage : localStorage).getItem(k); } catch (e) { return null; } },
    set: function (k, v, session) { try { (session ? sessionStorage : localStorage).setItem(k, v); } catch (e) {} },
    del: function (k) { try { localStorage.removeItem(k); sessionStorage.removeItem(k); } catch (e) {} }
  };
  // ===== 機構品牌（每家在 config.js 設定） =====
  var CFG = window.CONFIG || {};
  var BRAND = {
    org: CFG.ORG_NAME || 'phoebe 營養諮詢中心',
    title: CFG.TITLE || '派案追蹤',
    logo: CFG.LOGO || 'logo.png',
    color: CFG.COLOR || '#33665f',
    accent: CFG.ACCENT || '#7f6c5e'
  };
  function mix(hex, to, p) {
    var a = parseInt(hex.slice(1), 16), b = parseInt(to.slice(1), 16), out = '#';
    [16, 8, 0].forEach(function (sh) {
      var x = (a >> sh) & 255, y = (b >> sh) & 255;
      out += ('0' + Math.round(x + (y - x) * p).toString(16)).slice(-2);
    });
    return out;
  }
  (function applyBrand() {
    var ok = /^#[0-9a-f]{6}$/i;
    if (!ok.test(BRAND.color)) BRAND.color = '#33665f';
    if (!ok.test(BRAND.accent)) BRAND.accent = '#7f6c5e';
    var r = document.documentElement.style;
    r.setProperty('--blue', BRAND.color);
    r.setProperty('--blue-d', mix(BRAND.color, '#000000', 0.25));
    r.setProperty('--blue-l', mix(BRAND.color, '#ffffff', 0.86));
    r.setProperty('--brown', BRAND.accent);
    r.setProperty('--brown-l', mix(BRAND.accent, '#ffffff', 0.88));
    document.title = BRAND.org + ' ' + BRAND.title;
    var m = document.querySelector('meta[name=theme-color]'); if (m) m.setAttribute('content', BRAND.color);
    m = document.querySelector('meta[name=apple-mobile-web-app-title]'); if (m) m.setAttribute('content', BRAND.title);
    var b = document.querySelector('.topbar .brand');
    if (b) b.innerHTML = '<img src="' + BRAND.logo + '" alt="' + BRAND.org + '"><span>' + BRAND.title + '</span>';
  })();

  // 同一個網址放多家時，用 ORG 區分登入資料（phoebe 維持原本的名稱，不會被登出）
  var KP = 'pd_' + (CFG.ORG ? CFG.ORG + '_' : '');
  var K_TEACHER = KP + 'teacher_token', K_ADMIN = KP + 'admin_token', K_PHONE = KP + 'phone', K_DATA = KP + 'data';
  var adminSession = !!store.get(K_ADMIN, true);

  var S = {
    token: store.get(K_ADMIN, true) || store.get(K_TEACHER) || '',
    data: null,
    queue: [],        // 等待送到伺服器的動作（依序送）
    base: null,       // 第一筆待送動作之前的資料，失敗時還原用
    syncing: false,
    tTab: '待回覆',
    nav: '派案',
    filter: '待回覆',
    q: ''
  };

  var $app = document.getElementById('app');
  var $who = document.getElementById('who');
  var $modal = document.getElementById('modal');
  var $mbody = document.getElementById('modalBody');

  // ===== 共用 =====
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function toast(msg, err) {
    var t = document.getElementById('toast');
    t.textContent = msg;
    t.className = 'toast' + (err ? ' err' : '');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.className = 'toast hidden'; }, err ? 4000 : 2200);
  }
  function busy(on) { document.getElementById('busy').className = on ? 'busy' : 'busy hidden'; }

  // quiet：背景呼叫，不擋畫面、不跳錯誤
  function api(action, payload, quiet) {
    var body = Object.assign({ action: action, token: S.token }, payload || {});
    if (!quiet) busy(true);
    return fetch(window.CONFIG.API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body)
    }).then(function (r) { return r.json(); })
      .catch(function () { return { ok: false, error: '連線失敗，請確認網路後再試', net: true }; })
      .then(function (res) {
        if (!quiet) busy(false);
        if (!res.ok) {
          if (res.code === 'AUTH') { logoutLocal(); toast(res.error, true); return Promise.reject(res); }
          if (!quiet) toast(res.error, true);
          return Promise.reject(res);
        }
        return res.data;
      });
  }

  // ===== 資料與背景同步 =====
  function setData(d) {
    S.data = d;
    store.set(K_DATA, JSON.stringify(d), adminSession);
  }
  function nowStr() {
    var d = new Date(Date.now() + 8 * 3600000);
    return d.toISOString().slice(0, 19).replace('T', ' ');
  }
  function syncBadge() {
    var el = document.getElementById('sync');
    if (!el) return;
    if (S.queue.length) { el.textContent = '儲存中…'; el.className = 'sync'; }
    else { el.textContent = '已儲存'; el.className = 'sync done'; clearTimeout(syncBadge._t); syncBadge._t = setTimeout(function () { el.className = 'sync hidden'; }, 1200); }
  }
  // 使用者正在輸入時不重畫，免得游標跑掉
  function safeRender() {
    var a = document.activeElement;
    if (a && $app.contains(a) && /INPUT|TEXTAREA|SELECT/.test(a.tagName)) { S.dirty = true; return; }
    render();
  }
  function pump() {
    if (S.syncing || !S.queue.length) return;
    S.syncing = true;
    var job = S.queue[0];
    api(job.action, job.payload, true).then(function (d) {
      S.queue.shift();
      S.syncing = false;
      if (!S.queue.length) { S.base = null; setData(d); safeRender(); }
      syncBadge();
      pump();
    }, function (err) {
      S.syncing = false;
      if (err && err.code === 'AUTH') { S.queue = []; return; }
      // 失敗：還原到送出前，再向伺服器拿最新資料
      S.queue = [];
      if (S.base) { S.data = S.base; S.base = null; }
      closeModal(); render(); syncBadge();
      toast((err && err.error ? err.error : '儲存失敗') + '，畫面已還原', true);
      refresh();
    });
  }
  function refresh() {
    if (!S.token || S.queue.length) return Promise.resolve();
    return api('bootstrap', null, true).then(function (d) {
      if (S.queue.length) return;
      setData(d); safeRender();
    }, function () {});
  }

  function ymd(s) { var p = s.split('-'); return Date.UTC(+p[0], +p[1] - 1, +p[2]); }
  function diff(a, b) { return Math.round((ymd(b) - ymd(a)) / 86400000); }
  function addDays(s, n) {
    var d = new Date(ymd(s) + n * 86400000);
    return d.getUTCFullYear() + '-' + ('0' + (d.getUTCMonth() + 1)).slice(-2) + '-' + ('0' + d.getUTCDate()).slice(-2);
  }
  var WK = ['日', '一', '二', '三', '四', '五', '六'];
  function md(s) { if (!s) return ''; var d = new Date(ymd(s)); return (d.getUTCMonth() + 1) + '/' + d.getUTCDate() + '（' + WK[d.getUTCDay()] + '）'; }
  function full(s) { return s ? s.slice(0, 4) + '/' + md(s) : ''; }

  function openModal(html) { $mbody.innerHTML = html; $modal.className = 'modal'; }
  function closeModal() { $modal.className = 'modal hidden'; $mbody.innerHTML = ''; }
  $modal.addEventListener('click', function (e) { if (e.target === $modal) closeModal(); });

  function isAdmin() { return S.data && S.data.user.role === '管理者'; }
  function rules() {
    var r = S.data.rules || {}, st = S.data.settings || {};
    return { normal: st.normalDays || r.normal || 7, max: st.maxDays || r.max || 15, range: r.range || 120 };
  }
  function overLabel() { return '超過 ' + rules().normal + ' 天原因'; }
  function today() { return nowStr().slice(0, 10); }   // 台灣時間的今天

  // ===== 登入 =====
  function logoutLocal() {
    store.del(K_TEACHER); store.del(K_ADMIN); store.del(K_DATA);
    S.token = ''; S.data = null; S.queue = []; S.base = null;
    renderLogin();
  }

  function renderLogin() {
    $who.innerHTML = '';
    var phone = store.get(K_PHONE) || '';
    $app.innerHTML =
      '<form class="login" id="loginForm" autocomplete="off">' +
      '<img class="logo" src="' + BRAND.logo + '" alt="' + BRAND.org + '">' +
      '<h1>' + BRAND.title + '</h1><p class="muted small">第一次使用請輸入手機與 4 碼 PIN，PIN 由管理者提供。</p>' +
      '<label for="lp">手機號碼</label><input id="lp" type="tel" inputmode="numeric" placeholder="09xxxxxxxx" value="' + esc(phone) + '">' +
      '<label for="lpin">PIN</label><input id="lpin" class="pin" type="password" inputmode="numeric" maxlength="4" placeholder="••••">' +
      '<button class="btn primary block" type="submit">登入</button>' +
      '<p class="small muted" style="text-align:center;margin:16px 0 0">操作說明：<a href="manual/teacher.html" target="_blank" rel="noopener">老師版</a>　<a href="manual/admin.html" target="_blank" rel="noopener">管理者版</a></p>' +
      '</form>';
    var lp = document.getElementById('lp'), lpin = document.getElementById('lpin');
    (phone ? lpin : lp).focus();
    document.getElementById('loginForm').addEventListener('submit', function (e) {
      e.preventDefault();
      api('login', { phone: lp.value, pin: lpin.value }).then(function (d) {
        S.token = d.token;
        store.set(K_PHONE, d.user.phone);
        adminSession = d.user.role === '管理者';
        if (adminSession) { store.set(K_ADMIN, d.token, true); store.del(K_TEACHER); }
        else store.set(K_TEACHER, d.token);
        S.filter = '待回覆'; S.tTab = '待回覆';
        setData(d.data); render();
      }).catch(function () { lpin.value = ''; lpin.focus(); });
    });
  }

  // ===== 各動作在畫面上的立即結果（與後端規則相同，後端回來後以後端為準） =====
  function cById(d, id) { return d.cases.filter(function (c) { return c.id === id; })[0]; }
  function voidPend(d, caseId) {
    d.changes.forEach(function (h) { if (h.caseId === caseId && h.status === '待審') { h.status = '作廢'; h.reviewedAt = nowStr(); } });
  }
  function setFirst(d, c, date, reason) {
    var n = diff(c.dispatchDate, date);
    c.firstDate = date; c.day = String(n);
    c.overReason = n > d.rules.normal ? reason : '';
    c.updatedAt = nowStr();
  }
  function clientById(d, id) { return (d.clients || []).filter(function (x) { return x.id === id; })[0]; }
  function newVisitLocal(d, c, date, kind) {
    d.visits = d.visits || [];
    d.visits.push({ id: 'tmp-v' + Date.now() + Math.floor(Math.random() * 1000), caseId: c.id, clientId: c.clientId, service: c.service,
      teacherId: c.teacherId, teacherName: c.teacherName, date: date, kind: kind, status: '已預約' });
  }
  function cancelBookedLocal(d, caseId) {
    (d.visits || []).forEach(function (v) { if (v.caseId === caseId && v.status === '已預約') v.status = '已取消'; });
  }
  function legacyLocal(d, c, last) {
    c.status = '服務中'; c.legacy = 'Y'; c.updatedAt = nowStr();
    newVisitLocal(d, c, last, '舊案');
    var v = d.visits[d.visits.length - 1]; v.status = '已完成'; v.doneAt = nowStr();
  }
  function vById(d, id) { return (d.visits || []).filter(function (v) { return v.id === id; })[0]; }
  var LOCAL = {
    bookVisit: function (d, p) { newVisitLocal(d, cById(d, p.caseId), p.date, '後續'); },
    moveVisit: function (d, p) { vById(d, p.visitId).date = p.date; },
    cancelVisit: function (d, p) { vById(d, p.visitId).status = '已取消'; },
    completeVisit: function (d, p) {
      var v = vById(d, p.visitId); v.status = '已完成'; v.doneAt = nowStr();
      if (v.kind === '首次') { var c = cById(d, v.caseId); c.status = '服務中'; c.doneAt = nowStr(); }
    },
    closeCase: function (d, p) {
      var c = cById(d, p.caseId); voidPend(d, c.id); cancelBookedLocal(d, c.id);
      c.status = '已結案'; c.closeReason = p.reason; c.closedAt = nowStr(); c.closedBy = d.user.name; c.closeSeen = ''; c.updatedAt = nowStr();
    },
    seeClosed: function (d, p) { p.caseIds.forEach(function (id) { var c = cById(d, id); if (c) c.closeSeen = 'Y'; }); },
    createClient: function (d, p) {
      d.clients = d.clients || [];
      d.clients.push({ id: p.id, name: p.name, careNo: p.careNo, region: p.region, note: p.note, createdAt: nowStr() });
    },
    updateClient: function (d, p) {
      var cl = clientById(d, p.id); cl.name = p.name; cl.careNo = p.careNo; cl.region = p.region; cl.note = p.note;
      d.cases.forEach(function (c) { if (c.clientId === cl.id) { c.caseName = cl.name; c.caseNo = cl.careNo; } });
    },
    saveSettings: function (d, p) {
      d.settings = Object.assign({}, d.settings);
      Object.keys(p.values).forEach(function (k) { d.settings[k] = k === 'closeSystem' ? String(p.values[k]) : Number(p.values[k]); });
    },
    reply: function (d, p) {
      var c = cById(d, p.caseId); setFirst(d, c, p.date, p.reason); c.status = '待服務'; c.repliedAt = nowStr();
      newVisitLocal(d, c, p.date, '首次');
    },
    complete: function (d, p) {
      var c = cById(d, p.caseId); c.status = '服務中'; c.doneAt = c.updatedAt = nowStr();
      var fv = firstVisitOf(d, c.id); if (fv) { fv.status = '已完成'; fv.doneAt = nowStr(); }
    },
    cannotServe: function (d, p) {
      var c = cById(d, p.caseId); voidPend(d, c.id); cancelBookedLocal(d, c.id);
      c.status = '無法服務'; c.cannotReason = p.reason; c.cannotAt = c.updatedAt = nowStr();
    },
    requestChange: function (d, p) {
      var c = cById(d, p.caseId);
      d.changes.push({ id: 'tmp-' + Date.now(), caseId: c.id, teacherId: c.teacherId, teacherName: c.teacherName,
        oldDate: c.firstDate, oldDay: c.day, newDate: p.date, newDay: String(diff(c.dispatchDate, p.date)),
        reason: p.reason, requestedAt: nowStr(), status: '待審' });
    },
    cancelChange: function (d, p) {
      d.changes.forEach(function (h) { if (h.caseId === p.caseId && h.status === '待審') { h.status = '作廢'; h.comment = '老師撤回'; h.reviewedAt = nowStr(); } });
    },
    reviewChange: function (d, p) {
      var h = d.changes.filter(function (x) { return x.id === p.changeId; })[0];
      var c = cById(d, h.caseId);
      h.reviewer = d.user.name; h.reviewedAt = nowStr(); h.comment = p.comment || '';
      if (p.approve) {
        h.status = '核准'; setFirst(d, c, h.newDate, h.reason);
        var fv = firstVisitOf(d, c.id); if (fv) fv.date = h.newDate;
        if (c.notified === 'Y') { c.notified = ''; c.notifiedAt = ''; c.notifiedBy = ''; }
      } else h.status = '駁回';
    },
    reassign: function (d, p) {
      var c = cById(d, p.caseId), t = d.users.filter(function (u) { return u.id === p.teacherId; })[0];
      voidPend(d, c.id); cancelBookedLocal(d, c.id);
      c.teacherId = t.id; c.teacherName = t.name; c.status = '待回覆';
      c.firstDate = c.day = c.overReason = c.repliedAt = c.cannotReason = c.cannotAt = '';
      c.notified = c.notifiedAt = c.notifiedBy = '';
      c.reassignCount = String(Number(c.reassignCount || 0) + 1); c.updatedAt = nowStr();
    },
    cancelCase: function (d, p) {
      var c = cById(d, p.caseId); voidPend(d, c.id); cancelBookedLocal(d, c.id);
      if (p.notified) { c.notified = 'Y'; c.notifiedAt = nowStr(); c.notifiedBy = d.user.name; }
      c.status = '已取消'; c.cancelReason = p.reason; c.updatedAt = nowStr();
    },
    markNotified: function (d, p) {
      var c = cById(d, p.caseId);
      if (p.value) { c.notified = 'Y'; c.notifiedAt = nowStr(); c.notifiedBy = d.user.name; }
      else { c.notified = c.notifiedAt = c.notifiedBy = ''; }
    },
    updateCase: function (d, p) {
      var c = cById(d, p.caseId);
      Object.keys(p.fields).forEach(function (k) { if ((k !== 'dispatchDate' && k !== 'clientId' && k !== 'service') || c.status === '待回覆') c[k] = p.fields[k]; });
      var cl = clientById(d, c.clientId); if (cl) { c.caseName = cl.name; c.caseNo = cl.careNo; }
      c.updatedAt = nowStr();
    },
    createCase: function (d, p) {
      var f = p.fields, t = d.users.filter(function (u) { return u.id === f.teacherId; })[0], cl = clientById(d, f.clientId) || {};
      d.cases.push({ id: 'tmp-' + Date.now(), clientId: f.clientId, caseNo: cl.careNo || '', caseName: cl.name || '', service: f.service, region: f.region || cl.region || '',
        dispatchDate: f.dispatchDate, teacherId: t.id, teacherName: t.name, note: f.note, status: '待回覆', reassignCount: '0',
        firstDate: '', day: '', createdAt: nowStr(), updatedAt: nowStr() });
      if (f.legacy) legacyLocal(d, d.cases[d.cases.length - 1], f.lastDate);
    },
    convertLegacy: function (d, p) { legacyLocal(d, cById(d, p.caseId), p.lastDate); },
    updateUser: function (d, p) {
      var u = d.users.filter(function (x) { return x.id === p.id; })[0];
      u.name = p.name.trim(); u.phone = p.phone.replace(/\D/g, ''); u.role = p.role; u.active = !!p.active;
    },
    saveOptions: function (d, p) {
      var seen = {};
      var vals = p.values.map(function (v) { return v.trim(); }).filter(function (v) { if (!v || seen[v]) return false; seen[v] = 1; return true; });
      if (p.category === '超過7天原因') {
        vals = vals.filter(function (v) { return v !== '其他' && v !== '其他：'; });
        if (!vals.length) vals = DEFAULT_OVER_REASONS.slice();
      }
      if (p.category === '異常通報原因') {
        vals = vals.filter(function (v) { return v !== '其他' && v !== '其他：' && v !== '其它'; });
        if (!vals.length) vals = ['家屬無法配合時間', '家屬不想參加'];
      }
      if (p.category === '結案原因') {
        vals = vals.filter(function (v) { return v !== '其它' && v !== '其他'; });
        if (!vals.length) vals = ['服務完成', '強制結案-死亡'];
      }
      d.options[p.category] = vals;
    }
  };

  // 開啟時：有上次的資料就先顯示，再到背景更新
  function start() {
    var cached = null;
    try { cached = JSON.parse(store.get(K_DATA, adminSession) || 'null'); } catch (e) {}
    if (cached && cached.user) {
      S.data = cached; render();
      refresh();
      return;
    }
    api('bootstrap').then(function (d) { setData(d); render(); }, function () { if (!S.data) renderLogin(); });
  }

  // local：在畫面上先套用結果的函式。有它就立即反應、背景送出；沒有就等伺服器（例如要拿 PIN）
  function act(action, payload, okMsg, local) {
    if (!local) {
      return api(action, payload).then(function (d) {
        setData(d); closeModal(); render();
        if (okMsg) toast(okMsg);
        return d;
      });
    }
    if (!S.queue.length) S.base = JSON.parse(JSON.stringify(S.data));
    if (local === true) local = function (d) { LOCAL[action](d, payload); };
    local(S.data);
    store.set(K_DATA, JSON.stringify(S.data), adminSession);
    closeModal(); render();
    if (okMsg) toast(okMsg);
    S.queue.push({ action: action, payload: payload });
    syncBadge();
    pump();
    return Promise.resolve(S.data);
  }

  function render() {
    var manual = isAdmin() ? 'manual/admin.html' : 'manual/teacher.html';
    $who.innerHTML = '<span class="uname">' + esc(S.data.user.name) + '</span><span class="role">' + esc(S.data.user.role) + '</span>' +
      '<a class="help" href="' + manual + '" target="_blank" rel="noopener">說明</a><button id="logout">登出</button>';
    document.getElementById('logout').onclick = function () {
      if (S.queue.length) return toast('資料還在儲存中，請稍候再登出', true);
      if (!confirm('確定要登出？下次需要重新輸入手機與 PIN。')) return;
      api('logout').catch(function () {}).then(logoutLocal);
    };
    if (isAdmin()) renderAdmin(); else renderTeacher();
  }

  // ===== 派案資訊 =====
  function pendingOf(c) {
    return (S.data.changes || []).filter(function (h) { return h.caseId === c.id && h.status === '待審'; })[0];
  }
  function lastRejected(c) {
    var list = (S.data.changes || []).filter(function (h) { return h.caseId === c.id && h.status !== '待審'; });
    list.sort(function (a, b) { return (b.reviewedAt || '').localeCompare(a.reviewedAt || ''); });
    return list[0] && list[0].status === '駁回' ? list[0] : null;
  }
  function dayTag(day) {
    if (day === '' || day == null) return '';
    var n = Number(day);
    return '<span class="tag ' + (n > rules().normal ? 'warn' : 'ok') + '">第 ' + n + ' 天</span>';
  }
  function elapsed(c) { return diff(c.dispatchDate, today()); }
  // ===== 服務紀錄與規則（和後端同一套規則，畫面上先判斷，不用等伺服器） =====
  function settings() {
    var d = { maxAhead: 4, monthCap: 3, gapDays: 7, remindDays: 21, normalDays: 7, maxDays: 15, closeSystem: '照管系統' };
    return Object.assign(d, S.data.settings || {});
  }
  function liveVisits() { return (S.data.visits || []).filter(function (v) { return v.status !== '已取消'; }); }
  function visitsOf(c) { return liveVisits().filter(function (v) { return v.caseId === c.id; }).sort(function (a, b) { return a.date.localeCompare(b.date); }); }
  function upcomingOf(c) { return visitsOf(c).filter(function (v) { return v.status === '已預約'; }); }
  function lastDoneOf(c) { var x = visitsOf(c).filter(function (v) { return v.status === '已完成'; }); return x.length ? x[x.length - 1].date : ''; }
  function findVisit(id) { return (S.data.visits || []).filter(function (v) { return v.id === id; })[0]; }
  // 0：正常　1：快到提醒天數（黃）　2：已超過（紅）
  function remindLevel(c) {
    if (c.status !== '服務中' || upcomingOf(c).length) return 0;
    var last = lastDoneOf(c); if (!last) return 0;
    var n = diff(last, today()), r = settings().remindDays;
    return n >= r ? 2 : (n >= r - 7 ? 1 : 0);
  }
  function overdueVisits(c) { return c.status === '服務中' ? upcomingOf(c).filter(function (v) { return v.date < today(); }) : []; }
  function overdueUnreported(c) { return (c.status === '待服務' && c.firstDate && c.firstDate < today()) || overdueVisits(c).length > 0; }
  // 個案無法服務、協調不成、已通報並取消
  function failedCase(c) { return c.status === '已取消' && !!c.cannotReason && c.notified === 'Y'; }
  // 異常通報分頁中還沒處理完的：逾 7 天未通報、個案無法服務尚未處理
  function abnormalPending(c) { return c.status === '無法服務' || (inReport(c) && c.notified !== 'Y'); }
  function inReport(c) { return !!c.firstDate && Number(c.day) > rules().normal && ['待回覆', '無法服務', '已取消'].indexOf(c.status) < 0; }
  function ruleCheck(c, date, excludeId) {
    if (!c.clientId) return '';
    var st = settings();
    var others = liveVisits().filter(function (v) { return v.clientId === c.clientId && v.service === c.service && v.id !== excludeId; });
    for (var i = 0; i < others.length; i++) {
      var v = others[i];
      if (Math.abs(diff(v.date, date)) < st.gapDays) {
        return (v.caseId === c.id ? '這個個案' : v.teacherName + ' 老師') + (v.status === '已完成' ? '已在 ' : '已預約 ') + md(v.date) +
          ' 服務 ' + c.service + '，同一服務碼別要間隔 ' + st.gapDays + ' 天以上';
      }
    }
    var m = date.slice(0, 7);
    var n = others.filter(function (v) { return v.date.slice(0, 7) === m; }).length;
    if (n >= st.monthCap) return Number(m.slice(5)) + ' 月 ' + c.service + ' 已排 ' + n + ' 次，已達每月上限 ' + st.monthCap + ' 次';
    return '';
  }
  function firstVisitOf(d, caseId) { return (d.visits || []).filter(function (v) { return v.caseId === caseId && v.kind === '首次' && v.status !== '已取消'; })[0]; }
  function closeReasons() {
    var o = S.data.options && S.data.options['結案原因'];
    return o && o.length ? o : ['服務完成', '強制結案-死亡'];
  }
  function visitRow(v, n, admin) {
    var past = v.status === '已預約' && v.date < today();
    var tag = v.status === '已完成' ? '<span class="tag ok">已完成</span>' : (past ? '<span class="tag bad">未回報</span>' : '<span class="tag">已預約</span>');
    var h = '<div class="vrow' + (v.status === '已完成' ? ' done' : '') + '"><span class="vno">' + (v.kind === '舊案' ? '上次服務' : (v.kind === '首次' ? '第 1 次' : '第 ' + n + ' 次')) + '</span>' +
      '<span class="vdate">' + full(v.date) + '</span>' + tag;
    return h + visitActs(v, admin) + '</div>';
  }
  function visitActs(v, admin) {
    if (v.status !== '已預約') return '';
    var b = [];
    if (v.date <= today()) b.push('<button class="btn sm ok" data-a="vdone" data-vid="' + v.id + '">' + (admin ? '代為回報完成' : '完成') + '</button>');
    if (!admin && v.kind === '後續') {
      b.push('<button class="btn sm" data-a="vmove" data-vid="' + v.id + '">改時間</button>');
      b.push('<button class="btn sm danger" data-a="vcancel" data-vid="' + v.id + '">取消</button>');
    }
    return b.length ? '<span class="vacts">' + b.join('') + '</span>' : '';
  }
  function visitNo(v) {
    if (v.kind === '舊案') return '上次服務';
    var c = findCase(v.caseId); if (!c) return '';
    var n = visitsOf(c).filter(function (x) { return x.kind !== '舊案'; }).map(function (x) { return x.id; }).indexOf(v.id);
    return n < 0 ? '' : '第 ' + (n + 1) + ' 次';
  }

  // ===== 行事曆 =====
  function calState() {
    if (!S.cal) S.cal = { month: today().slice(0, 7), day: today(), t: '', r: '', s: '' };
    return S.cal;
  }
  function calVisits(admin) {
    var st = calState(), me = S.data.user.id, cmap = {};
    S.data.cases.forEach(function (c) { cmap[c.id] = c; });
    return liveVisits().filter(function (v) {
      var c = cmap[v.caseId];
      if (!c) return false;
      if (!admin) return v.teacherId === me;
      return (!st.t || v.teacherId === st.t) && (!st.r || c.region === st.r) && (!st.s || v.service === st.s);
    }).map(function (v) { return { v: v, c: cmap[v.caseId] }; });
  }
  function monthShift(m, n) { var y = +m.slice(0, 4), mo = +m.slice(5) - 1 + n; y += Math.floor(mo / 12); mo = ((mo % 12) + 12) % 12; return y + '-' + ('0' + (mo + 1)).slice(-2); }
  function calendarView(admin) {
    var st = calState(), t0 = today(), items = calVisits(admin), byDay = {};
    items.forEach(function (x) { (byDay[x.v.date] = byDay[x.v.date] || []).push(x); });
    Object.keys(byDay).forEach(function (d) { byDay[d].sort(function (a, b) { return a.c.caseName.localeCompare(b.c.caseName); }); });
    var h = '';
    if (admin) {
      var o = S.data.options || {};
      var opt = function (id, list, sel, all) {
        return '<select id="' + id + '" class="calf"><option value="">' + all + '</option>' + list.map(function (x) {
          var v = typeof x === 'string' ? x : x.value, t = typeof x === 'string' ? x : x.text;
          return '<option value="' + esc(v) + '"' + (v === sel ? ' selected' : '') + '>' + esc(t) + '</option>'; }).join('') + '</select>';
      };
      h += '<div class="calfilters">' + opt('calT', teachers().map(function (u) { return { value: u.id, text: u.name }; }), st.t, '全部老師') +
        opt('calR', o['區域'] || [], st.r, '全部區域') + opt('calS', o['服務碼別'] || [], st.s, '全部服務碼別') + '</div>';
    }
    var mi = items.filter(function (x) { return x.v.date.slice(0, 7) === st.month; });
    var nb = mi.filter(function (x) { return x.v.status === '已預約'; }).length, nd = mi.length - nb;
    h += '<div class="mhead"><button class="btn sm" data-calm="-1">‹</button><b>' + st.month.slice(0, 4) + ' 年 ' + Number(st.month.slice(5)) + ' 月</b>' +
      '<button class="btn sm" data-calm="1">›</button><button class="btn sm" data-calm="0">今天</button>' +
      '<span class="muted small">本月 ' + mi.length + ' 次（已完成 ' + nd + '、已預約 ' + nb + '）</span></div>';
    var first = st.month + '-01', wd = new Date(ymd(first)).getUTCDay();
    h += '<div class="mcal">' + WK.map(function (w) { return '<div class="mw">' + w + '</div>'; }).join('');
    for (var i = 0; i < wd; i++) h += '<div class="mday blank"></div>';
    for (var ds = first; ds.slice(0, 7) === st.month; ds = addDays(ds, 1)) {
      var list = byDay[ds] || [];
      var late = list.filter(function (x) { return x.v.status === '已預約' && x.v.date < t0; }).length;
      var bk = list.filter(function (x) { return x.v.status === '已預約'; }).length - late, dn = list.length - bk - late;
      var cls = 'mday' + (ds === t0 ? ' today' : '') + (ds === st.day ? ' sel' : '') + (ds < t0 ? ' past' : '');
      h += '<button type="button" class="' + cls + '" data-cald="' + ds + '"><span class="mnum">' + Number(ds.slice(8)) + '</span>';
      if (list.length) {
        h += '<span class="mcnt">' + (late ? '<i class="late">' + late + '</i>' : '') + (bk ? '<i class="bk">' + bk + '</i>' : '') + (dn ? '<i class="dn">' + dn + '</i>' : '') + '</span>';
        h += '<span class="mnames">' + list.slice(0, 3).map(function (x) {
          return '<em class="' + (x.v.status === '已完成' ? 'dn' : (x.v.date < t0 ? 'late' : 'bk')) + '">' + esc(x.c.caseName) + (admin ? '．' + esc(x.v.teacherName) : '') + '</em>';
        }).join('') + (list.length > 3 ? '<em>…還有 ' + (list.length - 3) + ' 筆</em>' : '') + '</span>';
      }
      h += '</button>';
    }
    h += '</div><div class="mkey"><span><i class="bk"></i>已預約</span><span><i class="dn"></i>已完成</span><span><i class="late"></i>已過還沒回報</span></div>';
    var day = byDay[st.day] || [];
    h += '<div class="mlist"><h3>' + full(st.day) + (st.day === t0 ? ' 今天' : '') + '</h3>';
    if (!day.length) h += '<div class="empty">這天沒有服務</div>';
    day.forEach(function (x) {
      var v = x.v, c = x.c, past = v.status === '已預約' && v.date < t0;
      var tag = v.status === '已完成' ? '<span class="tag ok">已完成</span>' : (past ? '<span class="tag bad">未回報</span>' : '<span class="tag">已預約</span>');
      h += '<div class="vrow' + (v.status === '已完成' ? ' done' : '') + '"><span class="mcase"><b>' + esc(c.caseName) + '</b> <span class="muted small">' + esc(v.service) +
        (c.region ? '．' + esc(c.region) : '') + (admin ? '．' + esc(v.teacherName) : '') + '．' + visitNo(v) + '</span></span>' + tag + visitActs(v, admin) + '</div>';
    });
    return h + '</div>';
  }
  function visitList(c, admin) {
    var vs = visitsOf(c);
    if (!vs.length) return '';
    var n = 0;
    return '<div class="visits">' + vs.map(function (v) { if (v.kind !== '舊案') n++; return visitRow(v, n, admin); }).join('') + '</div>';
  }
  function remindNote(c) {
    var lv = remindLevel(c);
    if (!lv) return '';
    return '<div class="note ' + (lv === 2 ? 'bad' : 'warn') + '">最後一次服務是 ' + md(lastDoneOf(c)) + '，已經 ' + diff(lastDoneOf(c), today()) +
      ' 天沒有預約下一次服務' + (lv === 2 ? '' : '（' + settings().remindDays + ' 天會變紅色提醒）') + '</div>';
  }

  function caseHead(c, showTeacher) {
    var h = '<h3>' + esc(c.caseName) + (c.caseNo ? ' <span class="muted small">' + esc(c.caseNo) + '</span>' : '') +
      (c.legacy === 'Y' ? ' <span class="tag gray">舊案</span>' : '') + '</h3>';
    h += '<div class="meta">' + esc(c.service) + (c.region ? '．' + esc(c.region) : '') +
      (showTeacher ? '．老師：' + esc(c.teacherName) : '') + '</div>';
    var showDay = c.status === '待回覆' || c.status === '無法服務';
    h += '<div class="row">派案日 ' + full(c.dispatchDate) + (showDay ? '　<span class="muted small">今天是第 ' + elapsed(c) + ' 天</span>' : '') + '</div>';
    if (c.note) h += '<div class="note">備註：' + esc(c.note) + '</div>';
    return h;
  }

  // ===== 老師畫面 =====
  function renderTeacher() {
    var cs = S.data.cases;
    var groups = {
      '待回覆': cs.filter(function (c) { return c.status === '待回覆'; }),
      '待服務': cs.filter(function (c) { return c.status === '待服務'; }),
      '服務中': cs.filter(function (c) { return c.status === '服務中'; }),
      '已結束': cs.filter(function (c) { return c.status === '已結案' || c.status === '無法服務'; })
    };
    groups['待回覆'].sort(function (a, b) { return a.dispatchDate.localeCompare(b.dispatchDate); });
    groups['待服務'].sort(function (a, b) { return a.firstDate.localeCompare(b.firstDate); });
    // 服務中：需要處理的排前面，其餘按下一次服務日
    var nextOf = function (c) { var u = upcomingOf(c); return u.length ? u[0].date : '9999'; };
    var needs = function (c) { return remindLevel(c) * 10 + (overdueVisits(c).length ? 30 : 0); };
    groups['服務中'].sort(function (a, b) { return needs(b) - needs(a) || nextOf(a).localeCompare(nextOf(b)); });
    groups['已結束'].sort(function (a, b) { return (b.updatedAt || '').localeCompare(a.updatedAt || ''); });

    var h = '<div class="tabs">';
    Object.keys(groups).forEach(function (k) {
      var n = groups[k].length;
      if (k === '服務中') n = groups[k].filter(function (c) { return remindLevel(c) || overdueVisits(c).length; }).length;
      var alert = (k === '待回覆' || k === '服務中') && n > 0;
      if (k === '服務中' && !n) n = groups[k].length;
      h += '<button class="tab' + (S.tTab === k ? ' on' : '') + '" data-ttab="' + k + '">' + k + '<span class="n' + (alert ? ' alert' : '') + '">' + n + '</span></button>';
    });
    h += '</div>';
    h = h.replace(/<\/div>$/, '') + '<button class="tab' + (S.tTab === '行事曆' ? ' on' : '') + '" data-ttab="行事曆">行事曆</button></div>';
    if (S.tTab === '行事曆') { $app.innerHTML = h + calendarView(false); return; }
    var list = groups[S.tTab];
    if (!list.length) h += '<div class="empty">目前沒有' + S.tTab + '的派案</div>';
    list.forEach(function (c) { h += teacherCard(c); });
    $app.innerHTML = h;
  }

  function teacherCard(c) {
    var cls = '', h = '';
    var p = pendingOf(c);
    if (c.status === '待回覆') {
      var left = rules().max - elapsed(c);
      cls = elapsed(c) > rules().normal ? 'warn' : '';
      h += caseHead(c);
      if (left < 0) { cls = 'bad'; h += '<div class="note bad">已超過 ' + rules().max + ' 天，無法再選日期，請按「異常通報」說明原因。</div>'; }
      h += '<div class="acts">';
      if (left >= 0) h += '<button class="btn primary" data-a="reply" data-id="' + c.id + '">回覆首次服務日</button>';
      h += '<button class="btn danger" data-a="cannot" data-id="' + c.id + '">異常通報</button></div>';
    } else if (c.status === '待服務') {
      var od = overdueUnreported(c);
      cls = od ? 'bad' : (Number(c.day) > rules().normal ? 'warn' : 'ok');
      h += caseHead(c);
      h += '<div class="row"><b>首次服務日 ' + full(c.firstDate) + '</b> ' + dayTag(c.day) + '</div>';
      if (c.overReason) h += '<div class="note warn">' + overLabel() + '：' + esc(c.overReason) + '</div>';
      if (od) h += '<div class="note bad">服務日已過，請回報完成；若時間有變動請聯絡管理者。</div>';
      var rj = lastRejected(c);
      if (p) {
        h += '<div class="note">異動申請待審：改為 ' + full(p.newDate) + ' ' + dayTag(p.newDay) + '<br>原因：' + esc(p.reason) + '</div>';
        h += '<div class="acts"><button class="btn" data-a="cancelChange" data-id="' + c.id + '">撤回申請</button></div>';
      } else {
        if (rj) h += '<div class="note bad">上次異動申請（改為 ' + md(rj.newDate) + '）被駁回' + (rj.comment ? '：' + esc(rj.comment) : '') + '</div>';
        var can = c.firstDate <= today();
        h += '<div class="acts">' +
          '<button class="btn ok" data-a="complete" data-id="' + c.id + '"' + (can ? '' : ' disabled title="服務日當天之後才能回報"') + '>回報完成</button>' +
          '<button class="btn" data-a="change" data-id="' + c.id + '">申請改時間</button>' +
          '<button class="btn danger" data-a="cannot" data-id="' + c.id + '">異常通報</button>' +
          '<button class="btn danger" data-a="close" data-id="' + c.id + '">結案</button></div>';
      }
    } else if (c.status === '服務中') {
      var lv = remindLevel(c), odv = overdueVisits(c).length, up = upcomingOf(c).length, mx = settings().maxAhead;
      cls = odv || lv === 2 ? 'bad' : (lv === 1 ? 'warn' : 'ok');
      h += caseHead(c);
      h += visitList(c, false);
      if (odv) h += '<div class="note bad">有 ' + odv + ' 次服務日已過還沒回報，請按「完成」；沒去服務的話請改時間或取消。</div>';
      h += remindNote(c);
      h += '<div class="acts">' +
        '<button class="btn primary" data-a="book" data-id="' + c.id + '"' + (up >= mx ? ' disabled' : '') + '>預約下一次（已約 ' + up + '/' + mx + '）</button>' +
        '<button class="btn danger" data-a="close" data-id="' + c.id + '">結案</button></div>';
    } else {
      h += caseHead(c);
      if (c.status === '已結案') {
        h += visitList(c, false);
        h += '<div class="note">已結案：' + esc(c.closeReason) + '<br><span class="muted small">' + esc((c.closedAt || '').slice(0, 16)) + '</span></div>';
      } else h += '<div class="note">已異常通報：' + esc(c.cannotReason) + '<br><span class="muted small">已通報管理者處理</span></div>';
    }
    return '<div class="card ' + cls + '">' + h + '</div>';
  }

  // 日期選擇視窗（回覆與異動共用）
  function datePicker(c, mode) {
    var r = rules();
    var start = Math.max(0, elapsed(c));
    var opts = '';
    var fvx = mode === 'change' ? (firstVisitOf(S.data, c.id) || {}).id : '';
    for (var d = start; d <= r.max; d++) {
      var ds = addDays(c.dispatchDate, d);
      var cur = mode === 'change' && ds === c.firstDate;
      var why = cur ? '' : ruleCheck(c, ds, fvx);
      opts += '<button type="button" class="d ' + (d > r.normal ? 'over' : 'normal') + (cur ? ' cur' : '') + (why ? ' blk' : '') + '" data-date="' + ds + '" data-day="' + d + '"' +
        (why ? ' data-why="' + esc(why) + '"' : '') + (cur ? ' disabled' : '') + '>' +
        '<b>' + md(ds).replace(/（.）/, '') + '</b><span>週' + WK[new Date(ymd(ds)).getUTCDay()] + '．第' + d + '天</span></button>';
    }
    var title = mode === 'change' ? '申請改首次服務日' : '回覆首次服務日';
    var h = '<h2>' + title + '</h2><div class="muted small">' + esc(c.caseName) + '．派案日 ' + full(c.dispatchDate) + '（第 0 天）</div>';
    if (mode === 'change') h += '<div class="small" style="margin-top:6px">目前：' + full(c.firstDate) + '（第 ' + c.day + ' 天），需管理者核准才會生效。</div>';
    h += '<div class="legend"><span><i style="background:#2f7d4f"></i>' + r.normal + ' 天內（正常）</span><span><i style="background:#b66a12"></i>第 ' + (r.normal + 1) + '～' + r.max + ' 天（需填原因）</span></div>';
    h += '<div class="dates" id="dates">' + opts + '</div>';
    h += '<div id="whyBox" class="note bad hidden"></div>';
    h += '<div id="overBox" class="alertbox hidden">這個日期超過 ' + r.normal + ' 天，會列入異常通報，請選擇原因。</div>';
    // 超過 7 天：常用原因單選，選「其他」才自己填
    var reasons = overReasons();
    h += '<div id="overWrap" class="hidden"><div class="qlabel">超過 ' + r.normal + ' 天的原因（必選）</div><div class="choices" id="choices">' +
      reasons.concat(['其他']).map(function (t, i) {
        return '<label class="choice"><input type="radio" name="ovr" value="' + esc(t) + '"' + (t === '其他' ? ' data-other="1"' : '') + '><span>' + esc(t) + '</span></label>';
      }).join('') + '</div>' +
      '<div id="otherWrap" class="hidden"><textarea id="reasonOther" placeholder="請寫下原因"></textarea></div></div>';
    // 改時間但仍在 7 天內：自由填寫異動原因
    h += '<div id="plainWrap" class="' + (mode === 'change' ? '' : 'hidden') + '"><label for="reason">異動原因（必填）</label>' +
      '<textarea id="reason" placeholder="例如：家屬要求改時間"></textarea></div>';
    h += '<div class="foot"><button class="btn" data-close>取消</button><button class="btn primary" id="send" disabled>送出</button></div>';
    openModal(h);

    var picked = null;
    var overWrap = document.getElementById('overWrap'), plainWrap = document.getElementById('plainWrap'),
      otherWrap = document.getElementById('otherWrap'), other = document.getElementById('reasonOther'),
      overBox = document.getElementById('overBox'), reason = document.getElementById('reason'), send = document.getElementById('send');
    function chosen() {
      var x = document.querySelector('input[name=ovr]:checked');
      if (!x) return '';
      return x.getAttribute('data-other') ? other.value.trim() : x.value;
    }
    function reasonText() {
      if (!picked) return '';
      if (picked.day > r.normal) return chosen();
      return mode === 'change' ? reason.value.trim() : '';
    }
    function check() {
      var need = picked && (mode === 'change' || picked.day > r.normal);
      send.disabled = !picked || (need && !reasonText());
    }
    document.getElementById('choices').addEventListener('change', function () {
      var x = document.querySelector('input[name=ovr]:checked');
      var isOther = !!(x && x.getAttribute('data-other'));
      otherWrap.classList.toggle('hidden', !isOther);
      if (isOther) other.focus();
      check();
    });
    other.addEventListener('input', check);
    document.getElementById('dates').addEventListener('click', function (e) {
      var b = e.target.closest('.d'); if (!b || b.disabled) return;
      var wb = document.getElementById('whyBox');
      if (b.getAttribute('data-why')) { wb.textContent = '這天不能選：' + b.getAttribute('data-why'); wb.classList.remove('hidden'); return; }
      wb.classList.add('hidden');
      Array.prototype.forEach.call(this.querySelectorAll('.d'), function (x) { x.classList.remove('sel'); });
      b.classList.add('sel');
      picked = { date: b.getAttribute('data-date'), day: Number(b.getAttribute('data-day')) };
      var over = picked.day > r.normal;
      overBox.classList.toggle('hidden', !over);
      overWrap.classList.toggle('hidden', !over);
      plainWrap.classList.toggle('hidden', over || mode !== 'change');
      check();
    });
    reason.addEventListener('input', check);
    send.onclick = function () {
      var payload = { caseId: c.id, date: picked.date, reason: reasonText() };
      if (mode === 'change') act('requestChange', payload, '已送出異動申請，等待管理者核准', true);
      else act('reply', payload, '已回覆首次服務日', true);
    };
  }

  // ===== 後續服務：預約／改時間的月曆 =====
  function bookPicker(c, v) {
    var r = rules(), st = settings(), t0 = today(), end = addDays(t0, r.range || 120);
    var month = (v ? v.date : t0).slice(0, 7), picked = null;
    var mine = {}, others = {};
    liveVisits().forEach(function (x) {
      if (x.clientId !== c.clientId || x.service !== c.service || (v && x.id === v.id)) return;
      if (x.caseId === c.id) mine[x.date] = 1; else others[x.date] = x.teacherName;
    });
    function monthAdd(m, n) { var y = +m.slice(0, 4), mo = +m.slice(5) - 1 + n; y += Math.floor(mo / 12); mo = ((mo % 12) + 12) % 12; return y + '-' + ('0' + (mo + 1)).slice(-2); }
    function grid() {
      var first = month + '-01', wd = new Date(ymd(first)).getUTCDay();
      var h = '<div class="calhead"><button type="button" class="btn sm" data-mv="-1"' + (month <= t0.slice(0, 7) ? ' disabled' : '') + '>‹</button>' +
        '<b>' + month.slice(0, 4) + ' 年 ' + Number(month.slice(5)) + ' 月</b>' +
        '<button type="button" class="btn sm" data-mv="1"' + (month >= end.slice(0, 7) ? ' disabled' : '') + '>›</button></div>';
      h += '<div class="cal">' + WK.map(function (w) { return '<div class="cw">' + w + '</div>'; }).join('');
      for (var i = 0; i < wd; i++) h += '<div></div>';
      for (var ds = first; ds.slice(0, 7) === month; ds = addDays(ds, 1)) {
        var out = ds < t0 || ds > end;
        var why = out ? '' : ruleCheck(c, ds, v ? v.id : '');
        var cls = 'cd' + (out ? ' out' : (why ? ' blk' : '')) + (mine[ds] ? ' mine' : '') + (others[ds] ? ' other' : '') + (picked === ds ? ' sel' : '') + (ds === t0 ? ' today' : '');
        h += '<button type="button" class="' + cls + '" data-date="' + ds + '"' + (why ? ' data-why="' + esc(why) + '"' : '') + (out ? ' disabled' : '') + '>' +
          Number(ds.slice(8)) + (mine[ds] ? '<i>●</i>' : (others[ds] ? '<i>' + esc(others[ds].slice(0, 1)) + '</i>' : '')) + '</button>';
      }
      return h + '</div>';
    }
    openModal('<h2>' + (v ? '改服務時間' : '預約下一次服務') + '</h2><div class="muted small">' + esc(c.caseName) + '．' + esc(c.service) +
      (v ? '．原本 ' + full(v.date) : '') + '</div>' +
      '<div class="small" style="margin:8px 0">同一服務碼別要間隔 ' + st.gapDays + ' 天以上、每月最多 ' + st.monthCap + ' 次（所有老師一起算）。灰色日期不能選，點一下可以看原因。</div>' +
      '<div class="calkey"><span><i class="k mine">●</i>這個個案已排的服務</span><span><i class="k other">姓</i>其他老師的預約（標老師的姓）</span></div>' +
      '<div id="calbox">' + grid() + '</div><div id="whyBox" class="note bad hidden"></div>' +
      '<div class="foot"><button class="btn" data-close>取消</button><button class="btn primary" id="bkOk" disabled>請選日期</button></div>');
    var box = document.getElementById('calbox'), wb = document.getElementById('whyBox'), ok = document.getElementById('bkOk');
    box.addEventListener('click', function (e) {
      var mv = e.target.closest('[data-mv]');
      if (mv) { if (!mv.disabled) { month = monthAdd(month, Number(mv.getAttribute('data-mv'))); box.innerHTML = grid(); } return; }
      var b = e.target.closest('.cd'); if (!b || b.disabled) return;
      if (b.getAttribute('data-why')) { wb.textContent = '這天不能選：' + b.getAttribute('data-why'); wb.classList.remove('hidden'); return; }
      wb.classList.add('hidden');
      picked = b.getAttribute('data-date'); box.innerHTML = grid();
      ok.disabled = false; ok.textContent = (v ? '改到 ' : '預約 ') + md(picked);
    });
    ok.onclick = function () {
      if (v) act('moveVisit', { visitId: v.id, date: picked }, '已改到 ' + md(picked), true);
      else act('bookVisit', { caseId: c.id, date: picked }, '已預約 ' + md(picked), true);
    };
  }

  // ===== 單選原因（最後一個「其他」自己填） =====
  function abnormalReasons() {
    var o = S.data.options && S.data.options['異常通報原因'];
    return o && o.length ? o : ['家屬無法配合時間', '家屬不想參加'];
  }
  function choiceDialog(o, onOk) {
    openModal('<h2>' + o.title + '</h2><div class="muted small">' + o.sub + '</div>' +
      '<div class="qlabel">' + o.label + '</div><div class="choices" id="xchoices">' +
      o.items.concat([o.other]).map(function (t) {
        return '<label class="choice"><input type="radio" name="xr" value="' + esc(t) + '"' + (t === o.other ? ' data-other="1"' : '') + '><span>' + esc(t) + '</span></label>';
      }).join('') + '</div><div id="xOtherWrap" class="hidden"><textarea id="xOther" placeholder="請寫下原因"></textarea></div>' +
      (o.extra || '') +
      '<div class="foot"><button class="btn" data-close>取消</button><button class="btn danger" id="xOk" disabled>' + o.ok + '</button></div>');
    var okb = document.getElementById('xOk'), other = document.getElementById('xOther'), ow = document.getElementById('xOtherWrap');
    function val() {
      var x = document.querySelector('input[name=xr]:checked');
      if (!x) return '';
      return x.getAttribute('data-other') ? (other.value.trim() ? o.other + '：' + other.value.trim() : '') : x.value;
    }
    document.getElementById('xchoices').addEventListener('change', function () {
      var x = document.querySelector('input[name=xr]:checked');
      ow.classList.toggle('hidden', !(x && x.getAttribute('data-other')));
      if (x && x.getAttribute('data-other')) other.focus();
      okb.disabled = !val();
    });
    other.addEventListener('input', function () { okb.disabled = !val(); });
    okb.onclick = function () { onOk(val()); };
  }

  // ===== 結案 =====
  function closeDialog(c) {
    var n = upcomingOf(c).length;
    openModal('<h2>結案</h2><div class="muted small">' + esc(c.caseName) + '．' + esc(c.service) + '</div>' +
      '<div class="qlabel">結案原因（必選）</div><div class="choices" id="cchoices">' +
      closeReasons().concat(['其它']).map(function (t) {
        return '<label class="choice"><input type="radio" name="cr" value="' + esc(t) + '"' + (t === '其它' ? ' data-other="1"' : '') + '><span>' + esc(t) + '</span></label>';
      }).join('') + '</div><div id="cOtherWrap" class="hidden"><textarea id="cOther" placeholder="請寫下結案原因"></textarea></div>' +
      (n ? '<div class="alertbox">結案後，已預約的 ' + n + ' 次服務會自動取消。</div>' : '') +
      '<div class="note" style="margin-top:12px">結案後，請記得到' + esc(settings().closeSystem) + '登打結案資料。</div>' +
      '<div class="foot"><button class="btn" data-close>取消</button><button class="btn danger" id="cOk" disabled>確定結案</button></div>');
    var okb = document.getElementById('cOk'), other = document.getElementById('cOther'), ow = document.getElementById('cOtherWrap');
    function val() {
      var x = document.querySelector('input[name=cr]:checked');
      if (!x) return '';
      return x.getAttribute('data-other') ? (other.value.trim() ? '其它：' + other.value.trim() : '') : x.value;
    }
    document.getElementById('cchoices').addEventListener('change', function () {
      var x = document.querySelector('input[name=cr]:checked');
      ow.classList.toggle('hidden', !(x && x.getAttribute('data-other')));
      okb.disabled = !val();
    });
    other.addEventListener('input', function () { okb.disabled = !val(); });
    okb.onclick = function () {
      act('closeCase', { caseId: c.id, reason: val() }, null, true);
      openModal('<h2>已結案</h2><p>「' + esc(c.caseName) + '」' + esc(c.service) + ' 已結案。</p>' +
        '<div class="alertbox">請記得到<b>' + esc(settings().closeSystem) + '</b>登打結案資料。</div>' +
        '<div class="foot"><button class="btn primary" data-close>我知道了</button></div>');
    };
  }

  var DEFAULT_OVER_REASONS = ['配合家屬可約時間', '家屬指定服務日期', '近期個案數較多，7日內無法安排服務'];
  function overReasons() {
    var o = S.data.options && S.data.options['超過7天原因'];
    return o && o.length ? o : DEFAULT_OVER_REASONS;
  }

  function reasonDialog(title, hint, label, onOk, danger) {
    openModal('<h2>' + title + '</h2>' + (hint ? '<div class="muted small">' + hint + '</div>' : '') +
      '<label for="rs">' + label + '</label><textarea id="rs"></textarea>' +
      '<div class="foot"><button class="btn" data-close>取消</button><button class="btn ' + (danger ? 'danger' : 'primary') + '" id="rsOk" disabled>確定</button></div>');
    var rs = document.getElementById('rs'), okb = document.getElementById('rsOk');
    rs.focus();
    rs.oninput = function () { okb.disabled = !rs.value.trim(); };
    okb.onclick = function () { onOk(rs.value.trim()); };
  }

  function findCase(id) { return S.data.cases.filter(function (c) { return c.id === id; })[0]; }

  // ===== 管理者畫面 =====
  function adminGroups() {
    var cs = S.data.cases;
    var pend = {};
    S.data.changes.forEach(function (h) { if (h.status === '待審') pend[h.caseId] = h; });
    return {
      '待回覆': cs.filter(function (c) { return c.status === '待回覆'; }),
      '待服務': cs.filter(function (c) { return c.status === '待服務'; }),
      '服務中': cs.filter(function (c) { return c.status === '服務中'; }),
      '未約提醒': cs.filter(function (c) { return remindLevel(c) > 0; }),
      '異動待審': cs.filter(function (c) { return pend[c.id]; }),
      '異常通報': cs.filter(function (c) { return inReport(c) || c.status === '無法服務' || failedCase(c); }),
      '逾期未回報': cs.filter(overdueUnreported),
      '已結案': cs.filter(function (c) { return c.status === '已結案'; }),
      '全部': cs.slice()
    };
  }

  function renderAdmin() {
    var navs = ['派案', '行事曆', '建立派案', '個案', '帳號', '選項'];
    var h = '<div class="nav">';
    navs.forEach(function (n) { h += '<button data-nav="' + n + '" class="' + (S.nav === n ? 'on' : '') + '">' + n + '</button>'; });
    h += '</div>';
    if (S.nav === '派案') h += adminCases();
    else if (S.nav === '建立派案') h += caseForm(null);
    else if (S.nav === '個案') h += clientsView();
    else if (S.nav === '行事曆') h += calendarView(true);
    else if (S.nav === '帳號') h += usersView();
    else h += optionsView();
    $app.innerHTML = h;
    if (S.nav === '建立派案') bindCaseForm(null);
    if (S.nav === '個案') {
      var cq = document.getElementById('cq');
      if (cq) cq.oninput = function () { S.cq = cq.value; var pos = cq.selectionStart; renderAdmin(); var c2 = document.getElementById('cq'); c2.focus(); c2.setSelectionRange(pos, pos); };
    }
    // 打開「已結案」時，把未讀的標成已讀（這次瀏覽仍顯示「新」）
    if (S.nav === '派案' && S.filter === '已結案') {
      var unseen = S.data.cases.filter(function (c) { return c.status === '已結案' && c.closeSeen !== 'Y'; }).map(function (c) { return c.id; });
      if (unseen.length) {
        S.fresh = S.fresh || {}; unseen.forEach(function (id) { S.fresh[id] = 1; });
        var ids = unseen.filter(function (id) { return id.indexOf('tmp-') !== 0; });
        if (ids.length) setTimeout(function () { act('seeClosed', { caseIds: ids }, null, true); }, 0);
      }
    }
    if (S.nav === '派案') {
      var q = document.getElementById('q');
      if (q) q.oninput = function () { S.q = q.value; var pos = q.selectionStart; renderAdmin(); var q2 = document.getElementById('q'); q2.focus(); q2.setSelectionRange(pos, pos); };
    }
  }

  function adminCases() {
    var g = adminGroups();
    var alertTabs = { '待回覆': 1, '異動待審': 1, '異常通報': 1, '逾期未回報': 1, '未約提醒': 1, '已結案': 1 };
    var h = '<div class="tabs">';
    Object.keys(g).forEach(function (k) {
      var n = k === '異常通報' ? g[k].filter(abnormalPending).length :
        (k === '已結案' ? g[k].filter(function (c) { return c.closeSeen !== 'Y'; }).length : g[k].length);
      var al = alertTabs[k] && n > 0;
      h += '<button class="tab' + (S.filter === k ? ' on' : '') + '" data-filter="' + k + '">' + k +
        (k === '全部' || k === '待服務' || (k === '已結案' && !n) ? '' : '<span class="n' + (al ? ' alert' : '') + '">' + n + '</span>') + '</button>';
    });
    h += '</div>';
    h += '<input id="q" class="search" type="text" placeholder="搜尋個案姓名、編號、老師" value="' + esc(S.q) + '">';
    var list = g[S.filter];
    var q = S.q.trim();
    if (q) list = list.filter(function (c) { return [c.caseName, c.caseNo, c.clientId, c.teacherName, c.service, c.region].join(' ').indexOf(q) >= 0; });

    var sorters = {
      '待回覆': function (a, b) { return a.dispatchDate.localeCompare(b.dispatchDate); },
      '待服務': function (a, b) { return a.firstDate.localeCompare(b.firstDate); },
      '逾期未回報': function (a, b) { return a.firstDate.localeCompare(b.firstDate); },
      '未約提醒': function (a, b) { return lastDoneOf(a).localeCompare(lastDoneOf(b)); },
      '已結案': function (a, b) { return (b.closedAt || '').localeCompare(a.closedAt || ''); },
      '異常通報': function (a, b) { return abnormalPending(b) - abnormalPending(a) || (b.updatedAt || '').localeCompare(a.updatedAt || ''); }
    };
    list.sort(sorters[S.filter] || function (a, b) { return (b.updatedAt || '').localeCompare(a.updatedAt || ''); });

    if (S.filter === '異常通報') h += '<div class="muted small" style="margin-bottom:8px">兩種需要處理的派案：<b>逾 ' + rules().normal + ' 天</b>（首次服務落在第 ' + (rules().normal + 1) + '～' + rules().max +
      ' 天，完成通報後打勾）；<b>個案無法服務</b>（先協調，協調成功就改派，協調不成就通報後取消）。紅色數字是還沒處理完的筆數。</div>';
    if (!list.length) h += '<div class="empty">沒有資料</div>';
    list.forEach(function (c) { h += adminCard(c); });
    return h;
  }

  function adminCard(c) {
    var cls = '', h = caseHead(c, true);
    var p = pendingOf(c);
    var st = '<span class="tag ' + ({ '待回覆': 'warn', '待服務': '', '服務中': 'ok', '已結案': 'gray', '無法服務': 'bad', '已取消': 'gray' }[c.status] || '') + '">' + (c.status === '無法服務' ? '個案無法服務' : c.status) + '</span>' +
      (c.status === '已結案' && (c.closeSeen !== 'Y' || (S.fresh && S.fresh[c.id])) ? ' <span class="tag bad">新</span>' : '');
    if (inReport(c)) st += ' <span class="tag warn">逾 ' + rules().normal + ' 天</span>';
    if (failedCase(c)) st += ' <span class="tag bad">協調不成</span>';
    h = h.replace('</h3>', ' ' + st + (Number(c.reassignCount) > 0 ? ' <span class="tag gray">改派 ' + c.reassignCount + ' 次</span>' : '') + '</h3>');
    var acts = [];

    if (c.status === '待回覆') {
      var e = elapsed(c);
      if (e > rules().max) { cls = 'bad'; h += '<div class="note bad">已過 ' + rules().max + ' 天仍未回覆</div>'; }
      else if (e > rules().normal) { cls = 'warn'; h += '<div class="note warn">已過 ' + rules().normal + ' 天仍未回覆</div>'; }
      acts.push('reassign', 'edit', 'cancel');
      if (e > rules().normal) acts.push('toLegacy');
    } else if (c.status === '服務中' || c.status === '已結案') {
      var odv = overdueVisits(c).length, lv = remindLevel(c);
      cls = odv || lv === 2 ? 'bad' : (lv === 1 ? 'warn' : (c.status === '服務中' ? 'ok' : ''));
      h += visitList(c, true);
      if (odv) h += '<div class="note bad">有 ' + odv + ' 次服務日已過，老師還沒回報完成</div>';
      h += remindNote(c);
      if (c.status === '已結案') h += '<div class="note">結案原因：' + esc(c.closeReason) + '<br><span class="muted small">' + esc(c.closedBy) + '．' + esc((c.closedAt || '').slice(0, 16)) + '</span></div>';
      else acts.push('edit', 'cancel');
      if (inReport(c)) {
        h += '<div class="row"><label class="check"><input type="checkbox" data-a="notify" data-id="' + c.id + '"' + (c.notified === 'Y' ? ' checked' : '') + '> 已完成通報（首次服務第 ' + c.day + ' 天）</label></div>';
        acts.push('copy');
      }
    } else if (c.status === '待服務') {
      var od = overdueUnreported(c);
      cls = od ? 'bad' : (Number(c.day) > rules().normal ? 'warn' : '');
      h += '<div class="row"><b>首次服務日 ' + full(c.firstDate) + '</b> ' + dayTag(c.day) + '</div>';
      if (c.overReason) h += '<div class="note warn">' + overLabel() + '：' + esc(c.overReason) + '</div>';
      if (od) h += '<div class="note bad">服務日已過，老師尚未回報完成</div>';
      if (c.status === '待服務') {
        if (p) {
          h += '<div class="note"><b>異動申請</b>　' + full(p.oldDate) + ' ' + dayTag(p.oldDay) + ' → ' + full(p.newDate) + ' ' + dayTag(p.newDay) +
            '<br>原因：' + esc(p.reason) + '<br><span class="muted small">申請時間 ' + esc(p.requestedAt) + '</span></div>';
          acts.push('approve', 'reject');
        } else if (c.firstDate <= today()) acts.push('complete');
        acts.push('reassign', 'edit', 'cancel');
      }
      if (inReport(c)) {
        h += '<div class="row"><label class="check"><input type="checkbox" data-a="notify" data-id="' + c.id + '"' + (c.notified === 'Y' ? ' checked' : '') + '> 已完成通報' +
          (c.notified === 'Y' ? ' <span class="muted small">（' + esc(c.notifiedBy) + ' ' + esc(c.notifiedAt.slice(0, 16)) + '）</span>' : '') + '</label></div>';
        acts.push('copy');
      }
    } else if (c.status === '無法服務') {
      cls = 'bad';
      h += '<div class="note bad">老師異常通報：' + esc(c.cannotReason) + '<br><span class="muted small">' + esc(c.cannotAt) + '</span></div>' +
        '<div class="muted small" style="margin-top:6px">請先和家屬、老師協調。協調成功就改派（可以派回原老師）；協調不成，完成通報後取消。</div>';
      acts.push('okReassign', 'failCancel', 'copyAb', 'edit');
    } else if (c.status === '已取消') {
      if (failedCase(c)) h += '<div class="note">老師異常通報：' + esc(c.cannotReason) + '</div>';
      h += '<div class="note">取消原因：' + esc(c.cancelReason) +
        (failedCase(c) ? '<br><span class="muted small">已通報（' + esc(c.notifiedBy) + ' ' + esc((c.notifiedAt || '').slice(0, 16)) + '）</span>' : '') + '</div>';
    }

    var labels = {
      approve: ['primary', '核准'], reject: ['danger', '駁回'], complete: ['ok', '代為回報完成'],
      reassign: ['', '改派'], edit: ['', '修改'], cancel: ['danger', '取消派案'], copy: ['', '複製通報資料'],
      okReassign: ['primary', '協調成功：改派'], toLegacy: ['', '轉為舊案'], failCancel: ['danger', '協調不成：通報並取消'], copyAb: ['', '複製通報資料']
    };
    if (acts.length) {
      h += '<div class="acts">' + acts.map(function (a) {
        return '<button class="btn sm ' + labels[a][0] + '" data-a="' + a + '" data-id="' + c.id + '">' + labels[a][1] + '</button>';
      }).join('') + '</div>';
    }
    return '<div class="card ' + cls + '">' + h + '</div>';
  }

  function teachers() { return S.data.users.filter(function (u) { return u.role === '老師' && u.active; }); }
  function selectHtml(id, list, val, placeholder) {
    var h = '<select id="' + id + '"><option value="">' + placeholder + '</option>';
    list.forEach(function (o) {
      var v = typeof o === 'string' ? o : o.value, t = typeof o === 'string' ? o : o.text;
      h += '<option value="' + esc(v) + '"' + (v === val ? ' selected' : '') + '>' + esc(t) + '</option>';
    });
    return h + '</select>';
  }

  function clientLabel(cl) { return cl.id + '　' + cl.name + (cl.careNo ? '（' + cl.careNo + '）' : ''); }
  function clientOptions(q, sel) {
    q = (q || '').trim();
    var list = (S.data.clients || []).filter(function (cl) { return !q || clientLabel(cl).indexOf(q) >= 0 || cl.id === sel; });
    list.sort(function (a, b) { return b.id.localeCompare(a.id); });
    return '<option value="">' + (list.length ? '請選擇個案（' + list.length + ' 筆）' : '找不到，請按「新增個案」') + '</option>' +
      list.map(function (cl) { return '<option value="' + esc(cl.id) + '"' + (cl.id === sel ? ' selected' : '') + '>' + esc(clientLabel(cl)) + '</option>'; }).join('');
  }
  function caseForm(c) {
    var o = S.data.options;
    var dr = (!c && S.caseDraft) || {};
    var src = c || dr;
    var tlist = teachers().map(function (t) { return { value: t.id, text: t.name }; });
    var lock = c && c.status !== '待回覆';
    var h = '<div class="form">' + (c ? '<h2>修改派案</h2>' : '') +
      '<label for="fCq">個案（必選）</label><div class="pick"><input id="fCq" type="text" placeholder="輸入姓名、代碼或照管編號搜尋"' + (lock ? ' disabled' : '') + '>' +
      (lock ? '' : '<button type="button" class="btn" data-a="newClient">新增個案</button>') + '</div>' +
      '<select id="fClient"' + (lock ? ' disabled' : '') + '>' + clientOptions('', src.clientId) + '</select>' +
      (lock ? '<div class="muted small">老師回覆後，不能更換個案和服務碼別</div>' : '') +
      '<div class="grid2">' +
      '<div><label for="fSvc">服務碼別（必填）</label>' + selectHtml('fSvc', o['服務碼別'] || [], src.service || '', '請選擇').replace('<select', lock ? '<select disabled' : '<select') + '</div>' +
      '<div><label for="fReg">區域</label>' + selectHtml('fReg', o['區域'] || [], src.region || '', '依個案資料') + '</div>' +
      '<div><label for="fDate">派案日期（必填）</label><input id="fDate" type="date" max="' + today() + '" value="' + (src.dispatchDate || today()) + '"' + (lock ? ' disabled' : '') + '></div>';
    if (!c) h += '<div><label for="fT">指派老師（必填）</label>' + selectHtml('fT', tlist, dr.teacherId || '', tlist.length ? '請選擇' : '尚無老師帳號') + '</div>';
    h += '</div>';
    if (!c) {
      h += '<label class="check" style="margin-top:12px"><input type="checkbox" id="fLegacy"' + (dr.legacy ? ' checked' : '') + '> 舊案帶入（已經在服務中的個案）</label>' +
        '<div id="fLegacyBox"' + (dr.legacy ? '' : ' class="hidden"') + '><div class="muted small">舊案直接進「服務中」，不用老師回覆第一次服務，也不看第一次服務的天數規定。老師之後用「預約下一次」排服務。</div>' +
        '<label for="fLast">上次服務日（必填）</label><input id="fLast" type="date" max="' + today() + '" value="' + esc(dr.lastDate || '') + '"></div>';
    }
    h += '<label for="fNote">備註</label><textarea id="fNote">' + esc(src.note || '') + '</textarea>';
    if (c) h += '<div class="foot"><button class="btn" data-close>取消</button><button class="btn primary" id="fSave">儲存</button></div>';
    else h += '<button class="btn primary block" id="fSave">建立派案</button>';
    return h + '</div>';
  }

  function caseFormValues() {
    var v = function (id) { var el = document.getElementById(id); return el ? el.value.trim() : ''; };
    var lg = document.getElementById('fLegacy');
    return { clientId: v('fClient'), service: v('fSvc'), region: v('fReg'), dispatchDate: v('fDate'), note: v('fNote'), teacherId: v('fT'),
      legacy: !!(lg && lg.checked), lastDate: v('fLast') };
  }
  function bindCaseForm(c) {
    var cq = document.getElementById('fCq'), sel = document.getElementById('fClient');
    if (cq) cq.oninput = function () { sel.innerHTML = clientOptions(cq.value, sel.value); };
    var lg = document.getElementById('fLegacy');
    if (lg) lg.onchange = function () {
      document.getElementById('fLegacyBox').classList.toggle('hidden', !lg.checked);
      document.getElementById('fSave').textContent = lg.checked ? '帶入舊案' : '建立派案';
    };
    if (lg && lg.checked) document.getElementById('fSave').textContent = '帶入舊案';
    document.getElementById('fSave').onclick = function () {
      var fields = caseFormValues();
      if (!fields.clientId) return toast('請選擇個案；找不到請按「新增個案」', true);
      if (!fields.service) return toast('請選擇服務碼別', true);
      if (c) {
        delete fields.teacherId;
        if (c.status !== '待回覆') { delete fields.dispatchDate; delete fields.clientId; delete fields.service; }
        act('updateCase', { caseId: c.id, fields: fields }, '已儲存', true);
      } else {
        if (!fields.teacherId) return toast('請選擇指派老師', true);
        if (fields.legacy) {
          if (!fields.lastDate) return toast('請填寫上次服務日', true);
          if (fields.lastDate > today()) return toast('上次服務日不能是未來的日期', true);
          if (fields.lastDate < fields.dispatchDate) return toast('上次服務日不能早於派案日期', true);
        } else { delete fields.legacy; delete fields.lastDate; }
        S.caseDraft = null;
        S.nav = '派案'; S.filter = fields.legacy ? '服務中' : '待回覆';
        act('createCase', { fields: fields }, fields.legacy ? '已帶入舊案' : '已建立派案', true);
      }
    };
  }

  // ===== 個案 =====
  function nextClientId() {
    var max = 0;
    (S.data.clients || []).forEach(function (cl) { var n = Number(String(cl.id).replace(/\D/g, '')); if (n > max) max = n; });
    return 'P' + ('000' + (max + 1)).slice(-4);
  }
  function clientModal(cl, fromCaseForm) {
    var o = S.data.options;
    openModal('<h2>' + (cl ? '修改個案 ' + esc(cl.id) : '新增個案') + '</h2>' +
      (cl ? '' : '<div class="muted small">個案代碼由系統編號：' + nextClientId() + '</div>') +
      '<label for="kName">姓名（必填）</label><input id="kName" type="text" value="' + esc(cl ? cl.name : '') + '">' +
      '<label for="kNo">照管編號（選填）</label><input id="kNo" type="text" value="' + esc(cl ? cl.careNo : '') + '">' +
      '<label for="kReg">區域</label>' + selectHtml('kReg', o['區域'] || [], cl ? cl.region : '', '請選擇') +
      '<label for="kNote">備註</label><textarea id="kNote">' + esc(cl ? cl.note : '') + '</textarea>' +
      '<div class="foot"><button class="btn" data-close>取消</button><button class="btn primary" id="kOk">儲存</button></div>');
    document.getElementById('kOk').onclick = function () {
      var f = { name: document.getElementById('kName').value.trim(), careNo: document.getElementById('kNo').value.trim(),
        region: document.getElementById('kReg').value, note: document.getElementById('kNote').value.trim() };
      if (!f.name) return toast('請填寫個案姓名', true);
      var dup = (S.data.clients || []).filter(function (x) { return f.careNo && x.careNo === f.careNo && (!cl || x.id !== cl.id); })[0];
      if (dup) return toast('照管編號 ' + f.careNo + ' 已經是 ' + dup.id + ' ' + dup.name, true);
      if (cl) { f.id = cl.id; act('updateClient', f, '已儲存個案', true); return; }
      f.id = nextClientId();
      if (fromCaseForm) { S.caseDraft = caseFormValues(); S.caseDraft.clientId = f.id; }
      act('createClient', f, '已新增個案 ' + f.id, true);
    };
  }
  function clientsView() {
    var q = (S.cq || '').trim();
    var list = (S.data.clients || []).filter(function (cl) { return !q || [cl.id, cl.name, cl.careNo, cl.region].join(' ').indexOf(q) >= 0; });
    list.sort(function (a, b) { return b.id.localeCompare(a.id); });
    var count = {};
    S.data.cases.forEach(function (c) {
      if (!c.clientId) return;
      count[c.clientId] = count[c.clientId] || { open: 0, all: 0 };
      count[c.clientId].all++;
      if (['待回覆', '待服務', '服務中'].indexOf(c.status) >= 0) count[c.clientId].open++;
    });
    var h = '<div class="acts" style="margin:0 0 10px"><button class="btn primary" data-a="newClient2">新增個案</button></div>' +
      '<input id="cq" class="search" type="text" placeholder="搜尋代碼、姓名、照管編號、區域" value="' + esc(S.cq || '') + '">';
    if (!list.length) return h + '<div class="empty">沒有個案資料</div>';
    h += '<div class="scroll"><table class="list"><thead><tr><th>代碼</th><th>姓名</th><th>照管編號</th><th>區域</th><th>進行中／全部派案</th><th></th></tr></thead><tbody>';
    list.forEach(function (cl) {
      var n = count[cl.id] || { open: 0, all: 0 };
      h += '<tr><td>' + esc(cl.id) + '</td><td>' + esc(cl.name) + '</td><td>' + esc(cl.careNo) + '</td><td>' + esc(cl.region) + '</td>' +
        '<td>' + n.open + '／' + n.all + '</td><td style="text-align:right"><button class="btn sm" data-a="editClient" data-cid="' + esc(cl.id) + '">修改</button></td></tr>';
    });
    return h + '</tbody></table></div>';
  }

  function usersView() {
    var us = S.data.users.slice().sort(function (a, b) { return (b.active - a.active) || a.role.localeCompare(b.role) || a.name.localeCompare(b.name); });
    var h = '<div class="form" style="margin-bottom:12px"><b>新增帳號</b><div class="grid2">' +
      '<div><label for="uName">姓名</label><input id="uName" type="text"></div>' +
      '<div><label for="uPhone">手機</label><input id="uPhone" type="tel" inputmode="numeric" placeholder="09xxxxxxxx"></div>' +
      '<div><label for="uRole">角色</label>' + selectHtml('uRole', ['老師', '管理者'], '老師', '請選擇') + '</div>' +
      '</div><button class="btn primary block" data-a="addUser">新增並產生 PIN</button></div>';
    h += '<table class="list"><thead><tr><th>姓名</th><th>手機</th><th>角色</th><th></th></tr></thead><tbody>';
    us.forEach(function (u) {
      h += '<tr' + (u.active ? '' : ' class="muted"') + '><td>' + esc(u.name) +
        (u.active ? '' : ' <span class="tag gray">停用</span>') + (u.locked ? ' <span class="tag bad">鎖定</span>' : '') + '</td>' +
        '<td>' + esc(u.phone) + '</td><td>' + esc(u.role) + '</td>' +
        '<td style="text-align:right;white-space:nowrap"><button class="btn sm" data-a="editUser" data-id="' + u.id + '">修改</button> ' +
        '<button class="btn sm" data-a="resetPin" data-id="' + u.id + '">重設 PIN</button></td></tr>';
    });
    return h + '</tbody></table><p class="muted small">重設 PIN 後，這個人原本登入的手機會被登出，要用新 PIN 重新登入。PIN 連續錯誤 5 次會鎖定 15 分鐘，重設 PIN 可立即解鎖。</p>';
  }

  function showPin(name, pin) {
    openModal('<h2>' + esc(name) + ' 的 PIN</h2><div class="bigpin">' + esc(pin) + '</div>' +
      '<p class="small">PIN 只會顯示這一次，請私下告訴本人。忘記的話可以再重設。</p>' +
      '<div class="foot"><button class="btn primary" data-close>我記下了</button></div>');
  }

  var SETTING_LABELS = { maxAhead: ['一次最多預約幾次', '次'], monthCap: ['同個案同服務碼別，每月最多', '次'],
    gapDays: ['同個案同服務碼別，間隔至少', '天'], remindDays: ['最後一次服務後幾天沒約下一次，就提醒', '天'] };
  var FIRST_LABELS = { normalDays: ['第一次服務在派案後幾天內算正常', '天'], maxDays: ['第一次服務最遲在派案後第幾天', '天'] };
  function optionsView() {
    var o = S.data.options, st = settings();
    var h = '<div class="form" style="margin-bottom:12px"><b>預約規則</b><div class="muted small">所有老師一起算，第一次服務也算在內。提醒天數前 7 天會先出現黃色提醒。</div><div class="grid2">';
    Object.keys(SETTING_LABELS).forEach(function (k) {
      h += '<div><label for="set_' + k + '">' + SETTING_LABELS[k][0] + '（' + SETTING_LABELS[k][1] + '）</label><input id="set_' + k + '" type="number" inputmode="numeric" value="' + st[k] + '"></div>';
    });
    h += '</div><button class="btn primary" style="margin-top:8px" data-a="saveSet">儲存預約規則</button></div>';
    h += '<div class="form" style="margin-bottom:12px"><b>第一次服務與結案</b><div class="muted small">派案當天算第 0 天。超過正常天數要選原因，並列入異常通報；超過最遲天數就不能選日期。</div><div class="grid2">';
    Object.keys(FIRST_LABELS).forEach(function (k) {
      h += '<div><label for="set_' + k + '">' + FIRST_LABELS[k][0] + '（' + FIRST_LABELS[k][1] + '）</label><input id="set_' + k + '" type="number" inputmode="numeric" value="' + st[k] + '"></div>';
    });
    h += '<div><label for="set_closeSystem">結案後提醒老師登打的系統名稱</label><input id="set_closeSystem" type="text" maxlength="30" value="' + esc(st.closeSystem) + '"></div>';
    h += '</div><button class="btn primary" style="margin-top:8px" data-a="saveSet2">儲存</button></div>';
    ['服務碼別', '區域', '超過7天原因', '結案原因', '異常通報原因'].forEach(function (cat) {
      var hint = cat === '超過7天原因' ? '老師選到第 ' + (rules().normal + 1) + ' 天以後時的常用原因，一行一個。「其他」會自動排在最後，不用寫。全部清空會恢復預設。' :
        (cat === '結案原因' ? '老師結案時的原因，一行一個。「其它」會自動排在最後（選其它要自己寫），不用寫。全部清空會恢復預設。' :
        (cat === '異常通報原因' ? '老師按「異常通報」時的原因，一行一個。「其他」會自動排在最後（選其他要自己寫），不用寫。全部清空會恢復預設。' : '一行一個，順序就是下拉選單的順序'));
      var label = cat === '超過7天原因' ? overLabel() : cat;
      h += '<div class="form" style="margin-bottom:12px"><b>' + label + '</b><div class="muted small">' + hint + '</div>' +
        '<textarea data-cat="' + cat + '" style="min-height:140px">' + esc((o[cat] || []).join('\n')) + '</textarea>' +
        '<button class="btn primary" style="margin-top:8px" data-a="saveOpt" data-cat="' + cat + '">儲存' + label + '</button></div>';
    });
    return h;
  }

  // ===== 事件 =====
  document.addEventListener('change', function (e) {
    var f = e.target.closest && e.target.closest('.calf');
    if (!f) return;
    calState()[{ calT: 't', calR: 'r', calS: 's' }[f.id]] = f.value;
    render();
  });
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (t.closest('[data-close]')) { closeModal(); return; }
    var tab = t.closest('[data-ttab]');
    if (tab) { S.tTab = tab.getAttribute('data-ttab'); render(); return; }
    var fl = t.closest('[data-filter]');
    if (fl) { S.filter = fl.getAttribute('data-filter'); render(); return; }
    var cm = t.closest('[data-calm]');
    if (cm) {
      var cs0 = calState(), mv = Number(cm.getAttribute('data-calm'));
      if (mv) { cs0.month = monthShift(cs0.month, mv); cs0.day = cs0.month === today().slice(0, 7) ? today() : cs0.month + '-01'; }
      else { cs0.month = today().slice(0, 7); cs0.day = today(); }
      render(); return;
    }
    var cdy = t.closest('[data-cald]');
    if (cdy) { calState().day = cdy.getAttribute('data-cald'); render(); return; }
    var nv = t.closest('[data-nav]');
    if (nv) { S.nav = nv.getAttribute('data-nav'); render(); return; }

    var b = t.closest('[data-a]');
    if (!b || b.disabled) return;
    var a = b.getAttribute('data-a'), id = b.getAttribute('data-id'), vid = b.getAttribute('data-vid');
    if ((id && id.indexOf('tmp-') === 0) || (vid && vid.indexOf('tmp-') === 0)) return toast('這筆剛建立，還在儲存，請稍候', true);
    var c = id ? findCase(id) : null;
    var vv = vid ? findVisit(vid) : null;
    if (vv) c = findCase(vv.caseId);

    switch (a) {
      case 'reply': datePicker(c, 'reply'); break;
      case 'change': datePicker(c, 'change'); break;
      case 'cannot':
        choiceDialog({ title: '異常通報', sub: esc(c.caseName) + '．' + esc(c.service) + '<br>個案那邊的原因造成無法服務時，請通報管理者處理',
          label: '原因（必選）', items: abnormalReasons(), other: '其他', ok: '送出異常通報' }, function (r) {
          act('cannotServe', { caseId: c.id, reason: r }, '已送出異常通報', true);
        }, true); break;
      case 'complete':
        if (confirm('確認「' + c.caseName + '」已在 ' + full(c.firstDate) + ' 完成第一次服務？')) act('complete', { caseId: c.id }, '已回報完成', true);
        break;
      case 'cancelChange':
        if (confirm('確定撤回這筆異動申請？')) act('cancelChange', { caseId: c.id }, '已撤回', true);
        break;
      case 'approve':
        var p = pendingOf(c);
        if (confirm('核准改為 ' + full(p.newDate) + '（第 ' + p.newDay + ' 天）？')) act('reviewChange', { changeId: p.id, approve: true }, '已核准', true);
        break;
      case 'reject':
        var p2 = pendingOf(c);
        reasonDialog('駁回異動申請', '原時間 ' + full(p2.oldDate) + ' 維持不變', '駁回原因（老師會看到）', function (r) {
          act('reviewChange', { changeId: p2.id, approve: false, comment: r }, '已駁回', true);
        }, true); break;
      case 'okReassign':
      case 'reassign':
        var tl = teachers().filter(function (x) { return x.id !== c.teacherId || c.status === '無法服務'; }).map(function (x) { return { value: x.id, text: x.name }; });
        openModal('<h2>改派</h2><div class="muted small">' + esc(c.caseName) + '．目前老師：' + esc(c.teacherName) + '<br>派案日維持 ' + full(c.dispatchDate) + '，天數照原派案日計算。</div>' +
          '<label for="rt">改派給</label>' + selectHtml('rt', tl, '', '請選擇老師') +
          '<div class="foot"><button class="btn" data-close>取消</button><button class="btn primary" id="rtOk">確定改派</button></div>');
        document.getElementById('rtOk').onclick = function () {
          var v = document.getElementById('rt').value;
          if (!v) return toast('請選擇老師', true);
          act('reassign', { caseId: c.id, teacherId: v }, '已改派', true);
        };
        break;
      case 'edit':
        openModal(caseForm(c)); bindCaseForm(c); break;
      case 'cancel':
        reasonDialog('取消派案', esc(c.caseName) + '．取消後老師就看不到這筆派案', '取消原因（必填）', function (r) {
          act('cancelCase', { caseId: c.id, reason: r }, '已取消派案', true);
        }, true); break;
      case 'notify':
        e.preventDefault();
        var val = !(c.notified === 'Y');
        act('markNotified', { caseId: c.id, value: val }, val ? '已標記為已通報' : '已取消標記', true);
        break;
      case 'failCancel':
        openModal('<h2>協調不成：通報並取消</h2><div class="muted small">' + esc(c.caseName) + '．' + esc(c.service) + '．老師通報：' + esc(c.cannotReason) + '</div>' +
          '<label for="fcR">取消原因（必填）</label><textarea id="fcR">' + esc('協調不成：' + c.cannotReason) + '</textarea>' +
          '<label class="check" style="margin-top:10px"><input type="checkbox" id="fcN"> 我已完成異常通報</label>' +
          '<div class="foot"><button class="btn" data-close>返回</button><button class="btn danger" id="fcOk" disabled>取消派案</button></div>');
        var fcN = document.getElementById('fcN'), fcR = document.getElementById('fcR'), fcOk = document.getElementById('fcOk');
        var fcChk = function () { fcOk.disabled = !(fcN.checked && fcR.value.trim()); };
        fcN.onchange = fcChk; fcR.oninput = fcChk;
        fcOk.onclick = function () { act('cancelCase', { caseId: c.id, reason: fcR.value.trim(), notified: true }, '已通報並取消', true); };
        break;
      case 'toLegacy':
        openModal('<h2>轉為舊案</h2><div class="muted small">' + esc(c.caseName) + '．' + esc(c.service) + '．派案日 ' + full(c.dispatchDate) + '</div>' +
          '<p class="small">已經在服務中的個案，轉成舊案後直接進「服務中」，老師之後用「預約下一次」排服務，不看第一次服務的天數規定。</p>' +
          '<label for="lgD">上次服務日（必填）</label><input id="lgD" type="date" min="' + c.dispatchDate + '" max="' + today() + '">' +
          '<div class="foot"><button class="btn" data-close>取消</button><button class="btn primary" id="lgOk">轉為舊案</button></div>');
        document.getElementById('lgOk').onclick = function () {
          var d = document.getElementById('lgD').value;
          if (!d) return toast('請填寫上次服務日', true);
          if (d > today()) return toast('上次服務日不能是未來的日期', true);
          if (d < c.dispatchDate) return toast('上次服務日不能早於派案日期', true);
          act('convertLegacy', { caseId: c.id, lastDate: d }, '已轉為舊案', true);
        };
        break;
      case 'copyAb':
        copyText([c.caseNo, c.caseName, c.service, '派案日 ' + c.dispatchDate, '老師 ' + c.teacherName, '個案無法服務：' + c.cannotReason].join('\t'));
        break;
      case 'copy':
        var txt = [c.caseNo, c.caseName, c.service, '派案日 ' + c.dispatchDate, '首次服務日 ' + c.firstDate + '（第' + c.day + '天）', '原因：' + c.overReason].join('\t');
        copyText(txt); break;
      case 'addUser':
        var nm = document.getElementById('uName').value.trim(), ph = document.getElementById('uPhone').value.trim(), rl = document.getElementById('uRole').value;
        if (!nm || !ph || !rl) return toast('請填寫姓名、手機與角色', true);
        act('createUser', { name: nm, phone: ph, role: rl }).then(function (d) { showPin(nm, d.result.pin); });
        break;
      case 'editUser':
        var u = S.data.users.filter(function (x) { return x.id === id; })[0];
        openModal('<h2>修改帳號</h2>' +
          '<label for="eName">姓名</label><input id="eName" type="text" value="' + esc(u.name) + '">' +
          '<label for="ePhone">手機</label><input id="ePhone" type="tel" inputmode="numeric" value="' + esc(u.phone) + '">' +
          '<label for="eRole">角色</label>' + selectHtml('eRole', ['老師', '管理者'], u.role, '請選擇') +
          '<label class="check" style="margin-top:14px"><input id="eAct" type="checkbox"' + (u.active ? ' checked' : '') + '> 啟用</label>' +
          '<p class="muted small">改手機、角色或停用後，這個人要重新登入。</p>' +
          '<div class="foot"><button class="btn" data-close>取消</button><button class="btn primary" id="eOk">儲存</button></div>');
        document.getElementById('eOk').onclick = function () {
          act('updateUser', { id: u.id, name: document.getElementById('eName').value, phone: document.getElementById('ePhone').value,
            role: document.getElementById('eRole').value, active: document.getElementById('eAct').checked }, '已儲存', true);
        };
        break;
      case 'resetPin':
        var u2 = S.data.users.filter(function (x) { return x.id === id; })[0];
        if (confirm('確定重設「' + u2.name + '」的 PIN？原本登入的手機會被登出。')) {
          act('resetPin', { id: u2.id }).then(function (d) { showPin(u2.name, d.result.pin); }).catch(function () {});
        }
        break;
      case 'book': bookPicker(c); break;
      case 'vmove': bookPicker(c, vv); break;
      case 'vcancel':
        if (confirm('確定取消 ' + full(vv.date) + ' 的服務？')) act('cancelVisit', { visitId: vv.id }, '已取消', true);
        break;
      case 'vdone':
        if (vv.kind === '首次' && !isAdmin()) { if (confirm('確認「' + c.caseName + '」已在 ' + full(vv.date) + ' 完成第一次服務？')) act('complete', { caseId: c.id }, '已回報完成', true); }
        else if (confirm('確認「' + c.caseName + '」' + full(vv.date) + ' 的服務已完成？')) act('completeVisit', { visitId: vv.id }, '已回報完成', true);
        break;
      case 'close': closeDialog(c); break;
      case 'newClient': clientModal(null, true); break;
      case 'newClient2': clientModal(null, false); break;
      case 'editClient':
        clientModal((S.data.clients || []).filter(function (x) { return x.id === b.getAttribute('data-cid'); })[0]); break;
      case 'saveSet':
        var vals = {}, bad = '';
        Object.keys(SETTING_LABELS).forEach(function (k) {
          var n = Number(document.getElementById('set_' + k).value);
          if (!(n % 1 === 0) || n < 0) bad = SETTING_LABELS[k][0];
          vals[k] = n;
        });
        if (bad) return toast(bad + '請填正整數', true);
        act('saveSettings', { values: vals }, '已儲存預約規則', true);
        break;
      case 'saveSet2':
        var v2 = {}, bad2 = '';
        Object.keys(FIRST_LABELS).forEach(function (k) {
          var n = Number(document.getElementById('set_' + k).value);
          if (!(n % 1 === 0) || n < 1) bad2 = FIRST_LABELS[k][0];
          v2[k] = n;
        });
        if (bad2) return toast(bad2 + '請填正整數', true);
        if (v2.maxDays <= v2.normalDays) return toast('最遲天數要大於正常天數', true);
        v2.closeSystem = document.getElementById('set_closeSystem').value.trim();
        if (!v2.closeSystem) return toast('請填寫系統名稱', true);
        act('saveSettings', { values: v2 }, '已儲存', true);
        break;
      case 'saveOpt':
        var cat = b.getAttribute('data-cat');
        var ta = document.querySelector('textarea[data-cat="' + cat + '"]');
        act('saveOptions', { category: cat, values: ta.value.split('\n') }, '已儲存' + cat, true);
        break;
    }
  });

  function copyText(txt) {
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = txt; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); toast('已複製'); } catch (e) { toast('無法複製，請手動選取', true); }
      document.body.removeChild(ta);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(function () { toast('已複製'); }, fallback);
    else fallback();
  }

  // ===== 啟動 =====
  if (!window.CONFIG || /請貼上/.test(window.CONFIG.API_URL)) {
    $app.innerHTML = '<div class="center">尚未設定後端網址，請編輯 config.js</div>';
  } else if (S.token) {
    start();
  } else {
    renderLogin();
  }
  // 回到畫面時自動更新（看到別人的異動）
  document.addEventListener('visibilitychange', function () { if (!document.hidden && S.data) refresh(); });
  document.addEventListener('focusout', function () { setTimeout(function () { if (S.dirty) { S.dirty = false; safeRender(); } }, 0); });
  window.addEventListener('beforeunload', function (e) { if (S.queue.length) { e.preventDefault(); e.returnValue = ''; } });
})();
