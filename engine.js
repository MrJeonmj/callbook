/* 전담 콜북 — 엔진
 * 1) readXlsx: xlsx(zip) 직접 해석 (외부 라이브러리 없음)
 * 2) extractBook: 근무표 → 과별 원자료(units)  ※ 행 위치 하드코딩 없음
 * 3) compute: 원자료 + 번호 규칙(cfg) → 교수별·날짜별 행
 * nurse_ext.py(인수인계 스킬)와 같은 규칙을 따른다.
 */
'use strict';
(function (G) {

/* ============================================================ xlsx 읽기 */
async function inflateRaw(u8) {
  const ds = new DecompressionStream('deflate-raw');
  return new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(ds)).arrayBuffer());
}
async function unzip(buf) {
  const u8 = new Uint8Array(buf), dv = new DataView(buf);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 70000); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('엑셀(xlsx) 파일이 아닙니다.');
  const n = dv.getUint16(eocd + 10, true); let p = dv.getUint32(eocd + 16, true);
  const files = {}, dec = new TextDecoder();
  for (let i = 0; i < n; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
    const nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), lo = dv.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nl));
    const s = lo + 30 + dv.getUint16(lo + 26, true) + dv.getUint16(lo + 28, true);
    files[name] = { method, data: u8.subarray(s, s + csize) };
    p += 46 + nl + xl + cl;
  }
  return { async text(name) { const f = files[name]; if (!f) return null; return dec.decode(f.method === 0 ? f.data : await inflateRaw(f.data)); } };
}
const xml = s => new DOMParser().parseFromString(s, 'application/xml');
const kids = (el, t) => Array.from(el.getElementsByTagName(t));
const colNum = ref => { let n = 0; for (const ch of ref) { const c = ch.charCodeAt(0); if (c < 65 || c > 90) break; n = n * 26 + c - 64; } return n; };

async function readXlsx(buf) {
  const z = await unzip(buf);
  const wb = xml(await z.text('xl/workbook.xml')), rels = xml(await z.text('xl/_rels/workbook.xml.rels'));
  const rm = {}; kids(rels, 'Relationship').forEach(r => rm[r.getAttribute('Id')] = r.getAttribute('Target'));
  const sh = kids(wb, 'sheet')[0];
  const rid = sh.getAttribute('r:id') || sh.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
  let target = rm[rid]; target = target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '');
  const ss = []; const sst = await z.text('xl/sharedStrings.xml');
  if (sst) for (const si of kids(xml(sst), 'si')) { let s = ''; for (const t of kids(si, 't')) if (t.parentNode.nodeName !== 'rPh') s += t.textContent; ss.push(s); }
  const fills = [], xfFill = []; const stx = await z.text('xl/styles.xml');
  if (stx) {
    const st = xml(stx); const fe = kids(st, 'fills')[0];
    if (fe) for (const f of kids(fe, 'fill')) {
      const pf = kids(f, 'patternFill')[0], fg = pf && kids(pf, 'fgColor')[0];
      if (!pf || pf.getAttribute('patternType') !== 'solid' || !fg) { fills.push(''); continue; }
      if (fg.getAttribute('rgb')) fills.push('rgb:' + fg.getAttribute('rgb').toUpperCase());
      else if (fg.getAttribute('theme') != null) fills.push('theme:' + fg.getAttribute('theme') + ':' + Math.round(parseFloat(fg.getAttribute('tint') || '0') * 10) / 10);
      else fills.push('');
    }
    const cx = kids(st, 'cellXfs')[0]; if (cx) for (const x of kids(cx, 'xf')) xfFill.push(fills[+x.getAttribute('fillId') || 0] || '');
  }
  const doc = xml(await z.text(target));
  const grid = new Map(); let maxRow = 0, maxCol = 0;
  for (const row of kids(doc, 'row')) {
    const r = +row.getAttribute('r');
    for (const c of kids(row, 'c')) {
      const col = colNum(c.getAttribute('r')), t = c.getAttribute('t'), s = +(c.getAttribute('s') || 0);
      let v = '';
      if (t === 'inlineStr') v = kids(c, 't').map(x => x.textContent).join('');
      else { const ve = kids(c, 'v')[0]; if (ve) { v = ve.textContent; if (t === 's') v = ss[+v] ?? ''; } }
      const fill = xfFill[s] || '';
      if (v === '' && !fill) continue;
      if (!grid.has(r)) grid.set(r, new Map());
      const num = !['s', 'str', 'inlineStr'].includes(t) && v !== '' && !isNaN(+v);
      if (num && /\.0+$/.test(v)) v = v.replace(/\.0+$/, '');
      grid.get(r).set(col, { v, fill, num });
      if (v !== '') { maxRow = Math.max(maxRow, r); maxCol = Math.max(maxCol, col); }
    }
  }
  return { sheetName: sh.getAttribute('name'), grid, maxRow, maxCol };
}

/* ============================================================ 공통 */
const WD = '월화수목금토일';                       // weekday() 0=월
const jsWd = (Y, M, d) => (new Date(Y, M - 1, d).getDay() + 6) % 7;
const SHN = { D: 'Day', E: 'Evening', N: 'Night' };
const UNK = '알수없음';
const unknown = g => `${UNK} (추정 ${g})`;
const clean = s => String(s ?? '').replace(/\s+/g, ' ').trim();
const PHONE = /0\d{1,2}-\d{3,4}-\d{4}/;
const EXT_G = /0\d{1,2}-\d{3,4}-\d{4}|\b86-?\d{4}\b|\b\d{6}\b|\b\d{4}\b/g;
const OFF = new Set(['P', 'Q', 'O', 'G', 'G1', 'S', 'F', 'V', '/', 'H', 'U', '결', '교', '노']);
const isDateSerial = x => x && x.num && +x.v > 40000 && +x.v < 60000;
function dn(c) { const m = /^([DEN])([a-dA-D]?)$/.exec(c); return m ? [m[1], m[2].toUpperCase()] : null; }
const isYellow = f => ['rgb:FFFFC000', 'rgb:FFFFFF00', 'rgb:FFFFD966', 'rgb:FFFFE699'].includes(f);
function isBlue(f) {
  if (/^theme:(4|8):/.test(f)) return true;
  if (f.startsWith('rgb:')) { const h = f.slice(-6), r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4), 16); return b > r + 20 && b >= g && !(r > 230 && g > 230 && b > 230); }
  return false;
}

/* 제외 근무표(사용자 지정) */
const EXCLUDE = /마취과|수술|영상의학|중환자외과|호흡기내과|신생아\s*중환자|응급의학|^IV|신속대응|NST/;
const SECTION_RULES = [
  [/비뇨.*(외래|병동)/, 'URO'], [/산부인과.*병동/, 'OBGY'], [/소아/, 'PEDS'], [/^신경과/, 'NEURO'],
  [/신경외과.*병동/, 'NS'], [/^안과/, 'EYE'], [/성형외과/, 'PS'], [/^외과.*병동/, 'GSW'], [/이비인후과/, 'ENT'],
  [/재활/, 'REHAB'], [/정형외과.*병동/, 'OS'], [/피부과/, 'DERM'], [/^심장혈관외과/, 'CVS'],
  [/심장혈관흉부외과/, 'TS'], [/^Acting/i, 'ACT'], [/^내과/, 'IM'],
];

/* 번호 규칙(교수 이름·번호)은 개인정보라 공개 코드에 두지 않는다.
 * 규칙은 암호화된 근무표 데이터(data.cfg)에만 들어 있고, 원본은 비공개 저장소의 rules/cfg.json.
 * cfg._ignore = 메모에 있어도 규칙 대조에서 뺄 번호(코디·오타 등) */
let DEFAULT_CFG = null;
const setDefaultCfg = c => { DEFAULT_CFG = c; };
const LIVE = new Set(['EYE', 'PS', 'REHAB', 'OS', 'DERM']);

