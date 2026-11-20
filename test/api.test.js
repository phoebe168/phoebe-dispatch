// 後端邏輯測試：node test/api.test.js
const assert = require('assert');
const { makeEnv } = require('./gas-shim');

const env = makeEnv();
const S = env.sandbox;
S.setup();
const adminPin = env.logs.find(l => l.includes('PIN')).match(/(\d{4})$/)[1];
S.createTestData();
const pins = {};
env.logs.forEach(l => { const m = l.match(/老師 (\S+)（(\d+)）PIN：(\d{4})/); if (m) pins[m[1]] = { phone: m[2], pin: m[3] }; });

let pass = 0;
function ok(r, msg) { assert.ok(r.ok, msg + ' → ' + r.error); pass++; return r.data; }
function bad(r, expect, msg) { assert.ok(!r.ok, msg + ' 應該失敗'); if (expect) assert.ok(r.error.includes(expect), msg + '：錯誤訊息「' + r.error + '」'); pass++; }

// 登入
bad(env.post({ action: 'login', phone: '0900000000', pin: '0000' === adminPin ? '1111' : '0000' }), '不正確', '錯誤 PIN');
const admin = ok(env.post({ action: 'login', phone: '0900-000-000', pin: adminPin }), '管理者登入');
const A = admin.token;
const wang = ok(env.post({ action: 'login', phone: pins['王小美'].phone, pin: pins['王小美'].pin }), '老師登入');
const W = wang.token;

// 老師看不到別人的案
let b = ok(env.post({ action: 'bootstrap', token: W }), '老師 bootstrap');
assert.ok(b.cases.every(c => c.teacherId === wang.user.id)); assert.ok(!b.users); pass++;
let ab = ok(env.post({ action: 'bootstrap', token: A }), '管理者 bootstrap');
assert.strictEqual(ab.cases.length, 6); pass++;
bad(env.post({ action: 'createCase', token: W, fields: {} }), '權限', '老師不能建案');

// 王小美的案：back = 0 (index0) 與 9 (index3)
const today = ab.today;
const add = (s, n) => S.addDays_(s, n);
const c0 = b.cases.find(c => c.dispatchDate === today);
const c9 = b.cases.find(c => c.dispatchDate === add(today, -9));
assert.ok(c0 && c9); pass++;

bad(env.post({ action: 'reply', token: W, caseId: c0.id, date: add(today, 16) }), '15 天', '超過15天');
bad(env.post({ action: 'reply', token: W, caseId: c0.id, date: add(today, 8) }), '原因', '超過7天沒原因');
bad(env.post({ action: 'reply', token: W, caseId: c9.id, date: add(today, -1) }), '過去', '選過去日期');
ok(env.post({ action: 'reply', token: W, caseId: c0.id, date: add(today, 3) }), '正常回覆');
ok(env.post({ action: 'reply', token: W, caseId: c9.id, date: add(today, 1), reason: '家屬出國' }), '超過7天回覆');
bad(env.post({ action: 'reply', token: W, caseId: c0.id, date: add(today, 3) }), '待回覆', '重複回覆');

// 異動通報清單
ab = ok(env.post({ action: 'bootstrap', token: A }), '');
let x9 = ab.cases.find(c => c.id === c9.id);
assert.strictEqual(x9.day, '10'); assert.strictEqual(x9.overReason, '家屬出國'); pass++;
ok(env.post({ action: 'markNotified', token: A, caseId: c9.id, value: true }), '標記已通報');
bad(env.post({ action: 'markNotified', token: A, caseId: c0.id, value: true }), '清單', '正常案不能標通報');

// 異動申請
bad(env.post({ action: 'requestChange', token: W, caseId: c0.id, date: add(today, 5) }), '原因', '異動沒原因');
ok(env.post({ action: 'requestChange', token: W, caseId: c0.id, date: add(today, 9), reason: '個案住院' }), '申請異動到第9天');
bad(env.post({ action: 'requestChange', token: W, caseId: c0.id, date: add(today, 4), reason: 'x' }), '待審', '重複申請');
bad(env.post({ action: 'complete', token: W, caseId: c0.id }), '', '待審中不能完成');
ab = ok(env.post({ action: 'bootstrap', token: A }), '');
const ch = ab.changes.find(h => h.caseId === c0.id && h.status === '待審');
ok(env.post({ action: 'reviewChange', token: A, changeId: ch.id, approve: true }), '核准異動');
ab = ok(env.post({ action: 'bootstrap', token: A }), '');
let x0 = ab.cases.find(c => c.id === c0.id);
assert.strictEqual(x0.firstDate, add(today, 9)); assert.strictEqual(x0.day, '9'); assert.strictEqual(x0.overReason, '個案住院'); pass++;

