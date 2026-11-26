(function () {
  'use strict';

  // ===== 儲存 =====
  var store = {
    get: function (k, session) { try { return (session ? sessionStorage : localStorage).getItem(k); } catch (e) { return null; } },
    set: function (k, v, session) { try { (session ? sessionStorage : localStorage).setItem(k, v); } catch (e) {} },
    del: function (k) { try { localStorage.removeItem(k); sessionStorage.removeItem(k); } catch (e) {} }
  };
  var K_TEACHER = 'pd_teacher_token', K_ADMIN = 'pd_admin_token', K_PHONE = 'pd_phone', K_DATA = 'pd_data';
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
  function rules() { return S.data.rules; }
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
      '<img class="logo" src="logo.png" alt="phoebe 營養諮詢中心">' +
      '<h1>派案進度追蹤</h1><p class="muted small">第一次使用請輸入手機與 4 碼 PIN，PIN 由管理者提供。</p>' +
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
  var LOCAL = {
    reply: function (d, p) { var c = cById(d, p.caseId); setFirst(d, c, p.date, p.reason); c.status = '待服務'; c.repliedAt = nowStr(); },
    complete: function (d, p) { var c = cById(d, p.caseId); c.status = '已完成'; c.doneAt = c.updatedAt = nowStr(); },
    cannotServe: function (d, p) {
      var c = cById(d, p.caseId); voidPend(d, c.id);
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
        if (c.notified === 'Y') { c.notified = ''; c.notifiedAt = ''; c.notifiedBy = ''; }
      } else h.status = '駁回';
    },
    reassign: function (d, p) {
      var c = cById(d, p.caseId), t = d.users.filter(function (u) { return u.id === p.teacherId; })[0];
      voidPend(d, c.id);
      c.teacherId = t.id; c.teacherName = t.name; c.status = '待回覆';
      c.firstDate = c.day = c.overReason = c.repliedAt = c.cannotReason = c.cannotAt = '';
      c.notified = c.notifiedAt = c.notifiedBy = '';
      c.reassignCount = String(Number(c.reassignCount || 0) + 1); c.updatedAt = nowStr();
    },
    cancelCase: function (d, p) { var c = cById(d, p.caseId); voidPend(d, c.id); c.status = '已取消'; c.cancelReason = p.reason; c.updatedAt = nowStr(); },
    markNotified: function (d, p) {
      var c = cById(d, p.caseId);
      if (p.value) { c.notified = 'Y'; c.notifiedAt = nowStr(); c.notifiedBy = d.user.name; }
      else { c.notified = c.notifiedAt = c.notifiedBy = ''; }
    },
    updateCase: function (d, p) {
      var c = cById(d, p.caseId);
      Object.keys(p.fields).forEach(function (k) { if (k !== 'dispatchDate' || c.status === '待回覆') c[k] = p.fields[k]; });
      c.updatedAt = nowStr();
    },
    createCase: function (d, p) {
      var f = p.fields, t = d.users.filter(function (u) { return u.id === f.teacherId; })[0];
      d.cases.push({ id: 'tmp-' + Date.now(), caseNo: f.caseNo, caseName: f.caseName, service: f.service, region: f.region,
        dispatchDate: f.dispatchDate, teacherId: t.id, teacherName: t.name, note: f.note, status: '待回覆', reassignCount: '0',
        firstDate: '', day: '', createdAt: nowStr(), updatedAt: nowStr() });
    },
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
  function overdueUnreported(c) { return c.status === '待服務' && c.firstDate && c.firstDate < today(); }
  function inReport(c) { return (c.status === '待服務' || c.status === '已完成') && Number(c.day) > rules().normal; }

  function caseHead(c, showTeacher) {
    var h = '<h3>' + esc(c.caseName) + (c.caseNo ? ' <span class="muted small">' + esc(c.caseNo) + '</span>' : '') + '</h3>';
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
      '已結束': cs.filter(function (c) { return c.status === '已完成' || c.status === '無法服務'; })
    };
    groups['待回覆'].sort(function (a, b) { return a.dispatchDate.localeCompare(b.dispatchDate); });
    groups['待服務'].sort(function (a, b) { return a.firstDate.localeCompare(b.firstDate); });
    groups['已結束'].sort(function (a, b) { return (b.updatedAt || '').localeCompare(a.updatedAt || ''); });

    var h = '<div class="tabs">';
    Object.keys(groups).forEach(function (k) {
      var n = groups[k].length;
      var alert = k === '待回覆' && n > 0;
      h += '<button class="tab' + (S.tTab === k ? ' on' : '') + '" data-ttab="' + k + '">' + k + '<span class="n' + (alert ? ' alert' : '') + '">' + n + '</span></button>';
    });
    h += '</div>';
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
      if (left < 0) { cls = 'bad'; h += '<div class="note bad">已超過 ' + rules().max + ' 天，無法再選日期，請按「無法服務」說明原因。</div>'; }
      h += '<div class="acts">';
      if (left >= 0) h += '<button class="btn primary" data-a="reply" data-id="' + c.id + '">回覆首次服務日</button>';
      h += '<button class="btn danger" data-a="cannot" data-id="' + c.id + '">無法服務</button></div>';
    } else if (c.status === '待服務') {
      var od = overdueUnreported(c);
      cls = od ? 'bad' : (Number(c.day) > rules().normal ? 'warn' : 'ok');
      h += caseHead(c);
      h += '<div class="row"><b>首次服務日 ' + full(c.firstDate) + '</b> ' + dayTag(c.day) + '</div>';
      if (c.overReason) h += '<div class="note warn">超過 7 天原因：' + esc(c.overReason) + '</div>';
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
          '<button class="btn danger" data-a="cannot" data-id="' + c.id + '">無法服務</button></div>';
      }
    } else {
      cls = c.status === '已完成' ? 'ok' : '';
      h += caseHead(c);
      if (c.status === '已完成') h += '<div class="row">首次服務日 ' + full(c.firstDate) + ' ' + dayTag(c.day) + ' <span class="tag ok">已完成</span></div>';
      else h += '<div class="note">已回報無法服務：' + esc(c.cannotReason) + '<br><span class="muted small">等待管理者改派</span></div>';
    }
    return '<div class="card ' + cls + '">' + h + '</div>';
  }

  // 日期選擇視窗（回覆與異動共用）
  function datePicker(c, mode) {
    var r = rules();
    var start = Math.max(0, elapsed(c));
    var opts = '';
    for (var d = start; d <= r.max; d++) {
      var ds = addDays(c.dispatchDate, d);
      var cur = mode === 'change' && ds === c.firstDate;
      opts += '<button type="button" class="d ' + (d > r.normal ? 'over' : 'normal') + (cur ? ' cur' : '') + '" data-date="' + ds + '" data-day="' + d + '"' + (cur ? ' disabled' : '') + '>' +
        '<b>' + md(ds).replace(/（.）/, '') + '</b><span>週' + WK[new Date(ymd(ds)).getUTCDay()] + '．第' + d + '天</span></button>';
    }
    var title = mode === 'change' ? '申請改首次服務日' : '回覆首次服務日';
    var h = '<h2>' + title + '</h2><div class="muted small">' + esc(c.caseName) + '．派案日 ' + full(c.dispatchDate) + '（第 0 天）</div>';
    if (mode === 'change') h += '<div class="small" style="margin-top:6px">目前：' + full(c.firstDate) + '（第 ' + c.day + ' 天），需管理者核准才會生效。</div>';
    h += '<div class="legend"><span><i style="background:#2f7d4f"></i>' + r.normal + ' 天內（正常）</span><span><i style="background:#b66a12"></i>第 ' + (r.normal + 1) + '～' + r.max + ' 天（需填原因）</span></div>';
    h += '<div class="dates" id="dates">' + opts + '</div>';
    h += '<div id="overBox" class="alertbox hidden">這個日期超過 ' + r.normal + ' 天，會列入異動通報，請選擇原因。</div>';
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
      '異動待審': cs.filter(function (c) { return pend[c.id]; }),
      '待改派': cs.filter(function (c) { return c.status === '無法服務'; }),
      '逾期未回報': cs.filter(overdueUnreported),
      '異動通報': cs.filter(inReport),
      '已完成': cs.filter(function (c) { return c.status === '已完成'; }),
      '全部': cs.slice()
    };
  }

  function renderAdmin() {
    var navs = ['派案', '建立派案', '帳號', '選項'];
    var h = '<div class="nav">';
    navs.forEach(function (n) { h += '<button data-nav="' + n + '" class="' + (S.nav === n ? 'on' : '') + '">' + n + '</button>'; });
    h += '</div>';
    if (S.nav === '派案') h += adminCases();
    else if (S.nav === '建立派案') h += caseForm(null);
    else if (S.nav === '帳號') h += usersView();
    else h += optionsView();
    $app.innerHTML = h;
    if (S.nav === '建立派案') bindCaseForm(null);
    if (S.nav === '派案') {
      var q = document.getElementById('q');
      if (q) q.oninput = function () { S.q = q.value; var pos = q.selectionStart; renderAdmin(); var q2 = document.getElementById('q'); q2.focus(); q2.setSelectionRange(pos, pos); };
    }
  }

  function adminCases() {
    var g = adminGroups();
    var alertTabs = { '待回覆': 1, '異動待審': 1, '待改派': 1, '逾期未回報': 1 };
    var h = '<div class="tabs">';
    Object.keys(g).forEach(function (k) {
      var n = k === '異動通報' ? g[k].filter(function (c) { return c.notified !== 'Y'; }).length : g[k].length;
      var al = alertTabs[k] && n > 0;
      h += '<button class="tab' + (S.filter === k ? ' on' : '') + '" data-filter="' + k + '">' + k +
        (k === '全部' || k === '已完成' || k === '待服務' ? '' : '<span class="n' + (al ? ' alert' : '') + '">' + n + '</span>') + '</button>';
    });
    h += '</div>';
    h += '<input id="q" class="search" type="text" placeholder="搜尋個案姓名、編號、老師" value="' + esc(S.q) + '">';
    var list = g[S.filter];
    var q = S.q.trim();
    if (q) list = list.filter(function (c) { return [c.caseName, c.caseNo, c.teacherName, c.service, c.region].join(' ').indexOf(q) >= 0; });

    var sorters = {
      '待回覆': function (a, b) { return a.dispatchDate.localeCompare(b.dispatchDate); },
      '待服務': function (a, b) { return a.firstDate.localeCompare(b.firstDate); },
      '逾期未回報': function (a, b) { return a.firstDate.localeCompare(b.firstDate); },
      '異動通報': function (a, b) { return (a.notified === 'Y') - (b.notified === 'Y') || b.firstDate.localeCompare(a.firstDate); }
    };
    list.sort(sorters[S.filter] || function (a, b) { return (b.updatedAt || '').localeCompare(a.updatedAt || ''); });

    if (S.filter === '異動通報') h += '<div class="muted small" style="margin-bottom:8px">首次服務落在第 ' + (rules().normal + 1) + '～' + rules().max + ' 天的派案。到系統完成異動通報後打勾，紅色數字是還沒通報的筆數。</div>';
    if (!list.length) h += '<div class="empty">沒有資料</div>';
    list.forEach(function (c) { h += adminCard(c); });
    return h;
  }

  function adminCard(c) {
    var cls = '', h = caseHead(c, true);
    var p = pendingOf(c);
    var st = '<span class="tag ' + ({ '待回覆': 'warn', '待服務': '', '已完成': 'ok', '無法服務': 'bad', '已取消': 'gray' }[c.status] || '') + '">' + c.status + '</span>';
    h = h.replace('</h3>', ' ' + st + (Number(c.reassignCount) > 0 ? ' <span class="tag gray">改派 ' + c.reassignCount + ' 次</span>' : '') + '</h3>');
    var acts = [];

    if (c.status === '待回覆') {
      var e = elapsed(c);
      if (e > rules().max) { cls = 'bad'; h += '<div class="note bad">已過 ' + rules().max + ' 天仍未回覆</div>'; }
      else if (e > rules().normal) { cls = 'warn'; h += '<div class="note warn">已過 ' + rules().normal + ' 天仍未回覆</div>'; }
      acts.push('reassign', 'edit', 'cancel');
    } else if (c.status === '待服務' || c.status === '已完成') {
      var od = overdueUnreported(c);
      cls = od ? 'bad' : (Number(c.day) > rules().normal ? 'warn' : (c.status === '已完成' ? 'ok' : ''));
      h += '<div class="row"><b>首次服務日 ' + full(c.firstDate) + '</b> ' + dayTag(c.day) + '</div>';
      if (c.overReason) h += '<div class="note warn">超過 7 天原因：' + esc(c.overReason) + '</div>';
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
        h += '<div class="row"><label class="check"><input type="checkbox" data-a="notify" data-id="' + c.id + '"' + (c.notified === 'Y' ? ' checked' : '') + '> 已完成異動通報' +
          (c.notified === 'Y' ? ' <span class="muted small">（' + esc(c.notifiedBy) + ' ' + esc(c.notifiedAt.slice(0, 16)) + '）</span>' : '') + '</label></div>';
        acts.push('copy');
      }
    } else if (c.status === '無法服務') {
      cls = 'bad';
      h += '<div class="note bad">老師回報無法服務：' + esc(c.cannotReason) + '<br><span class="muted small">' + esc(c.cannotAt) + '</span></div>';
      acts.push('reassign', 'edit', 'cancel');
    } else if (c.status === '已取消') {
      h += '<div class="note">取消原因：' + esc(c.cancelReason) + '</div>';
    }

    var labels = {
      approve: ['primary', '核准'], reject: ['danger', '駁回'], complete: ['ok', '代為回報完成'],
      reassign: ['', '改派'], edit: ['', '修改'], cancel: ['danger', '取消派案'], copy: ['', '複製通報資料']
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

  function caseForm(c) {
    var o = S.data.options;
    var tlist = teachers().map(function (t) { return { value: t.id, text: t.name }; });
    var lockDate = c && c.status !== '待回覆';
    var h = '<div class="form">' + (c ? '<h2>修改派案</h2>' : '') + '<div class="grid2">' +
      '<div><label for="fNo">個案編號</label><input id="fNo" type="text" value="' + esc(c ? c.caseNo : '') + '"></div>' +
      '<div><label for="fName">個案姓名（必填）</label><input id="fName" type="text" value="' + esc(c ? c.caseName : '') + '"></div>' +
      '<div><label for="fSvc">服務項目（必填）</label>' + selectHtml('fSvc', o['服務項目'] || [], c ? c.service : '', '請選擇') + '</div>' +
      '<div><label for="fReg">區域</label>' + selectHtml('fReg', o['區域'] || [], c ? c.region : '', '請選擇') + '</div>' +
      '<div><label for="fDate">派案日期（必填）</label><input id="fDate" type="date" max="' + today() + '" value="' + (c ? c.dispatchDate : today()) + '"' + (lockDate ? ' disabled' : '') + '>' +
      (lockDate ? '<div class="muted small">老師已回覆，不能改派案日期</div>' : '') + '</div>';
    if (!c) h += '<div><label for="fT">指派老師（必填）</label>' + selectHtml('fT', tlist, '', tlist.length ? '請選擇' : '尚無老師帳號') + '</div>';
    h += '</div><label for="fNote">備註</label><textarea id="fNote">' + esc(c ? c.note : '') + '</textarea>';
    if (c) h += '<div class="foot"><button class="btn" data-close>取消</button><button class="btn primary" id="fSave">儲存</button></div>';
    else h += '<button class="btn primary block" id="fSave">建立派案</button>';
    return h + '</div>';
  }

  function bindCaseForm(c) {
    document.getElementById('fSave').onclick = function () {
      var v = function (id) { var el = document.getElementById(id); return el ? el.value.trim() : ''; };
      var fields = { caseNo: v('fNo'), caseName: v('fName'), service: v('fSvc'), region: v('fReg'), dispatchDate: v('fDate'), note: v('fNote') };
      if (!fields.caseName) return toast('請填寫個案姓名', true);
      if (!fields.service) return toast('請選擇服務項目', true);
      if (c) {
        if (c.status !== '待回覆') delete fields.dispatchDate;
        act('updateCase', { caseId: c.id, fields: fields }, '已儲存', true);
      } else {
        fields.teacherId = v('fT');
        if (!fields.teacherId) return toast('請選擇指派老師', true);
        S.nav = '派案'; S.filter = '待回覆';
        act('createCase', { fields: fields }, '已建立派案', true);
      }
    };
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

  function optionsView() {
    var o = S.data.options;
    var h = '';
    ['服務項目', '區域', '超過7天原因'].forEach(function (cat) {
      var hint = cat === '超過7天原因' ? '老師選到第 8 天以後時的常用原因，一行一個。「其他」會自動排在最後，不用寫。全部清空會恢復預設。' : '一行一個，順序就是下拉選單的順序';
      h += '<div class="form" style="margin-bottom:12px"><b>' + cat + '</b><div class="muted small">' + hint + '</div>' +
        '<textarea data-cat="' + cat + '" style="min-height:140px">' + esc((o[cat] || []).join('\n')) + '</textarea>' +
        '<button class="btn primary" style="margin-top:8px" data-a="saveOpt" data-cat="' + cat + '">儲存' + cat + '</button></div>';
    });
    return h;
  }

  // ===== 事件 =====
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (t.closest('[data-close]')) { closeModal(); return; }
    var tab = t.closest('[data-ttab]');
    if (tab) { S.tTab = tab.getAttribute('data-ttab'); render(); return; }
    var fl = t.closest('[data-filter]');
    if (fl) { S.filter = fl.getAttribute('data-filter'); render(); return; }
    var nv = t.closest('[data-nav]');
    if (nv) { S.nav = nv.getAttribute('data-nav'); render(); return; }

    var b = t.closest('[data-a]');
    if (!b || b.disabled) return;
    var a = b.getAttribute('data-a'), id = b.getAttribute('data-id');
    if (id && id.indexOf('tmp-') === 0) return toast('這筆剛建立，還在儲存，請稍候', true);
    var c = id ? findCase(id) : null;

    switch (a) {
      case 'reply': datePicker(c, 'reply'); break;
      case 'change': datePicker(c, 'change'); break;
      case 'cannot':
        reasonDialog('無法服務', esc(c.caseName) + '．送出後會退回給管理者改派', '原因（必填）', function (r) {
          act('cannotServe', { caseId: c.id, reason: r }, '已回報無法服務', true);
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