/* 날짜 머리글(1·2·3…, 요일 줄) → 연월·일수·휴일. 근무표·당직표 공통 */
function monthOf({ v, fill, sheetName }, fileName, dateRow, dateCol, wdRow, opt = {}) {
  let nDays = 0;
  while (nDays < 31 && WD.includes(v(wdRow, dateCol + nDays)[0] || '#')) nDays++;
  const day1 = WD.indexOf(v(wdRow, dateCol)[0]);
  const issues = [];
  let ym = opt.ym;
  if (!ym) {
    const m = /(20\d{2})\D{0,8}?(1[0-2]|0?[1-9])(?!\d)/.exec(fileName || '');
    const now = new Date(), cs = m ? [[+m[1], +m[2]]] : [];
    for (let k = -6; k <= 12; k++) { const d = new Date(now.getFullYear(), now.getMonth() + k, 1); cs.push([d.getFullYear(), d.getMonth() + 1]); }
    let ok = cs.filter(([y, mo]) => jsWd(y, mo, 1) === day1 && new Date(y, mo, 0).getDate() === nDays);
    if (!m) ok.sort((a, b) => Math.abs(a[0] * 12 + a[1] - now.getFullYear() * 12 - now.getMonth() - 1) - Math.abs(b[0] * 12 + b[1] - now.getFullYear() * 12 - now.getMonth() - 1));
    ym = ok[0] || cs[0];
  }
  const [Y, M] = ym;
  if (jsWd(Y, M, 1) !== day1) issues.push(`${Y}년 ${M}월 1일 요일이 근무표와 다름 → 연월 확인`);
  if (new Date(Y, M, 0).getDate() !== nDays) issues.push(`${Y}년 ${M}월 일수와 근무표 일수(${nDays}) 다름`);
  if (!String(sheetName).includes(String(M))) issues.push(`시트 탭 이름(${sheetName})이 ${M}월과 다르지만 날짜·요일 기준 ${Y}년 ${M}월로 처리`);
  const days = Array.from({ length: nDays }, (_, i) => i + 1);
  let holi;
  if (opt.holidays) holi = new Set(opt.holidays);
  else {
    holi = new Set(days.filter(d => jsWd(Y, M, d) >= 5));
    const sun = days.find(d => jsWd(Y, M, d) === 6);
    const sunf = sun ? fill(dateRow, dateCol + sun - 1) : '';
    const fr = {}; days.filter(d => jsWd(Y, M, d) < 5).forEach(d => { const f = fill(dateRow, dateCol + d - 1); fr[f] = (fr[f] || 0) + 1; });
    const normal = Object.entries(fr).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
    if (sunf && sunf !== normal) days.forEach(d => { if (jsWd(Y, M, d) < 5 && fill(dateRow, dateCol + d - 1) === sunf) holi.add(d); });
  }
  return { Y, M, nDays, days, holi, issues };
}

/* ============================================================ 추출 */
function extractBook(book, fileName, opt = {}) {
  const { grid, maxRow, maxCol } = book;
  const cell = (r, c) => grid.get(r)?.get(c);
  const v = (r, c) => clean(cell(r, c)?.v);
  const raw = (r, c) => String(cell(r, c)?.v ?? '').trim();
  const fill = (r, c) => cell(r, c)?.fill || '';
  const dateRow = r0 => {
    for (let r = r0 + 1; r <= Math.min(r0 + 4, maxRow); r++) { const row = grid.get(r); if (!row) continue;
      for (const [c, x] of row) if (clean(x.v) === '1' && v(r, c + 1) === '2' && v(r, c + 2) === '3') return [r, c]; }
    return null;
  };
  let cands = [];
  for (let r = 1; r <= maxRow; r++) {
    for (let c = 1; c <= 6; c++) { const t = v(r, c);
      if (t.includes('근무표') && !t.startsWith('*') && !t.startsWith('근무표')) { const dr = dateRow(r); if (dr) cands.push({ r0: r, title: t, dateRow: dr[0], dateCol: dr[1] }); break; } }
  }
  for (let i = cands.length - 2; i >= 0; i--) if (cands[i + 1].r0 <= cands[i].dateRow) cands.splice(i, 1);
  if (!cands.length) throw new Error('"…근무표" 제목과 1·2·3 날짜 머리글을 찾지 못했습니다.');
  cands.forEach((s, i) => {
    s.end = (cands[i + 1]?.r0 ?? maxRow + 1) - 1;
    s.name = s.title.replace(/\s*전담\s*근무표.*$/, '').replace(/\s*근무표.*$/, '').trim();
    s.wdRow = s.dateRow + 1;
    s.key = (SECTION_RULES.find(([re]) => re.test(s.name.replace(/\s/g, ''))) || [0, 'GEN'])[1];
    s.excluded = EXCLUDE.test(s.name);
  });
  const S0 = cands[0];
  const { Y, M, nDays, days, holi, issues } = monthOf({ v, fill, sheetName: book.sheetName }, fileName, S0.dateRow, S0.dateCol, S0.wdRow, opt);

  const units = [];
  const mkUnit = (s, rows, name, key, kind, order, trailer) => {
    const dc = s.dateCol, nc = dc - 2, ic = dc - 1, lc = dc - 3, last = dc + nDays - 1;
    const nurseRows = rows.filter(r => v(r, nc));
    const parts = [];
    const rr = trailer ? range(s.r0, s.end) : rows;
    for (const r of rr) {
      if (/^pf\./i.test(v(r, lc)) && isDateSerial(cell(r, ic))) continue;
      const row = grid.get(r); if (!row) continue;
      for (const [c, x] of [...row].sort((a, b) => a[0] - b[0])) {
        if (x.v === '' || isDateSerial(x)) continue;
        const t = clean(x.v);
        if (r === s.r0 && t.includes('근무표')) continue;
        if ((r === s.dateRow || r === s.wdRow) && c >= dc && c <= last) continue;
        if (c === nc && nurseRows.includes(r)) continue;
        if (c >= dc && c <= last && nurseRows.includes(r)) continue;
        if (c === lc && /^\d+$/.test(t)) continue;
        if (c === ic && nurseRows.includes(r) && /^0\d{1,2}-\d{3,4}-\d{4}$/.test(t)) continue;
        if (c >= dc && /^(합계|\d+(\.0)?)$/.test(t)) continue;
        parts.push(t);
      }
    }
    const text = [];
    for (let r = s.r0; r <= s.end; r++) { const row = grid.get(r); if (!row) continue;
      for (const [c, x] of [...row].sort((a, b) => a[0] - b[0])) if (x.v !== '' && !(c >= dc && nurseRows.includes(r))) text.push(String(x.v)); }
    const nurses = nurseRows.map(r => ({
      name: v(r, nc), info: raw(r, ic),
      codes: days.map(d => raw(r, dc + d - 1)),
      marks: days.map(d => { const f = fill(r, dc + d - 1); return isYellow(f) ? 'Y' : isBlue(f) ? 'B' : ''; }),
    }));
    const extraInfo = rows.filter(r => !nurseRows.includes(r) && /^\d+$/.test(v(r, lc))).map(r => clean(raw(r, ic))).filter(Boolean);
    const cover = {};
    for (let r = s.wdRow + 1; r <= s.end; r++) {
      const lab = v(r, lc), dv = cell(r, ic), pa = v(r, dc);
      if (/^pf\./i.test(lab) && isDateSerial(dv) && /PA/.test(pa)) {
        const dt = new Date(Date.UTC(1899, 11, 30) + (+dv.v) * 86400000);
        if (dt.getUTCFullYear() === Y && dt.getUTCMonth() + 1 === M) cover[dt.getUTCDate() + '|' + lab.replace(/^pf\.\s*/i, '')] = pa.replace(/^PA\s*/, '');
      }
    }
    const headerTypo = trailer ? days.filter(d => v(s.dateRow, dc + d - 1) !== String(d)) : [];
    units.push({ key, name, kind, order, nurses, memo: parts.join(' ¦ '), text: text.join('\n'), extraInfo, cover, headerTypo });
  };
  cands.forEach((s, si) => {
    if (s.excluded) return;
    const body = range(s.wdRow + 1, s.end);
    if (s.key === 'IM') {
      const lc = s.dateCol - 3; const blocks = []; let cur = null;
      for (const r of body) { const t = v(r, lc); if (/^M[A-Z]/.test(t)) { cur = { codes: raw(r, lc).split(/\s+/).filter(Boolean), rows: [] }; blocks.push(cur); } if (cur) cur.rows.push(r); }
      blocks.forEach((b, bi) => {
        const code = b.codes[0];
        const kind = ['MC', 'MH', 'MP', 'MG', 'MN'].includes(code) ? code : code === 'MD' ? 'MD' : 'GEN';
        mkUnit(s, b.rows, '내과 ' + b.codes.join('/'), 'IM:' + b.codes.join('/'), kind, si * 100 + bi, false);
      });
    } else mkUnit(s, body, s.name, s.key === 'GEN' ? 'GEN:' + s.name : s.key, s.key, si * 100, true);
  });
  return { Y, M, nDays, holidays: [...holi].sort((a, b) => a - b), units, issues,
           skipped: cands.filter(s => s.excluded).map(s => s.name), sourceName: fileName || '', sheetName: book.sheetName };
}
function range(a, b) { const o = []; for (let i = a; i <= b; i++) o.push(i); return o; }