// 駁回
ok(env.post({ action: 'requestChange', token: W, caseId: c9.id, date: add(today, 2), reason: '改時間' }), '再申請');
ab = ok(env.post({ action: 'bootstrap', token: A }), '');
const ch2 = ab.changes.find(h => h.caseId === c9.id && h.status === '待審');
ok(env.post({ action: 'reviewChange', token: A, changeId: ch2.id, approve: false, comment: '請照原時間' }), '駁回');
ab = ok(env.post({ action: 'bootstrap', token: A }), '');
assert.strictEqual(ab.cases.find(c => c.id === c9.id).firstDate, add(today, 1)); pass++;

// 完成：未到日期不行，日期到了可以
bad(env.post({ action: 'complete', token: W, caseId: c9.id }), '還沒到', '未到日期完成');
env.setOffsetDays(1);
ok(env.post({ action: 'complete', token: W, caseId: c9.id }), '到日期後完成');
env.setOffsetDays(0);

// 無法服務與改派（派案日不變）
const li = ok(env.post({ action: 'login', phone: pins['李大華'].phone, pin: pins['李大華'].pin }), '李大華登入');
const lb = ok(env.post({ action: 'bootstrap', token: li.token }), '');
const c16 = lb.cases.find(c => c.dispatchDate === add(today, -16));
const lic = c16 || lb.cases[0];
bad(env.post({ action: 'cannotServe', token: li.token, caseId: lic.id }), '原因', '無法服務沒原因');
ok(env.post({ action: 'cannotServe', token: li.token, caseId: lic.id, reason: '路程太遠' }), '無法服務');
bad(env.post({ action: 'reply', token: W, caseId: lic.id, date: today }), '不是你的', '回覆別人的案');
ok(env.post({ action: 'reassign', token: A, caseId: lic.id, teacherId: wang.user.id }), '改派給王小美');
b = ok(env.post({ action: 'bootstrap', token: W }), '');
const moved = b.cases.find(c => c.id === lic.id);
assert.ok(moved && moved.status === '待回覆' && moved.dispatchDate === lic.dispatchDate); pass++;

// 帳號：建立、重複手機、重設 PIN 讓舊登入失效、PIN 鎖定
const nu = ok(env.post({ action: 'createUser', token: A, name: '新老師', phone: '0922333444', role: '老師' }), '建帳號');
assert.ok(/^\d{4}$/.test(nu.result.pin)); pass++;
bad(env.post({ action: 'createUser', token: A, name: '重複', phone: '0922333444', role: '老師' }), '已經有帳號', '重複手機');
ok(env.post({ action: 'resetPin', token: A, id: wang.user.id }), '重設王小美 PIN');
bad(env.post({ action: 'bootstrap', token: W }), '失效', '舊登入失效');
for (let i = 0; i < 5; i++) env.post({ action: 'login', phone: '0922333444', pin: nu.result.pin === '9999' ? '9998' : '9999' });
bad(env.post({ action: 'login', phone: '0922333444', pin: nu.result.pin }), '過多', '鎖定後正確 PIN 也不行');
const nuId = ok(env.post({ action: 'bootstrap', token: A }), '').users.find(u => u.phone === '0922333444').id;
const reset = ok(env.post({ action: 'resetPin', token: A, id: nuId }), '重設解鎖');
ok(env.post({ action: 'login', phone: '0922333444', pin: reset.result.pin }), '解鎖後登入');

// 有進行中案件的老師不能停用
bad(env.post({ action: 'updateUser', token: A, id: wang.user.id, name: '王小美', phone: pins['王小美'].phone, role: '老師', active: false }), '進行中', '停用有案老師');
bad(env.post({ action: 'updateUser', token: A, id: admin.user.id, name: '美英', phone: '0900000000', role: '老師', active: true }), '自己', '取消自己管理者');

// 選項
ok(env.post({ action: 'saveOptions', token: A, category: '區域', values: ['竹北', '湖口', '竹北', ''] }), '存選項');
assert.deepStrictEqual(ok(env.post({ action: 'bootstrap', token: A }), '').options['區域'], ['竹北', '湖口']); pass++;

// 手機開頭 0 保留（寫入時強制文字）
assert.ok(env.ss.getSheetByName('帳號').data.slice(1).every(r => String(r[2]).startsWith('09'))); pass++;

// 清除測試資料
S.clearTestData();
ab = ok(env.post({ action: 'login', phone: '0900000000', pin: adminPin }), '清除後管理者仍可登入');
const after = ok(env.post({ action: 'bootstrap', token: ab.token }), '');
assert.strictEqual(after.cases.length, 0); assert.strictEqual(after.users.length, 1); pass++;

console.log('全部通過：' + pass + ' 項');
