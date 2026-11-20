// 在 Node 模擬 Apps Script 環境（SpreadsheetApp 等），用來測試 Code.gs
const fs = require('fs');
const vm = require('vm');
const crypto = require('crypto');
const path = require('path');

function strip(v) {
  if (typeof v === 'string' && v.startsWith("'")) return v.slice(1);
  return v === undefined || v === null ? '' : v;
}

class Sheet {
  constructor(name) { this.name = name; this.data = []; }
  getMaxRows() { return 1000; }
  getLastRow() {
    let n = this.data.length;
    while (n > 0 && this.data[n - 1].every(v => v === '')) n--;
    return n;
  }
  getLastColumn() { return this.data.reduce((m, r) => Math.max(m, r.length), 0); }
  setFrozenRows() {}
  appendRow(arr) { this.data.splice(this.getLastRow(), 0, arr.map(strip)); }
  deleteRow(r) { this.data.splice(r - 1, 1); }
  deleteRows(r, n) { this.data.splice(r - 1, n); }
  getRange(r, c, nr = 1, nc = 1) {
    const sh = this;
    return {
      getValues() {
        const out = [];
        for (let i = 0; i < nr; i++) {
          const row = sh.data[r - 1 + i] || [];
          const o = [];
          for (let j = 0; j < nc; j++) o.push(row[c - 1 + j] === undefined ? '' : row[c - 1 + j]);
          out.push(o);
        }
        return out;
      },
      setValues(vals) {
        for (let i = 0; i < nr; i++) {
          while (sh.data.length < r + i) sh.data.push([]);
          const row = sh.data[r - 1 + i];
          for (let j = 0; j < nc; j++) {
            while (row.length < c - 1 + j) row.push('');
            row[c - 1 + j] = strip(vals[i][j]);
          }
        }
        return this;
      },
      setNumberFormat() { return this; }
    };
  }
}

function makeEnv(opts = {}) {
  const sheets = {};
  const ss = {
    getSheetByName: n => sheets[n] || null,
    insertSheet: n => (sheets[n] = new Sheet(n)),
    _sheets: sheets
  };
  let offsetMs = 0;
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...a) { if (a.length === 0) super(RealDate.now() + offsetMs); else super(...a); }
    static now() { return RealDate.now() + offsetMs; }
  }
  function formatDate(d, tz, fmt) {
    const p = {};
    new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    }).formatToParts(d).forEach(x => { p[x.type] = x.value; });
    if (p.hour === '24') p.hour = '00';
    return fmt.replace('yyyy', p.year).replace('yy', p.year.slice(2)).replace('MM', p.month)
      .replace('dd', p.day).replace('HH', p.hour).replace('mm', p.minute).replace('ss', p.second);
  }
  const logs = [];
  const sandbox = {
    Date: FakeDate,
    Math, JSON, String, Number, Object, Array, Error, RegExp,
    SpreadsheetApp: { getActiveSpreadsheet: () => ss },
    Utilities: {
      formatDate,
      getUuid: () => crypto.randomUUID(),
      DigestAlgorithm: { SHA_256: 'sha256' },
      Charset: { UTF_8: 'utf8' },
      computeDigest: (alg, s) => Array.from(crypto.createHash(alg).update(s, 'utf8').digest()).map(b => (b > 127 ? b - 256 : b))
    },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: s => ({ setMimeType() { return this; }, getContent: () => s })
    },
    Logger: { log: m => { logs.push(String(m)); if (opts.verbose) console.log('[Logger]', m); } }
  };
  vm.createContext(sandbox);
  const code = fs.readFileSync(path.join(__dirname, '..', 'gas', 'Code.gs'), 'utf8');
  vm.runInContext(code, sandbox, { filename: 'Code.gs' });
  return {
    sandbox, ss, logs,
    setOffsetDays(n) { offsetMs = n * 86400000; },
    post(body) {
      const out = sandbox.doPost({ postData: { contents: JSON.stringify(body) } });
      return JSON.parse(out.getContent());
    }
  };
}

module.exports = { makeEnv };