/* ============================================================ 규칙 대조 */
const NUM_RE = /0\d{1,2}-\d{3,4}-\d{4}|(?<![\d:])\d{4,6}(?![\d:])/g;
/* 부서 수정본 엑셀에 번호 안내 메모가 없으면(근무표 칸만 있으면) 기존 메모·교수-PA 짝·대체표를 유지 */
const hasGuide = memo => /pf\s*\.?/i.test(memo) || [...memo.matchAll(NUM_RE)].length > 0;
function mergeRevised(old, neu) {
  const keptMemo = !hasGuide(neu.memo) && hasGuide(old.memo);
  const unit = { ...neu, key: old.key, name: old.name, kind: old.kind, order: old.order, ...(old.assign ? { assign: old.assign } : {}) };   // 날짜별 파트 배정표는 유지(근무 코드와 다르면 엔진이 ⚠)
  if (keptMemo) Object.assign(unit, { memo: old.memo, text: old.text, cover: old.cover, extraInfo: old.extraInfo });
  return { unit, keptMemo };
}
const NIGHT_MEMO = /(?:N\s*duty|Night|나이트)\s*[-:：]?\s*(?:0\d{1,2}-\d{3,4}-\d{4}|\d{4})/i;
const PF_RE = /pf\s*\.?\s*([가-힣]{2,4}(?:\s*,\s*(?:pf\s*\.?\s*)?[가-힣]{2,4})*)/gi;
function cfgNames(k, cfg) {
  const c = cfg[k] || {}; const s = new Set();
  const add = a => a.forEach(x => s.add(x));
  if (k === 'MH') { add(c.oncoProf); Object.values(c.hem).forEach(t => add(t[0])); }
  if (k === 'MG') c.weekday.forEach(t => add(t[1]));
  if (k === 'MN') c.profs.forEach(t => s.add(t[0]));
  if (k === 'PEDS') { add(c.A[0]); add(c.B[0]); }
  if (k === 'NEURO') [c.day, c.night].forEach(o => Object.values(o).forEach(add));
  if (k === 'NS') [c.two, c.three].forEach(o => Object.values(o).forEach(add));
  if (k === 'GSW') c.teams.forEach(t => add(t[1]));
  if (k === 'CVS') c.profs.forEach(t => s.add(t[1]));
  return s;
}
function ruleCheck(unit, cfg) {
  const k = unit.key.startsWith('IM:') ? unit.key.split(':')[1].split('/')[0] : unit.key;
  if (LIVE.has(k) || (!cfg[k] && k !== 'MD') || k.startsWith('GEN')) return [];
  const out = [], memo = unit.memo;
  const norm = x => x.startsWith('0') ? x : x.replace(/\D/g, '').slice(-4);
  const ign = new Set((cfg._ignore || {})[k] || []);
  const mn = new Set([...memo.matchAll(NUM_RE)].map(m => m[0]).filter(x => !ign.has(x)).map(norm));
  // old = 지난 날짜에만 쓰는 옛 규칙, from = 새 규칙 시작일 → 지금 메모와 비교하지 않음
  const cn = new Set([...JSON.stringify(cfg[k] || {}, (key, v) => key === 'old' || key === 'from' ? undefined : v).matchAll(NUM_RE)].map(m => m[0]).map(norm));
  [...mn].filter(x => !cn.has(x)).sort().forEach(x => out.push(`메모에 있는 번호 ${x}가 규칙에 없음`));
  [...cn].filter(x => !mn.has(x)).sort().forEach(x => out.push(`규칙의 번호 ${x}가 메모에서 사라짐`));
  const names = cfgNames(k, cfg);
  // 메모에 교수 명단이 아예 없으면(번호 안내만 있는 수정본) 명단 대조는 건너뜀
  if (/pf/i.test(memo)) [...names].sort().forEach(p => { if (!memo.includes(p)) out.push(`규칙의 교수 ${p}가 메모에 없음`); });
  if (k !== 'NS' && names.size) {
    const pf = new Set();
    for (const m of memo.matchAll(PF_RE)) m[1].split(/\s*,\s*(?:pf\s*\.?\s*)?/i).forEach(n => n.trim() && pf.add(n.trim()));
    [...pf].filter(p => !names.has(p)).sort().forEach(p => out.push(`메모의 교수 ${p}가 규칙에 없음`));
  }
  return out;
}

/* ============================================================ 계산 */
function compute(data) {
  const cfg = data.cfg || DEFAULT_CFG;
  if (!cfg) throw new Error("번호 규칙이 없습니다 (기존 근무표를 먼저 불러오세요)");
  const days = Array.from({ length: data.nDays }, (_, i) => i + 1);
  const holi = new Set(data.holidays);
  const cx = { Y: data.Y, M: data.M, days, holi, rows: [], excluded: [], rank: new Map(), wd: d => jsWd(data.Y, data.M, d) };
  const changed = [];
  for (const u of data.units) {
    const h = helper(cx, u, cfg);
    (H[u.kind] || H.GEN)(cx, h, cfg);
    if (u.headerTypo && u.headerTypo.length) cx.rows.forEach(r => { if (r.unit === u.key && u.headerTypo.includes(r.d) && !String(r.workers).includes('미입력')) warn(r, '원본 날짜 머리글 오기 → 열 위치 기준 처리'); });
    const probs = ruleCheck(u, cfg);
    const nm = NIGHT_MEMO.exec(u.memo);
    if (nm && !cx.rows.some(r => r.unit === u.key && /^Night|^N\d/.test(r.shift))) probs.push(`메모에 야간 번호(${nm[0].trim()})가 있는데 Night 줄이 없음 → 시간대 규칙 확인`);
    if (probs.length) { changed.push({ key: u.key, name: u.name, probs }); cx.rows.forEach(r => { if (r.unit === u.key) warn(r, '원본 메모와 번호 규칙이 어긋남 → 확인 필요'); }); }
  }
  for (const [k, w] of Object.entries(data.manualWarn || {})) cx.rows.forEach(r => { if (r.unit === k) warn(r, w); });
  cx.rows.sort((a, b) => a.d - b.d || cmp(a.sort, b.sort));
  return { rows: cx.rows, excluded: cx.excluded, changed };
}
const cmp = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };
function warn(r, w) { r.warn = r.warn ? r.warn + ' / ' + w : w; }

function helper(cx, u, cfg) {
  const nm = n => n.name;
  const base = n => n.name.replace(/\(.*\)/, '').trim();
  const phone = n => (PHONE.exec(n.info) || [''])[0];
  const code = (n, d) => { const c = n.codes[d - 1] || ''; return [c.replace(/★/g, '').trim(), c.includes('★')]; };
  const mark = (n, d) => n.marks ? n.marks[d - 1] || '' : '';
  const coord = n => n.name.includes('코디');
  const byShift = (d, list, fn = dn) => {
    const o = { D: [], E: [], N: [] };
    for (const n of list) { const [c, star] = code(n, d); const p = fn(c); if (p && o[p[0]]) o[p[0]].push({ name: nm(n), t: p[1], n, star }); }
    return o;
  };
  const add = (d, team, prof, shift, number, workers, note = '', w = '', k = [0, 0]) => {
    if (Array.isArray(workers)) workers = workers.length ? workers.join(', ') : '(근무자 없음)';
    prof = prof || '-';
    const si = { Day: 0, Evening: 1, Night: 2 }[shift.split('(')[0]] ?? 3;
    const rk = u.key + '\u0000' + prof;
    if (!cx.rank.has(rk)) cx.rank.set(rk, cx.rank.size);
    cx.rows.push({ d, dept: u.name, unit: u.key, team, prof, shift, number, workers, note, warn: w, sort: [u.order, cx.rank.get(rk), k[0], k[1], si] });
  };
  const coords = (d, note = 'PA call 업무 안 받음') => {
    for (const n of u.nurses) {
      if (!coord(n)) continue; const [c] = code(n, d);
      if (!/^(X\d+|D\d+|DZ|DO|D0)$/.test(c)) continue;
      const nums = (n.info.match(EXT_G) || []).join(', ') || '(번호 원본에 없음)';
      const lab = clean(n.info.replace(EXT_G, '').replace(/내선번호/g, '')) || '코디';
      add(d, '코디 ' + lab, '-', c, nums, nm(n), note, '', [90, 0]);
    }
  };
  return { u, nm, base, phone, code, mark, coord, byShift, add, coords, nurses: u.nurses };
}

// 내과 MG: 부서가 날짜마다 "파트별 담당 간호사" 배정표를 줄 때(u.assign = { days: { 일: { D: {'A1': [이름], 'A2+A2-1': [이름] …}, E: {…}, N: [이름] } } })
// 칸이 합쳐져 한 사람이 팀 전체를 맡으면 단독 번호(v2.solo), 파트가 나뉘면 D 기준 파트 번호(v2.D). E도 같은 기준(메모: "E 근무: A 단독 근무시 4925 …")
// v2.parts = [{ from: 'YYYY-MM-DD', A1: [교수], A2: […], 'A2-1': […], B: […], C: […] }] — 날짜별 교수 소속(병가 등)
// day.warn = { 'E:B': '확인할 점' } — 그 근무·팀 줄에 ⚠ (배정표와 근무 코드가 어긋날 때 등)
const MG_TEAM = { A1: 'A1(GI)', A2: 'A2(GI)', 'A2-1': 'A2-1', B: 'B(Liver)', C: 'C(Biliary)' };
function mgAssign(cx, h, v) {
  const ymd = d => `${cx.Y}-${String(cx.M).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  for (const d of cx.days) {
    const day = h.u.assign.days?.[d]; if (!day) continue;
    const per = v.parts.filter(p => p.from <= ymd(d)).pop() || v.parts[0];
    const parts = Object.keys(MG_TEAM).filter(k => per[k]?.length);
    for (const t of 'DE') {
      const cells = Object.entries(day[t] || {}).map(([k, names]) => ({ parts: k.split('+'), names }));
      // 배정표의 사람과 근무 코드(그날 D/E)가 다르면 그 근무 전체를 확인 필요로(나중에 근무 코드만 바뀐 경우 등)
      const coded = h.nurses.filter(n => !h.coord(n) && h.code(n, d)[0] === t).map(n => n.name), listed = cells.flatMap(x => x.names);
      const off = listed.filter(x => !coded.includes(x)), miss = coded.filter(x => !listed.includes(x));
      const mis = off.length || miss.length ? `배정표와 근무 코드가 다름(${[off.length && '배정표에만: ' + off.join(', '), miss.length && '근무 코드에만: ' + miss.join(', ')].filter(Boolean).join(' / ')}) → 확인 필요` : '';
      parts.forEach((pt, ti) => per[pt].forEach((p, pi) => {
        const cell = cells.find(x => x.parts.includes(pt)), kk = [ti, pi], team = MG_TEAM[pt], L = pt[0];
        if (!cell || !cell.names.length) return h.add(d, team, p, SHN[t], UNK, [], '', `${SHN[t]} ${pt} 담당 없음`, kk);
        const w = cell.names, teamParts = parts.filter(x => x[0] === L), dw = day.warn?.[`${t}:${L}`] || day.warn?.[`${t}:${pt}`] || mis;
        // 확인할 점이 있는 칸은 번호를 확정하지 않음(알수없음 + 추정)
        const add = (num, note, wn) => h.add(d, team, p, SHN[t], dw && !String(num).startsWith(UNK) ? unknown(num) : num, w, note, [dw, wn].filter(Boolean).join(' / '), kk);
        // 팀 전체를 한 칸(한 사람)이 맡음 → 단독 번호
        if (w.length === 1 && teamParts.every(x => cell.parts.includes(x))) return add(v.solo[L], `${L}팀 단독 근무`, '');
        let num = L === 'B' ? (v.D.B[p] || null) : v.D[cell.parts[0]];
        if (L === 'C') num = w.length === 1 ? v.solo.C : v.D.C;
        const note = `파트별 번호(D 기준)${t === 'E' ? ' · E도 단독이 아니라 D 기준' : ''}${cell.parts.length > 1 ? ` · ${cell.parts.join('·')} 함께 담당` : ''}`;
        if (!num) add(unknown(v.D[pt === 'A2-1' ? 'A2' : pt] || v.solo[L]), note, `${pt} 번호가 메모에 없음 → 확인 필요`);
        else add(num, note, w.length > 2 ? `${pt} ${w.length}명` : '');
      }));
    }
    const nw = day.N || [];
    parts.forEach((pt, ti) => per[pt].forEach((p, pi) => h.add(d, MG_TEAM[pt], p, 'Night', nw.length === 1 ? v.night : unknown(v.night), nw, 'Night 1인 근무 - 팀 구분 없이 같은 번호', nw.length === 1 ? '' : `Night ${nw.length}인`, [ti, pi])));
    h.coords(d, '항암처방·교육 문의 · PA call X');
  }
}
const H = {
  MC(cx, h, cfg) {
    const c = cfg.MC, rows = h.nurses.filter(n => !h.coord(n));
    for (const d of cx.days) {
      const sh = h.byShift(d, rows);
      for (const t of 'DEN') {
        const w = sh[t].map(x => x.name); if (!w.length) continue; const n = w.length;
        const rule = t === 'N' ? { 1: c.N1 } : cx.holi.has(d) ? { 1: c.holi1, 2: c.holi2 } : { 2: c.wd2, 3: c.wd3 };
        if (rule[n]) h.add(d, '병동', '교수 구분 없음', SHN[t], rule[n], w, `${n}인 근무`);
        else h.add(d, '병동', '교수 구분 없음', SHN[t], unknown(c.wd3), w, `${n}인 근무`, `${cx.holi.has(d) ? '주말·공휴일' : '평일'} ${SHN[t]} ${n}인 - 원본에 이 인원수 규칙 없음`);
      }
      h.coords(d);
    }
  },
  MH(cx, h, cfg) {
    const c = cfg.MH, rows = h.nurses.filter(n => !h.coord(n));
    const hs = rows.findIndex(n => /(^|\n)\s*A\s*[\(:]/.test(n.info));
    const onco = hs < 0 ? rows : rows.slice(0, hs), hem = hs < 0 ? [] : rows.slice(hs);
    const allp = []; 'ABC'.split('').forEach(t => c.hem[t][0].forEach(p => allp.push([t, p])));
    for (const d of cx.days) {
      const so = h.byShift(d, onco);
      for (const t of 'DEN') {
        const w = so[t].map(x => x.name); if (!w.length) continue; const n = w.length;
        c.oncoProf.forEach((p, pi) => {
          if (c.onco[n]) h.add(d, 'Oncology', p, SHN[t], c.onco[n], w, `${n}인 근무 · Onco 개인폰 연락 X`, '', [0, pi]);
          else h.add(d, 'Oncology', p, SHN[t], unknown(c.onco[4]), w, `${n}인 근무`, `Onco ${SHN[t]} ${n}인 - 원본 규칙은 1~4인`, [0, pi]);
        });
      }
      const sh = h.byShift(d, hem);
      const teamed = sh.D.filter(x => x.t && 'ABC'.includes(x.t)); let plain = sh.D.filter(x => !x.t || !'ABC'.includes(x.t));
      const letters = teamed.map(x => x.t); const all3 = ['A', 'B', 'C'].every(t => letters.includes(t));
      if (!cx.holi.has(d) && all3) { plain.forEach(x => cx.excluded.push([d, h.u.name, x.name, '평일 A/B/C팀 외 추가 D 근무 → 제외(사용자 지침)'])); plain = []; }
      'ABC'.split('').forEach((t, ti) => {
        const [profs, num] = c.hem[t]; const ws = teamed.filter(x => x.t === t).map(x => x.name);
        profs.forEach((p, pi) => {
          const kk = [10 + ti, pi];
          if (ws.length) h.add(d, `Hemato ${t}팀`, p, 'Day', num, ws, '', ws.length > 1 ? `같은 날 ${t}팀 Day ${ws.length}명` : '', kk);
          else if (plain.length) h.add(d, `Hemato ${t}팀`, p, 'Day', unknown(c.guess), plain.map(x => x.name), `팀 글자 없는 D 근무 · 추정 근거: Hemato 1인 근무 번호(N 1인 ${c.hemN1})`, `${cx.holi.has(d) ? '주말·공휴일' : '평일'} Day 팀 미표기 - 번호 확인 필요`, kk);
          else if (!cx.holi.has(d) && teamed.length) h.add(d, `Hemato ${t}팀`, p, 'Day', UNK, [], '', `평일인데 ${t}팀 Day 근무자 없음`, kk);
        });
      });
      for (const [t, lab] of [['E', 'Evening'], ['N', 'Night']]) {
        const w = sh[t].map(x => x.name); if (!w.length) continue;
        allp.forEach(([tm, p], pi) => {
          const kk = [10 + 'ABC'.indexOf(tm), pi];
          if (t === 'E') {
            if (w.length === 2) h.add(d, `Hemato ${tm}팀`, p, lab, c.hemE2, w, '2인 근무(팀 구분 없이 두 번호)', '', kk);
            else h.add(d, `Hemato ${tm}팀`, p, lab, unknown(w.length === 1 ? c.guess : c.hemE2), w, `${w.length}인 근무`, `Evening ${w.length}인 - 원본 규칙은 2인 기준만 있음`, kk);
          } else {
            if (w.length === 1) h.add(d, `Hemato ${tm}팀`, p, lab, c.hemN1, w, '1인 근무', '', kk);
            else h.add(d, `Hemato ${tm}팀`, p, lab, unknown(c.hemN1), w, `${w.length}인 근무`, `Night ${w.length}인 - 원본 규칙은 1인 기준만 있음`, kk);
          }
        });
      }
      h.coords(d, '항암 낮병동 환자만 · PA call X');
    }
  },
  MP(cx, h, cfg) {
    const rows = h.nurses.filter(n => !h.coord(n));
    for (const d of cx.days) {
      const sh = h.byShift(d, rows);
      for (const t of 'DEN') {
        const w = sh[t].map(x => x.name); if (!w.length) continue;
        if (cfg.MP[w.length]) h.add(d, '호흡기 병동', '교수 구분 없음', SHN[t], cfg.MP[w.length], w, `${w.length}인 근무 · 병동환자/병동협진만`);
        else h.add(d, '호흡기 병동', '교수 구분 없음', SHN[t], unknown(cfg.MP[2]), w, `${w.length}인 근무`, `${SHN[t]} ${w.length}인 - 원본 규칙은 1·2인만`);
      }
      h.coords(d);
    }
  },
  MG(cx, h, cfg) {
    const c = cfg.MG, rows = h.nurses.filter(n => !h.coord(n));
    if (h.u.assign && c.v2) return mgAssign(cx, h, c.v2);
    for (const d of cx.days) {
      const sh = h.byShift(d, rows);
      for (const t of 'DEN') {
        const w = sh[t].map(x => x.name); if (!w.length) continue;
        c.weekday.forEach(([team, profs, num], ti) => profs.forEach((p, pi) => {
          const kk = [ti, pi];
          if (t === 'N') {
            if (w.length === 1) h.add(d, team, p, 'Night', c.night, w, 'Night 1인 근무 - 팀 구분 없이 같은 번호', '', kk);
            else h.add(d, team, p, 'Night', unknown(c.night), w, `${w.length}인`, `Night ${w.length}인 - 원본 규칙은 N 1인만`, kk);
          } else if (cx.holi.has(d)) { const [ht, hn] = c.holi[team]; h.add(d, ht, p, SHN[t], hn, w, '주말·공휴일 팀 기준 · 근무표에 팀 표기 없어 근무자 전체 표시', '', kk); }
          else h.add(d, team, p, SHN[t], num, w, '근무표에 팀 표기 없어 근무자 전체 표시', '', kk);
        }));
      }
      h.coords(d, '항암처방·교육 문의 · PA call X');
    }
  },
  MN(cx, h, cfg) {
    const c = cfg.MN, rows = h.nurses.filter(n => !h.coord(n));
    for (const d of cx.days) {
      const sh = h.byShift(d, rows);
      for (const t of 'DEN') {
        const w = sh[t].map(x => x.name); if (!w.length) continue;
        c.profs.forEach(([p, num], pi) => {
          if (t === 'N' || cx.holi.has(d)) h.add(d, '신장내과', p, SHN[t], c.night, w, '신장내과 당직 번호', '', [0, pi]);
          else h.add(d, '신장내과', p, SHN[t], num, w, c.note, '', [0, pi]);
        });
      }
    }
  },
  MD(cx, h, cfg) {
    for (const d of cx.days) { const sh = h.byShift(d, h.nurses);
      for (const t of 'DEN') { const w = sh[t].map(x => x.name); if (w.length) h.add(d, '-', '교수 구분 없음', SHN[t], cfg.MD.num, w, '컨설트 푸시는 근무자에게 문자'); } }
  },
  URO(cx, h, cfg) {
    const T = { X7: 'D0(7-3)', D0: 'D0(7-3)', X8: 'X8(8-4)', X9: 'X9(9-5)', E0: 'E0(2-10)' };
    for (const d of cx.days) {
      const ward = { D: [], E: [] }, rest = new Map();
      for (const n of h.nurses) {
        const [c] = h.code(n, d); if (!T[c]) continue; const y = h.mark(n, d) === 'Y';
        if (y && (c === 'D0' || c === 'X7')) ward.D.push(n.name); else if (y && c === 'E0') ward.E.push(n.name);
        else { if (!rest.has(T[c])) rest.set(T[c], []); rest.get(T[c]).push(n.name); }
      }
      const wd = cx.wd(d);
      for (const [t, lab] of [['D', 'Day(7-3)'], ['E', 'Evening(2-10)']]) {
        let w = '';
        if (ward[t].length > 1) w = `노란색 ${lab} 근무자 ${ward[t].length}명`;
        else if (ward[t].length && wd === 6) w = '일요일인데 노란색 근무자 있음';
        else if (ward[t].length && t === 'E' && wd === 5) w = '토요일 Primary call은 7AM-3PM인데 Evening 노란색 근무자 있음';
        if (ward[t].length) h.add(d, '병동 전담(Primary call)', '교수 구분 없음', lab, cfg.URO.primary, ward[t], '노란색 표시 근무자 · 평일 7AM-10PM, 토 7AM-3PM 외에는 담당교수 direct', w);
        else if (!cx.holi.has(d)) h.add(d, '병동 전담(Primary call)', '교수 구분 없음', lab, UNK, [], '', `평일인데 Primary call ${lab} 노란색 근무자 없음`);
      }
      if (!ward.D.length && !ward.E.length && cx.holi.has(d)) h.add(d, '병동 전담(Primary call)', '교수 구분 없음', '-', '담당교수 direct call', '-', 'Primary call 운영시간 외(주말·공휴일)');
      for (const [lab, w] of rest) h.add(d, '외래/코디 등', '-', lab, '', w, '개별 번호 원본에 없음', '', [5, 0]);
    }
  },
  OBGY(cx, h, cfg) {
    const c = cfg.OBGY;
    for (const d of cx.days) {
      const sh = h.byShift(d, h.nurses);
      for (const t of 'DEN') {
        const g = {}; sh[t].forEach(x => (g[x.t] = g[x.t] || []).push(x.name));
        'ABC'.split('').forEach((tm, ti) => {
          const [part, num] = c[tm];
          if (g[tm]) h.add(d, `${part} (${tm.toLowerCase()})`, '교수 구분 없음', SHN[t], num, g[tm], c.note, g[tm].length > 1 ? `${part} ${SHN[t]} ${g[tm].length}명` : '', [ti, 0]);
          else if (tm === 'C') h.add(d, 'Acting (c)', '교수 구분 없음', SHN[t], `${c.Cabsent} (acting 부재 시)`, '(Acting 근무자 없음)', `원본: ER call은 acting(${num}), 부재 시 ${c.Cabsent}`, '', [ti, 0]);
          else h.add(d, `${part} (${tm.toLowerCase()})`, '교수 구분 없음', SHN[t], UNK, [], '', `${part} ${SHN[t]} 근무자 없음`, [ti, 0]);
        });
        if (g['']) h.add(d, '팀 미표기', '-', SHN[t], UNK, g[''], '', '팀 글자(a/b/c) 없음', [5, 0]);
      }
    }
  },
  PEDS(cx, h, cfg) {
    // 2026-10-15부터(c.sp.from) 메모: 평일 SP(10am~6pm) 근무자가 있으면 4728 = ER·병동 신환, 4726 = A/B팀 part(SP 퇴근 후 ER도)
    // SP 근무자가 없으면 A팀 4726 / B팀 4728. 주말·나이트는 새 메모에 없음 → A는 옛 규칙과 같아 4726, B는 알수없음(추정 4728)
    // 그 전 날짜는 c.old(옛 규칙: B 4725, 주말·나이트 4726)
    const c = cfg.PEDS, sp = c.sp, ymd = d => `${cx.Y}-${String(cx.M).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    for (const d of cx.days) {
      const sh = h.byShift(d, h.nurses), isNew = sp && ymd(d) >= sp.from, old = isNew ? null : c.old || { B: c.B[1], night: c.night };
      const spW = h.nurses.filter(n => h.code(n, d)[0] === 'SP').map(n => n.name), wkday = !cx.holi.has(d);
      for (const t of 'DEN') {
        const w = sh[t].map(x => x.name); if (!w.length) continue;
        ['A', 'B'].forEach((tm, ti) => c[tm][0].forEach((p, pi) => {
          if (!isNew) {
            if (t === 'N' || !wkday) h.add(d, `${tm}팀`, p, SHN[t], old.night, w, '주말·나이트 번호', '', [ti, pi]);
            else h.add(d, `${tm}팀`, p, SHN[t], tm === 'B' ? old.B : c.A[1], w, '근무표에 팀 표기 없어 근무자 전체 표시 · first call로 연락하면 전달', '', [ti, pi]);
          } else if (t === 'N' || !wkday) {
            if (tm === 'A') h.add(d, 'A팀', p, SHN[t], c.A[1], w, '주말·나이트 · A팀 part', '', [ti, pi]);
            else h.add(d, 'B팀', p, SHN[t], unknown(c.B[1]), w, '추정 근거: SP 없을 때 B팀 part ' + c.B[1], '10/15 새 메모에 주말·나이트 B팀 번호 없음(옛 규칙은 4726) → 확인 필요', [ti, pi]);
          } else if (spW.length) h.add(d, `${tm}팀`, p, SHN[t], sp.part, w, `SP 근무일 · A·B팀 part call ${sp.part} (ER·병동 신환은 SP ${sp.er})`, '', [ti, pi]);
          else h.add(d, `${tm}팀`, p, SHN[t], c[tm][1], w, 'SP 없는 날 · 팀별 part 번호 · 팀 표기 없어 근무자 전체 표시', '', [ti, pi]);
        }));
      }
      if (isNew && wkday && spW.length) {
        h.add(d, 'ER·병동 신환', '교수 구분 없음', 'Day', sp.er, spW, 'SP(10am~6pm) · ER call·병동 신환 call', '', [5, 0]);
        h.add(d, 'ER·병동 신환', '교수 구분 없음', 'Evening', sp.er, spW, `6pm까지 SP ${sp.er} · SP 퇴근 후 ER call은 ${sp.part}`, '', [5, 0]);
      }
    }
  },
  NEURO(cx, h, cfg) {
    const c = cfg.NEURO, rows = h.nurses.filter(n => !h.coord(n));
    for (const d of cx.days) {
      const sh = h.byShift(d, rows);
      for (const t of 'DEN') {
        if (!sh[t].length) continue;
        const night = t === 'N' || cx.holi.has(d), P = night ? c.night : c.day;
        'ABCD'.split('').forEach((tm, ti) => {
          if (!P[tm]) return;
          const ws = sh[t].filter(x => x.t === tm).map(x => x.name);
          P[tm].forEach((p, pi) => {
            const w = !ws.length ? `${SHN[t]} ${tm}팀 근무자 없음` : ws.length > 1 ? `같은 근무에 ${tm}팀 ${ws.length}명` : '';
            h.add(d, `${tm}팀`, p, SHN[t], ws.length ? c.num[tm] : UNK, ws, '', w, [ti, pi]);
          });
        });
        for (const x of sh[t]) if (!x.t || (x.t === 'D' && night))
          h.add(d, '팀 확인 필요', '-', SHN[t], x.t ? unknown(c.num[x.t] || '-') : UNK, x.name, '', x.t ? 'Night·주말엔 D팀이 없는데 d 표기' : '팀 글자 없음', [8, 0]);
      }
      for (const n of h.nurses) if (h.coord(n) && ['DO', 'D0'].includes(h.code(n, d)[0])) h.add(d, '코디', '-', 'D0', '(번호 원본에 없음)', n.name, '', '', [90, 0]);
    }
  },
  NS(cx, h, cfg) {
    const c = cfg.NS, fn = x => x === 'D**' ? ['D', '**'] : dn(x);
    for (const d of cx.days) {
      const sh = h.byShift(d, h.nurses, fn);
      for (const t of 'DEN') {
        if (!sh[t].length) continue;
        const callers = sh[t].filter(x => x.t !== '**'), letters = callers.map(x => x.t).sort(), three = letters.includes('C');
        let bad = '';
        if (callers.length) {
          if (three && letters.join('') !== 'ABC') bad = `c팀이 있는데 구성 ${letters.join('/')}(${callers.length}명) - 3인 기준과 다름`;
          if (!three && letters.join('') !== 'AB') bad = `구성 ${letters.join('/') || '-'}(${callers.length}명) - 2인(a/b) 기준과 다름`;
        }
        const P = three ? c.three : c.two;
        Object.keys(P).sort().forEach((tm, ti) => {
          const xs = callers.filter(x => x.t === tm);
          P[tm].forEach((p, pi) => {
            if (xs.length) h.add(d, `${tm}팀`, p, SHN[t], xs.map(x => h.phone(x.n) || '(번호 없음)').join(', '), xs.map(x => x.name), `${three ? 3 : 2}인 근무 배정 · ${c.note}`, bad, [ti, pi]);
            else h.add(d, `${tm}팀`, p, SHN[t], UNK, [], '', bad || `${SHN[t]} ${tm}팀 근무자 없음`, [ti, pi]);
          });
        });
        for (const x of sh[t]) if (x.t === '**') h.add(d, 'CPFT(당일입원실 검사)', '-', SHN[t], h.phone(x.n), x.name, 'D** - call 받지 않음', cx.wd(d) === 2 ? '' : 'D**는 수요일 규칙인데 수요일이 아님', [8, 0]);
      }
    }
  },
  EYE(cx, h) {
    const m = mapPA(h.u.text, /(?:^|\n)\s*\d*\.?\s*([가-힣A-Za-z]{2,5})\s*:\s*([^\n]+)/g);
    const pairs = []; for (const [pa, txt] of m) { const g = /pf\.?\s*([가-힣]{2,4})/.exec(txt); if (g) pairs.push(['-', g[1], pa]); }
    for (const d of cx.days) {
      const on = profPA(cx, h, d, pairs, c => c === 'D0', null, 'D0(8:30-4:30)');
      for (const [pa, txt] of m) if (on.has(pa) && !/pf/.test(txt)) h.add(d, clean(txt), '-', 'D0(8:30-4:30)', h.phone(on.get(pa)), pa, '', '', [50, 0]);
    }
  },
  PS(cx, h, cfg) {
    const m = mapPA(h.u.text, /([^\n:]*oncall[^\n:]*?)\s*:\s*([가-힣]{2,4})/g, true);
    const pairs = []; for (const [pa, lab] of m) { const g = /pf\s*\.?\s*([가-힣]{2,4})/.exec(lab); pairs.push([g ? '수술' : clean(lab).replace('oncall', '').trim(), g ? g[1] : '교수 구분 없음', pa]); }
    const teamOf = pa => (pairs.find(p => p[2] === pa) || [''])[0];
    const cover = (d, prof, pa, on) => {
      if (teamOf(pa).includes('병동')) { const s = [...m].find(([, l]) => l.includes('욕창')); if (s && on.has(s[0])) return [s[0], '병동 OFF → 욕창 파트 call (원본 규칙)']; }
      if (teamOf(pa).includes('욕창')) { const pf = cfg.PS?.woundOffProf, s = pf && [...m].find(([, l]) => l.includes(pf)); if (s && on.has(s[0])) return [s[0], `욕창 OFF → pf.${pf} 파트 call (원본 규칙)`]; }
      return null;
    };
    for (const d of cx.days) profPA(cx, h, d, pairs, c => /^(D0|X0?\d{1,2})$/.test(c), cover);
  },
  // 원본 메모: Day(7am~3pm)·Evening(3pm~10:30pm)은 팀(Part) 번호, Night(10:30pm~7am)는 N duty 번호 하나
  GSW(cx, h, cfg) {
    const c = cfg.GSW, has = h.nurses.some(n => n.codes.some(Boolean));
    if (has) {
      // 근무 코드: D/E + 팀 글자 + 파트 숫자(Da1 = A1 파트). 숫자 없는 Ea = 그 팀 전체(두 파트) 담당. Dx는 call 안 받음. N = N duty
      const sh = (d, t) => h.nurses.map(n => [n, h.code(n, d)[0]]).filter(([, x]) => x[0] === t);
      for (const d of cx.days) {
        for (const t of 'DE') {
          const list = sh(d, t).map(([n, x]) => [n.name, /^[DE]([abc])([12])?$/i.exec(x), x]);
          c.teams.forEach(([team, profs, num], ti) => {
            const tl = team[0].toLowerCase(), part = team.slice(1);
            const own = list.filter(([, m]) => m && m[1].toLowerCase() === tl && m[2] === part).map(x => x[0]);
            const whole = list.filter(([, m]) => m && m[1].toLowerCase() === tl && !m[2]).map(x => x[0]);
            const ws = own.length ? own : whole;
            const note = ['Part call · 병동 전담은 ER call 안 받음', !own.length && whole.length ? `${team[0]}팀 1명이 ${team[0]}1·${team[0]}2 함께 담당` : '', own.length && whole.length ? `${team[0]}팀 추가 근무: ${whole.join(', ')}` : ''].filter(Boolean).join(' · ');
            const odd = list.filter(([, m, x]) => !m && x !== 'Dx').map(([nm, , x]) => `${nm}(${x})`);
            const w = !ws.length ? `${SHN[t]} ${team} 근무자 없음${odd.length ? ` · 팀 표기 없는 근무 ${odd.join(', ')}` : ''} → 확인 필요` : ws.length > 1 ? `같은 근무에 ${team} ${ws.length}명` : '';
            profs.forEach((p, pi) => h.add(d, team, p, SHN[t], num, ws, note, w, [ti, pi]));
          });
        }
        const nw = sh(d, 'N').filter(([, x]) => x === 'N').map(([n]) => n.name);
        c.teams.forEach(([team, profs], ti) => profs.forEach((p, pi) =>
          h.add(d, team, p, 'Night', c.night, nw, 'Night는 팀 구분 없이 N duty', nw.length === 1 ? '' : nw.length ? `Night ${nw.length}명` : 'Night 근무자 없음', [ti, pi])));
      }
      return;
    }
    const w = '(이번 달 근무표 미입력)';
    for (const d of cx.days) {
      // 교수마다 Night 줄도 만든다(교수 찾기·이름 검색에서 Night 번호가 보이도록)
      c.teams.forEach(([team, profs, num], ti) => profs.forEach((p, pi) => {
        for (const t of 'DE') h.add(d, team, p, SHN[t], num, w, 'Part call · 병동 전담은 ER call 안 받음', '', [ti, pi]);
        h.add(d, team, p, 'Night', c.night, w, 'Night는 팀 구분 없이 N duty', '', [ti, pi]);
      }));
    }
  },
  ENT(cx, h, cfg) {
    for (const d of cx.days) {
      const w = h.nurses.filter(n => /^X0?\d{1,2}$/.test(h.code(n, d)[0])).map(n => `${n.name}(${h.phone(n) || '번호 없음'})`);
      if (w.length) h.add(d, '-', '교수 구분 없음', '8am-4:30pm', `${cfg.ENT.first} (먼저)`, w, cfg.ENT.note);
    }
  },
  REHAB(cx, h) {
    const pairs = [...h.u.text.matchAll(/pf\.?\s*([가-힣]{2,4})\s*-\s*([가-힣]{2,4})(?=\s|$)/gi)].filter(g => g[2] !== '전공의').map(g => ['-', g[1], g[2]]);
    const res = /pf\.?\s*([가-힣]{2,4})\s*-\s*전공의\s*([가-힣]{2,4})[^\n]*\n?[^\n]*?(0\d{1,2}-\d{3,4}-\d{4})/i.exec(h.u.text);
    for (const d of cx.days) {
      profPA(cx, h, d, pairs, c => c === 'D0' || c === 'X10');
      if (res && !cx.holi.has(d)) h.add(d, '-', res[1], '전공의', res[3], `전공의 ${res[2]}`, '', '', [40, 0]);
    }
  },
  OS(cx, h) {
    const pairs = [...h.u.text.matchAll(/([가-힣A-Za-z]{2,6})\s*\(\s*pf\.?\s*([가-힣]{2,4})\s*\)/gi)].map(g => ['-', g[2], g[1]]);
    const cv = (d, prof) => { const x = h.u.cover[d + '|' + prof]; return x ? [x, `원본 날짜별 표: pf.${prof} 파트 → PA ${x}`] : null; };
    for (const d of cx.days) {
      profPA(cx, h, d, pairs, c => c === 'D0', cv, 'D0(8-4)');
      if (cx.holi.has(d)) continue;
      const stars = h.nurses.filter(n => { const [c, s] = h.code(n, d); return c === 'D0' && s; });
      if (stars.length === 1) h.add(d, '당직 PA(★)', '전체', '평일 4-6pm', h.phone(stars[0]), stars[0].name, '6pm~익일 7am 당직의 / 7~8am ER 주간 당직', '', [50, 0]);
      else h.add(d, '당직 PA(★)', '전체', '평일 4-6pm', UNK, stars.map(n => n.name), '', `평일인데 당직 PA(★) ${stars.length}명`, [50, 0]);
    }
  },
  DERM(cx, h) {
    for (const d of cx.days) for (const n of h.nurses) if (['D0', 'DO'].includes(h.code(n, d)[0])) h.add(d, '-', '교수 구분 없음', 'D0(8:30-4:30)', h.phone(n), n.name);
  },
  CVS(cx, h, cfg) {
    const c = cfg.CVS, sched = h.nurses.filter(n => n.codes.some(Boolean)), blank = h.nurses.filter(n => !sched.includes(n));
    for (const d of cx.days) {
      const sh = h.byShift(d, sched);
      for (const t of 'DEN') {
        const aicu = sh[t].filter(x => h.mark(x.n, d) === 'B').map(x => x.name), ward = sh[t].filter(x => h.mark(x.n, d) !== 'B').map(x => x.name);
        c.profs.forEach(([team, p, num, kind], i) => { const w = kind === 'aicu' ? aicu : ward; if (w.length) h.add(d, team, p, SHN[t], num, w, kind === 'aicu' ? '파란 배경 = AICU 근무자' : '병동 근무자 전체', '', [i, 0]); });
      }
      if (sh.D.length || sh.E.length || sh.N.length) h.add(d, '당일입원실', '교수 상관없음', '-', c.day_adm, '-', '타과 협진문의, ER', '', [60, 0]);
      const d0 = sched.filter(n => h.code(n, d)[0] === 'D0').map(n => n.name);
      if (d0.length) h.add(d, 'D0', '-', 'D0(7:30-3:30)', '', d0, '파트 원본에 명시 없음', '', [70, 0]);
      if (blank.length) h.add(d, 'OR', '-', '-', blank.map(n => clean(n.info)).filter(Boolean).join(' / '), '(이번 달 근무표 미입력)', blank.map(n => n.name).join(', '), '', [80, 0]);
    }
  },
  TS(cx, h, cfg) {
    const isor = n => n.info.includes('OR'), ward = h.nurses.filter(n => !isor(n));
    for (const d of cx.days) {
      const sh = h.byShift(d, ward);
      for (const t of 'DEN') { const w = sh[t].map(x => x.name); if (w.length) h.add(d, '병동', '교수 구분 없음', SHN[t], cfg.TS.num, w, 'TS로 call (CVS와 구분)'); }
      const x10 = ward.filter(n => h.code(n, d)[0] === 'X10').map(n => n.name); if (x10.length) h.add(d, 'SP(X10)', '-', 'X10(10-6)', '', x10, 'Acting 업무 관련', '', [5, 0]);
      const op = h.nurses.filter(n => isor(n) && h.code(n, d)[0] === 'D0').map(n => n.name); if (op.length) h.add(d, 'OR', '-', 'D0(7:30-3:30)', '', op, '', '', [6, 0]);
    }
  },
  ACT(cx, h, cfg) {
    const lab = { D: 'Day(7-3)', E: 'Evening(3-11)', N: 'Night(11-7)' };
    for (const d of cx.days) {
      const sh = h.byShift(d, h.nurses);
      for (const t of 'DEN') {
        ['A', 'B'].forEach((z, zi) => {
          const [name, num, zone] = cfg.ACT[z]; const w = sh[t].filter(x => x.t === z).map(x => x.name);
          if (w.length) h.add(d, `${name} (${z.toLowerCase()})`, '교수 구분 없음', lab[t], num, w, '담당: ' + zone, w.length > 1 ? `${name} ${lab[t]} ${w.length}명` : '', [zi, 0]);
          else h.add(d, `${name} (${z.toLowerCase()})`, '교수 구분 없음', lab[t], UNK, [], '', `${name} ${lab[t]} 근무자 없음`, [zi, 0]);
        });
        const p = sh[t].filter(x => !['A', 'B'].includes(x.t)).map(x => x.name);
        if (p.length) h.add(d, '구역 미표기', '-', lab[t], UNK, p, '', '구역 글자(a/b) 없음', [5, 0]);
      }
    }
  },
  GEN(cx, h) {
    const any = h.nurses.some(n => n.codes.some(Boolean));
    const infos = h.nurses.map(n => { const t = clean(n.info); return t && PHONE.test(t) && t.length < 20 ? `${n.name} ${t}` : t; });
    const summ = [...infos, ...(h.u.extraInfo || [])].filter(Boolean).join(' / ');
    for (const d of cx.days) {
      if (!any) { h.add(d, '-', '-', '-', summ, '(이번 달 근무표 미입력)'); continue; }
      const g = new Map();
      for (const n of h.nurses) { const [c] = h.code(n, d); if (c && !OFF.has(c.toUpperCase())) { if (!g.has(c)) g.set(c, []); g.get(c).push(n.name); } }
      for (const [c, w] of g) h.add(d, '-', '-', c, summ, w, '', '규칙 미등록 과 - 원본 메모로 번호 확인 필요');
    }
  },
};
function mapPA(text, re, rev) { const m = new Map(); for (const g of text.matchAll(re)) { const a = g[1].trim(), b = g[2].trim(); rev ? m.set(b, a) : m.set(a, b); } return m; }
function profPA(cx, h, d, pairs, work, cover, label) {
  const on = new Map();
  for (const n of h.nurses) { const [c] = h.code(n, d); if (work(c)) on.set(h.base(n), n); }
  pairs.forEach(([team, prof, pa], i) => {
    if (on.has(pa)) h.add(d, team, prof, label || h.code(on.get(pa), d)[0], h.phone(on.get(pa)) || '(번호 원본에 없음)', pa, '', '', [i, 0]);
    else if (cx.holi.has(d)) return;
    else {
      const cv = cover ? cover(d, prof, pa, on) : null;
      if (cv) h.add(d, team, prof, '대체', on.has(cv[0]) ? h.phone(on.get(cv[0])) : '', cv[0], cv[1], '', [i, 0]);
      else h.add(d, team, prof, '-', UNK, `${pa} 휴무`, '', `담당 PA(${pa}) 휴무 - 대체자 원본에 없음`, [i, 0]);
    }
  });
  return on;
}

/* 원자료 → 사람이 읽는 표(관리자 수정 미리보기·Claude 전달용) */
/* ============================================================ 당직표 (교수 당직)
 * "○○ 당직표" 구역 → 날짜 머리글(1·2·3…)마다 블록, 날짜 칸이 채워진 줄 = 당직 줄,
 * "이름 010-…" 칸 = 연락처(같은 열 위쪽 머리글 = 소속), "임상과장" = 과장, 나머지 글 = 메모.
 * 날짜 칸의 이름·코드(신경외과 J·H…)는 연락처와 이어 붙여 전화할 수 있게 한다. */
const DUTY_PHONE = /0\d{1,2}[-\s]?\d{3,4}[-\s]?\d{4}/;
function parseContact(t) {
  const m = DUTY_PHONE.exec(t); if (!m) return null;
  const phone = m[0].replace(/\D/g, '').replace(/^(0\d{1,2})(\d{3,4})(\d{4})$/, '$1-$2-$3');
  let pre = clean(t.slice(0, m.index)).replace(/[:：]\s*$/, ''), role = '', code = '';
  pre = pre.replace(/^(pf|f)\s*\.?\s*/i, x => { role = /^pf/i.test(x) ? 'Pf' : 'F'; return ''; });
  const r = /^(R\d)\s*/.exec(pre); if (r) { role = r[1]; pre = pre.slice(r[0].length); }
  const c = /^([A-Z]{1,2})\s+(?=[가-힣])/.exec(pre); if (c) { code = c[1]; pre = pre.slice(c[0].length); }
  const name = pre.replace(/\s+/g, '');
  if (!/^[가-힣]{2,4}[A-Z]?$/.test(name)) return null;
  return { name, phone, role, code, note: clean(t.slice(m.index + m[0].length)).replace(/^[-–]\s*/, '') };
}
const dutyKey = name => name.replace(/\s/g, '');
function extractDuty(book, fileName, opt = {}) {
  const { grid, maxRow } = book;
  const cell = (r, c) => grid.get(r)?.get(c);
  const v = (r, c) => clean(cell(r, c)?.v);
  const raw = (r, c) => String(cell(r, c)?.v ?? '').trim();
  const fill = (r, c) => cell(r, c)?.fill || '';
  const titles = [];
  for (let r = 1; r <= maxRow; r++) for (let c = 1; c <= 6; c++) { const t = v(r, c);
    if (/당직표\s*$/.test(t) && !t.startsWith('*')) { titles.push({ r0: r, name: t.replace(/\s*당직표\s*$/, '').trim() }); break; } }
  if (!titles.length) throw new Error('"○○ 당직표" 제목을 찾지 못했습니다.');
  const dateRowAt = r => { const row = grid.get(r); if (!row) return 0;
    for (const [c, x] of row) if (clean(x.v) === '1' && v(r, c + 1) === '2' && v(r, c + 2) === '3') return c; return 0; };
  let mi = null;
  const sections = titles.map((t, i) => {
    const end = (titles[i + 1]?.r0 ?? maxRow + 1) - 1;
    const blocks = [], used = new Set(), contacts = [], notes = [];
    let chief = '';
    for (let r = t.r0 + 1; r <= end; r++) { const dc = dateRowAt(r); if (!dc) continue;
      let n = 0; while (n < 31 && v(r, dc + n) === String(n + 1)) n++;
      const wd = WD.includes(v(r + 1, dc)[0] || '#') ? r + 1 : 0;
      if (!mi && wd) mi = monthOf({ v, fill, sheetName: book.sheetName }, fileName, r, dc, wd, opt);
      const sub = dc > 1 && v(r, dc - 1) && !/^\d+$/.test(v(r, dc - 1)) ? v(r, dc - 1) : '';
      blocks.push({ r, dc, n, wd, sub, rows: [] }); used.add(r); if (wd) used.add(wd);
    }
    // 당직 줄 = 날짜 머리글 바로 아래(빈 줄 2개까지 건너뜀)부터 이어지는 줄들. 빈 줄·*메모·연락처·임상과장에서 멈춤
    blocks.forEach((b, bi) => {
      const stop = (blocks[bi + 1]?.r ?? end + 1) - 1;
      let r = (b.wd || b.r) + 1, skip = 0;
      while (r <= stop && !v(r, b.dc - 1) && skip < 2) { r++; skip++; }
      for (; r <= stop; r++) {
        const label = v(r, b.dc - 1);
        if (!label || label.startsWith('*') || DUTY_PHONE.test(label) || /^임상과장/.test(label)) break;
        const cells = Array.from({ length: b.n }, (_, k) => raw(r, b.dc + k).replace(/\s*\n\s*/g, ' '));
        b.rows.push({ label, cells }); used.add(r);
      }
    });
    // 연락처·소속·과장·메모
    const head = {};
    for (let r = t.r0 + 1; r <= end; r++) { if (used.has(r)) continue; const row = grid.get(r); if (!row) continue;
      const cs = [...row].sort((a, b) => a[0] - b[0]).filter(([, x]) => clean(x.v));
      for (let k = 0; k < cs.length; k++) { const [c, x] = cs[k]; const t2 = clean(x.v);
        const ch = /^임상과장\s*[:：]?\s*(.*)$/.exec(t2);
        if (ch) { chief = clean(ch[1]) || (cs[k + 1] ? clean(cs[k + 1][1].v).replace(DUTY_PHONE, '').trim() : ''); if (!ch[1] && cs[k + 1]) k++; continue; }
        const ct = parseContact(t2);
        if (ct) { ct.group = head[c] || ''; contacts.push(ct); continue; }
        if (t2.length <= 12 && !t2.startsWith('*') && cs.length > 1 || /^(M[A-Z]|종양내과|혈액내과)$/.test(t2)) { head[c] = t2; continue; }
        notes.push(t2);
      }
    }
    let rows = blocks.flatMap(b => b.rows.map(x => ({ sub: b.sub, label: x.label, cells: x.cells })));
    // 채워진 줄이 있으면 빈 줄(시간 설명·백업 등)은 메모로. 전부 비었으면(미입력) 줄 이름은 그대로 둔다
    if (rows.some(x => x.cells.some(Boolean))) { notes.unshift(...rows.filter(x => !x.cells.some(Boolean)).map(x => x.label)); rows = rows.filter(x => x.cells.some(Boolean)); }
    return { key: dutyKey(t.name), name: t.name, rows, contacts, notes, chief };
  });
  if (!mi) throw new Error('당직표의 1·2·3 날짜 머리글과 요일 줄을 찾지 못했습니다.');
  const { Y, M, nDays, holi, issues } = mi;
  sections.forEach(s => s.rows.forEach(x => { x.cells = Array.from({ length: nDays }, (_, k) => x.cells[k] || ''); }));
  return { Y, M, nDays, holidays: [...holi].sort((a, b) => a - b), issues, sourceName: fileName || '', sheetName: book.sheetName, sections };
}
// 날짜 칸 글 → 연락처 (코드 한두 글자, 또는 이름이 들어 있으면)
function dutyPeople(sec, text, all = []) {
  const t = text.replace(/\s/g, ''); if (!t) return [];
  if (/^[A-Z]{1,2}$/.test(t)) return sec.contacts.filter(c => c.code === t);
  const out = []; let rest = t;
  for (const c of [...sec.contacts, ...all.filter(a => !sec.contacts.includes(a))].sort((a, b) => b.name.length - a.name.length)) if (rest.includes(c.name) && !out.some(o => o.name === c.name)) { out.push(c); rest = rest.replace(c.name, '·'); }
  return out;
}
// 같은 과 연락처를 먼저, 없으면 다른 과에 적힌 연락처(예: 내과 명단이 감염내과 표 아래에 있음)
function dutyFor(duty, d) {
  const all = duty.sections.flatMap(s => s.contacts);
  return duty.sections.map(s => ({ ...s, filled: s.rows.some(x => x.cells.some(Boolean)), items: s.rows.filter(x => x.cells[d - 1]).map(x => ({ sub: x.sub, label: x.label, text: x.cells[d - 1], people: dutyPeople(s, x.cells[d - 1], all) })) }));
}
// 부서 하나 교체·비교용
function dutyToGrid(sec, nDays) { return sec.rows.map(x => [(x.sub ? x.sub + ' / ' : '') + x.label, ...Array.from({ length: nDays }, (_, k) => x.cells[k] || '')]); }

/* 메모(번호 안내 글)를 지난 자료와 줄 단위로 비교 → 바뀐 과만 { key: { name, added, removed } } */
const memoLines = m => String(m || '').split(' ¦ ').map(clean).filter(Boolean);
function memoDiff(prevUnits, units) {
  const out = {};
  for (const u of units) { const o = (prevUnits || []).find(x => x.key === u.key); if (!o) continue;
    const a = memoLines(o.memo), b = memoLines(u.memo);
    const added = b.filter(x => !a.includes(x)), removed = a.filter(x => !b.includes(x));
    if (added.length || removed.length) out[u.key] = { name: u.name, added, removed };
  }
  return out;
}
function unitToGrid(u, nDays) {
  const head = ['이름', '정보', ...Array.from({ length: nDays }, (_, i) => String(i + 1))];
  return [head, ...u.nurses.map(n => [n.name, clean(n.info), ...n.codes.map((c, i) => c + (n.marks?.[i] === 'Y' ? '#노랑' : n.marks?.[i] === 'B' ? '#파랑' : ''))])];
}

G.Engine = { readXlsx, extractBook, memoDiff, memoLines, extractDuty, dutyFor, dutyPeople, dutyToGrid, compute, ruleCheck, mergeRevised, setDefaultCfg, get DEFAULT_CFG() { return DEFAULT_CFG; }, UNK, WD, jsWd, unitToGrid, clean };
})(typeof window !== 'undefined' ? window : globalThis);
