/* 전담 콜북 — 화면 */
'use strict';
const DATA_URL = 'data/schedule.enc.json';
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LS = {
  get(k, d = null) { try { const v = localStorage.getItem('jc.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('jc.' + k, JSON.stringify(v)); return true; } catch { return false; } },
  del(k) { try { localStorage.removeItem('jc.' + k); } catch {} },
};

/* ------------------------------------------------------------ 암호화 (PBKDF2 + AES-GCM, gzip) */
const b64 = u8 => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
async function gz(u8, de) { const st = new Blob([u8]).stream().pipeThrough(de ? new DecompressionStream('gzip') : new CompressionStream('gzip')); return new Uint8Array(await new Response(st).arrayBuffer()); }
async function keyFrom(pw, salt, iter) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
const Crypt = {
  async seal(obj, pw) {
    const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12)), iter = 210000;
    const pt = await gz(new TextEncoder().encode(JSON.stringify(obj)));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await keyFrom(pw, salt, iter), pt));
    return { app: 'jeondam-callbook', v: 1, iter, salt: b64(salt), iv: b64(iv), ct: b64(ct), month: `${obj.Y}-${String(obj.M).padStart(2, '0')}`, updatedAt: obj.updatedAt };
  },
  async open(blob, pw) {
    const key = await keyFrom(pw, unb64(blob.salt), blob.iter);
    const pt = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(blob.iv) }, key, unb64(blob.ct)));
    return JSON.parse(new TextDecoder().decode(await gz(pt, true)));
  },
};

/* ------------------------------------------------------------ 상태 */
const S = { data: null, res: null, byDay: new Map(), day: 1, shift: 'D', q: '', tab: 'home', favs: new Set(LS.get('favs', [])), open: new Set() };
const GENERIC = new Set(['교수 구분 없음', '-', '전체', '교수 상관없음']);
function shiftGroup(label) {
  if (/^Evening|^E\d/.test(label)) return 'E';
  if (/^Night|^N\d/.test(label)) return 'N';
  if (/^(Day|D\w*|X\w*|8am|평일|전공의|대체)/.test(label)) return 'D';
  return '*';
}
function nowPos() {
  const n = new Date(), h = n.getHours();
  let d = new Date(n), s = h >= 7 && h < 15 ? 'D' : h >= 15 && h < 23 ? 'E' : 'N';
  if (h < 7) d.setDate(d.getDate() - 1);
  return { Y: d.getFullYear(), M: d.getMonth() + 1, d: d.getDate(), s };
}

/* ------------------------------------------------------------ 시작 */
function applyTheme() { const t = LS.get('theme', 'auto'); if (t === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.dataset.theme = t; }
async function fetchBlob() {
  try {
    const ctl = new AbortController(); setTimeout(() => ctl.abort(), 6000);
    const r = await fetch(DATA_URL + '?t=' + Date.now(), { cache: 'no-store', signal: ctl.signal });
    if (!r.ok) return null;
    const j = await r.json(); return j && j.ct ? j : null;
  } catch { return null; }
}
/* 관리자 메뉴는 관리자 기기에서만 보인다: 주소 끝에 #admin으로 한 번 열면 그 기기에 기억 */
if (location.hash === '#admin') { LS.set('adminMode', true); history.replaceState(null, '', location.pathname + location.search); }
const isAdmin = () => !!LS.get('adminMode');
/* 같은 게시본인지: 다시 암호화하면 iv가 바뀌므로 비밀번호만 바꿔 게시해도 새 파일로 인식 */
const sameBlob = (a, b) => !!(a && b && a.iv === b.iv && a.updatedAt === b.updatedAt);
async function boot() {
  applyTheme();
  $('adminFromLock').hidden = !isAdmin();
  lastSync = Date.now(); const remote = await fetchBlob();
  const local = LS.get('blob');
  let blob = local;
  if (remote && !sameBlob(remote, local)) { blob = remote; LS.set('blob', remote); }
  if (!blob) return showLock('아직 게시된 근무표가 없습니다');
  const pw = LS.get('pw');
  if (!pw) return showLock();
  try { setData(await Crypt.open(blob, pw)); }
  catch { showLock('비밀번호가 바뀌었습니다. 새 비밀번호를 입력하세요.'); }
}
/* 게시된 근무표가 바뀌었으면 받아서 교체 (앱을 다시 열 때마다 자동) */
let lastSync = 0;
async function syncRemote(manual) {
  if (window.Admin && (Admin.dirty || Admin.busy)) return manual && toast('게시 안 한 관리자 변경이 있어 받지 않았습니다');
  lastSync = Date.now();
  const r = await fetchBlob(); if (!r) return manual && toast('서버에서 받지 못했습니다');
  const cur = LS.get('blob'); if (sameBlob(cur, r)) return manual && toast('이미 최신입니다');
  LS.set('blob', r);
  try { setData(await Crypt.open(r, LS.get('pw'))); toast(`${r.month} 근무표를 새로 받았습니다`); } catch { showLock('새 근무표의 비밀번호를 입력하세요'); }
}
function showLock(msg) {
  $('appView').hidden = true; $('lockView').hidden = false;
  if (msg) $('lockMsg').textContent = msg;
  setTimeout(() => $('pw').focus(), 50);
}
$('unlock').onclick = async () => {
  const pw = $('pw').value; const blob = LS.get('blob');
  if (!blob) return toast('먼저 근무표 파일을 불러오세요');
  try { const d = await Crypt.open(blob, pw); LS.set('pw', pw); $('pw').value = ''; setData(d); }
  catch { $('lockMsg').textContent = '비밀번호가 맞지 않습니다'; $('pw').select(); }
};
$('pw').onkeydown = e => { if (e.key === 'Enter') $('unlock').click(); };
$('adminFromLock').onclick = () => window.Admin && Admin.open();
async function importBlobFile(f) {
  try {
    const j = JSON.parse(await f.text());
    if (!j.ct) throw 0;
    LS.set('blob', j); toast(`${j.month} 근무표를 불러왔습니다`);
    const pw = LS.get('pw');
    if (pw) { try { return setData(await Crypt.open(j, pw)); } catch {} }
    showLock('불러온 근무표의 비밀번호를 입력하세요');
  } catch { toast('콜북 데이터 파일이 아닙니다'); }
}
function pickFile(accept, cb, multiple) {
  const fi = $('fileIn'); fi.accept = accept; fi.multiple = !!multiple; fi.value = '';
  fi.onchange = () => { if (fi.files.length) cb(multiple ? [...fi.files] : fi.files[0]); };
  fi.click();
}

function setData(data) {
  S.data = data;
  S.res = Engine.compute(data);
  S.byDay = new Map();
  for (const r of S.res.rows) { if (!S.byDay.has(r.d)) S.byDay.set(r.d, []); S.byDay.get(r.d).push(r); }
  const np = nowPos();
  if (np.Y === data.Y && np.M === data.M) { S.day = np.d; S.shift = np.s; }
  else { S.day = Math.min(Math.max(S.day, 1), data.nDays); }
  $('lockView').hidden = true; $('appView').hidden = false;
  render();
}

/* ------------------------------------------------------------ 렌더 */
function render() {
  const d = S.data; if (!d) return;
  const isHoli = d.holidays.includes(S.day), wd = Engine.WD[Engine.jsWd(d.Y, d.M, S.day)];
  $('dateLabel').innerHTML = `${d.M}월 ${S.day}일<small class="${isHoli ? 'h' : ''}">${wd}${isHoli ? ' · 휴일' : ''}</small>`;
  const np = nowPos(), isToday = np.Y === d.Y && np.M === d.M && np.d === S.day;
  $('todayBtn').hidden = isToday || !(np.Y === d.Y && np.M === d.M);
  document.querySelectorAll('.shifts button').forEach(b => {
    b.setAttribute('aria-pressed', b.dataset.s === S.shift);
    b.querySelector('i')?.remove();
    if (isToday && b.dataset.s === np.s) b.insertAdjacentHTML('afterbegin', '<i>지금</i>');
  });
  const upd = d.updatedAt ? new Date(d.updatedAt) : null;
  const stale = !(np.Y === d.Y && np.M === d.M);
  $('meta').innerHTML = `<span class="dot ${stale ? 'stale' : ''}"></span>${d.Y}.${String(d.M).padStart(2, '0')}${upd ? ` · ${upd.getMonth() + 1}/${upd.getDate()} ${String(upd.getHours()).padStart(2, '0')}:${String(upd.getMinutes()).padStart(2, '0')} 갱신` : ''}`;
  $('dateBar').hidden = S.tab === 'set';
  document.querySelector('.search').hidden = S.tab === 'set';
  $('chips').hidden = S.tab !== 'home' && S.tab !== 'duty';
  document.querySelector('.shifts').hidden = S.tab === 'duty';
  $('qClear').hidden = !S.q;
  document.querySelectorAll('#tabs button').forEach(b => b.dataset.tab === S.tab ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current'));
  if (S.tab === 'home') renderHome(); else if (S.tab === 'prof') renderProf(); else if (S.tab === 'duty') renderDuty(); else renderSettings();
}

function visibleRows() {
  const all = S.byDay.get(S.day) || [];
  const q = S.q.trim().toLowerCase();
  if (q) return all.filter(r => [r.dept, r.team, r.prof, r.workers, r.number, r.note].join(' ').toLowerCase().includes(q));
  return all.filter(r => { const g = shiftGroup(r.shift); return g === S.shift || g === '*'; });
}
function groupByDept(rows) {
  const m = new Map();
  for (const r of rows) { if (!m.has(r.dept)) m.set(r.dept, []); m.get(r.dept).push(r); }
  let arr = [...m];
  arr.sort((a, b) => (S.favs.has(b[0]) - S.favs.has(a[0])));
  return arr;
}
function renderHome() {
  const rows = visibleRows();
  const groups = groupByDept(rows);
  const issues = [];
  if (S.res.changed.length) issues.push(`원본 메모와 번호 규칙이 다른 과: ${S.res.changed.map(c => c.name).join(', ')}`);
  $('chips').innerHTML = groups.map(([dept, rs]) => {
    const w = rs.filter(r => r.warn).length;
    return `<button class="chip ${S.favs.has(dept) ? 'fav' : ''}" data-go="${esc(dept)}">${S.favs.has(dept) ? '★ ' : ''}${esc(dept.replace(/^내과 /, ''))}${w ? `<span class="n">⚠${w}</span>` : ''}</button>`;
  }).join('');
  $('chips').querySelectorAll('[data-go]').forEach(b => b.onclick = () => document.getElementById('d-' + b.dataset.go)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  if (!groups.length) {
    $('main').innerHTML = `<div class="empty"><b>${S.q ? '찾는 결과가 없습니다' : '이 시간대 근무가 없습니다'}</b>${S.q ? '교수·과·간호사 이름 일부만 입력해 보세요' : '다른 근무 시간대를 눌러 보세요'}</div>`;
    return;
  }
  $('main').innerHTML = (issues.length ? `<div class="banner">⚠ ${esc(issues.join(' / '))}</div>` : '') + groups.map(([dept, rs]) => deptCard(dept, rs, !!S.q)).join('');
  bindRows($('main'));
}
function deptCard(dept, rs, showShift) {
  const w = rs.filter(r => r.warn).length;
  const limit = 14, opened = S.open.has(dept) || showShift;
  const shown = opened ? rs : rs.slice(0, limit);
  return `<section class="dept" id="d-${esc(dept)}">
    <header><h2>${esc(dept)}</h2>${w ? `<span class="w">⚠ ${w}</span>` : ''}
      <button class="star" data-fav="${esc(dept)}" aria-pressed="${S.favs.has(dept)}" aria-label="즐겨찾기"><svg width="20" height="20" viewBox="0 0 24 24" fill="${S.favs.has(dept) ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/></svg></button></header>
    ${shown.map(r => rowHtml(r, showShift)).join('')}
    ${rs.length > shown.length ? `<button class="more" data-more="${esc(dept)}">${rs.length - shown.length}명 더 보기</button>` : ''}
  </section>`;
}
function rowHtml(r, showShift) {
  const generic = GENERIC.has(r.prof);
  const title = generic ? r.team : r.prof;
  const sg = shiftGroup(r.shift);
  const sb = showShift || !/^(Day|Evening|Night)$/.test(r.shift) ? `<span class="badge ${sg !== '*' ? 's-' + sg : ''}">${esc(r.shift)}</span>` : '';
  const tb = !generic && r.team && r.team !== '-' ? `<span class="badge">${esc(r.team)}</span>` : '';
  return `<div class="row ${r.warn ? 'warn' : ''}">
    <div class="who"><div class="p">${esc(title)} ${tb}${sb}</div>
      ${r.workers && r.workers !== '-' ? `<div class="w2">${esc(r.workers)}</div>` : ''}
      ${r.warn ? `<div class="wt">⚠ ${esc(r.warn)}</div>` : ''}
      ${r.note ? `<div class="nt">${esc(r.note)}</div>` : ''}</div>
    <div class="nums">${numsHtml(r.number)}</div></div>`;
}
const TOKEN = /0\d{1,2}-\d{3,4}-\d{4}|\b86-?\d{4}\b|\b\d{4,6}\b/g;
function numsHtml(num) {
  num = String(num || '');
  if (!num) return '';
  if (num.startsWith(Engine.UNK)) return `<span class="num unk">${esc(num)}</span>`;
  const toks = num.match(TOKEN) || [];
  const rest = num.replace(TOKEN, '').replace(/[,/·\s]+/g, '');
  const chip = t => `<button class="num ${/^0\d/.test(t) && t.startsWith('010') ? 'cell' : ''}" data-num="${esc(t)}">${t.startsWith('010') ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"/></svg>' : ''}${esc(t)}</button>`;
  if (!toks.length) return `<span class="num txt">${esc(num)}</span>`;
  if (!rest || /^(내선|\(먼저\)|먼저)$/.test(rest.replace(/[()]/g, ''))) return toks.map(chip).join('') + (/먼저/.test(num) ? '<span class="badge">먼저</span>' : '');
  // 설명이 섞인 번호(예: 1인 근무 시 …, 팀별 번호) → 문장 그대로 + 숫자만 누를 수 있게
  return `<span class="num txt">${esc(num).replace(TOKEN, t => `<button class="badge" data-num="${t}" style="font-size:13px;color:var(--ink)">${t}</button>`)}</span>`;
}
function bindRows(root) {
  root.querySelectorAll('[data-num]').forEach(b => b.onclick = () => numAction(b.dataset.num));
  root.querySelectorAll('[data-fav]').forEach(b => b.onclick = () => { const k = b.dataset.fav; S.favs.has(k) ? S.favs.delete(k) : S.favs.add(k); LS.set('favs', [...S.favs]); render(); });
  root.querySelectorAll('[data-more]').forEach(b => b.onclick = () => { S.open.add(b.dataset.more); render(); });
}
async function copy(t) { try { await navigator.clipboard.writeText(t); toast(`${t} 복사됨`); } catch { toast(t); } }
function numAction(t) {
  if (!t.startsWith('010')) return copy(t);
  openSheet(`<h3>${esc(t)}</h3><div class="stack"><a class="btn primary block" style="text-align:center;text-decoration:none" href="tel:${t.replace(/-/g, '')}">전화 걸기</a><button class="btn block" id="cp">번호 복사</button></div>`);
  $('cp').onclick = () => { copy(t); closeSheet(); };
}

/* ------------------------------------------------------------ 당직 (교수 당직표) */
function renderDuty() {
  const du = S.data.duty;
  if (!du) { $('chips').innerHTML = ''; $('main').innerHTML = `<div class="empty"><b>아직 당직표가 없습니다</b>관리자가 올리면 여기에 보입니다</div>`; return; }
  const same = du.Y === S.data.Y && du.M === S.data.M;
  const all = Engine.dutyFor(du, Math.min(S.day, du.nDays)), q = S.q.trim().replace(/\s/g, '');
  const hit = it => (it.label + it.text + it.people.map(p => p.name + p.phone).join()).replace(/\s/g, '').includes(q);
  let secs = all.filter(s => s.items.length).map(s => q && !s.name.includes(q) ? { ...s, items: s.items.filter(hit) } : s).filter(s => s.items.length);
  secs.sort((a, b) => S.favs.has('당직:' + b.name) - S.favs.has('당직:' + a.name));
  const off = all.filter(s => !s.filled).map(s => s.name);
  $('chips').innerHTML = secs.map(s => `<button class="chip ${S.favs.has('당직:' + s.name) ? 'fav' : ''}" data-go="duty-${esc(s.name)}">${S.favs.has('당직:' + s.name) ? '★ ' : ''}${esc(s.name)}</button>`).join('');
  $('chips').querySelectorAll('[data-go]').forEach(b => b.onclick = () => document.getElementById(b.dataset.go)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  const banner = same ? '' : `<div class="banner">당직표는 ${du.Y}년 ${du.M}월입니다 (근무표 ${S.data.Y}년 ${S.data.M}월)</div>`;
  if (!secs.length) { $('main').innerHTML = banner + `<div class="empty"><b>${q ? '찾는 결과가 없습니다' : '이 날 당직표가 없습니다'}</b></div>`; return; }
  $('main').innerHTML = banner + secs.map(dutyCard).join('') + (off.length && !q ? `<p class="dutyOff">당직표 미입력 · ${esc(off.join(', '))}</p>` : '');
  bindRows($('main'));
}
const NOTE_NUM = /0\d{1,2}[- ]\d{3,4}[- ]\d{4}|\b86-?\d{4}\b|(?<![\d.])\d{4,6}(?![\d.년월])/g; // 메모 속 번호 (연도 2024. 등 제외)
function dutyCard(s) {
  const fav = S.favs.has('당직:' + s.name);
  return `<section class="dept" id="duty-${esc(s.name)}">
    <header><h2>${esc(s.name)}</h2>${s.chief ? `<span class="badge">과장 ${esc(s.chief)}</span>` : ''}
      <button class="star" data-fav="당직:${esc(s.name)}" aria-pressed="${fav}" aria-label="즐겨찾기"><svg width="20" height="20" viewBox="0 0 24 24" fill="${fav ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/></svg></button></header>
    ${s.items.map(it => {
      const who = it.people.length ? it.people.map(p => `${esc(p.name)}${p.role && p.role !== 'Pf' ? ` <span class="badge">${esc(p.role)}</span>` : ''}`).join(', ') : /^[xX×]$/.test(it.text.trim()) ? '<span style="color:var(--faint)">당직 없음</span>' : esc(it.text);
      const extra = it.people.length && it.text.replace(/\s/g, '') !== it.people.map(p => p.name).join('') && !/^[A-Z]{1,2}$/.test(it.text.trim()) ? `<div class="nt">${esc(it.text)}</div>` : '';
      return `<div class="row"><div class="who"><div class="p">${who}</div><div class="w2">${esc((it.sub ? it.sub + ' · ' : '') + it.label)}</div>${extra}</div>
        <div class="nums">${it.people.map(p => numsHtml(p.phone)).join('')}</div></div>`;
    }).join('')}
    ${s.notes.length ? `<details class="dnotes"><summary>call 순서 · 메모</summary>${s.notes.map(n => `<p>${esc(n).replace(NOTE_NUM, t => `<button class="badge" data-num="${t}">${t}</button>`)}</p>`).join('')}</details>` : ''}
  </section>`;
}

/* ------------------------------------------------------------ 교수 찾기 */
function profIndex() {
  const m = new Map();
  for (const r of S.res.rows) {
    if (GENERIC.has(r.prof)) continue;
    const k = r.prof + '|' + r.dept;
    if (!m.has(k)) m.set(k, { prof: r.prof, dept: r.dept, teams: new Set() });
    m.get(k).teams.add(r.team);
  }
  return [...m.values()].sort((a, b) => a.prof.localeCompare(b.prof, 'ko'));
}
const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
const cho = s => { const c = s.charCodeAt(0) - 0xAC00; return c >= 0 && c < 11172 ? CHO[Math.floor(c / 588)].replace('ㄲ', 'ㄱ').replace('ㄸ', 'ㄷ').replace('ㅃ', 'ㅂ').replace('ㅆ', 'ㅅ').replace('ㅉ', 'ㅈ') : '#'; };
function renderProf() {
  const q = S.q.trim();
  let list = profIndex();
  if (q) list = list.filter(p => (p.prof + p.dept + [...p.teams].join()).includes(q));
  if (!list.length) { $('main').innerHTML = `<div class="empty"><b>찾는 교수가 없습니다</b>이름 일부만 입력해 보세요</div>`; return; }
  const g = new Map(); list.forEach(p => { const c = cho(p.prof); if (!g.has(c)) g.set(c, []); g.get(c).push(p); });
  $('main').innerHTML = [...g].map(([c, ps]) => `<div class="plist"><h3>${c}</h3>${ps.map(p => `<button class="pitem" data-prof="${esc(p.prof)}" data-dept="${esc(p.dept)}"><b>${esc(p.prof)}</b><span>${esc(p.dept)}<br>${esc([...p.teams].filter(t => t !== '-').slice(0, 2).join(' · '))}</span></button>`).join('')}</div>`).join('');
  $('main').querySelectorAll('[data-prof]').forEach(b => b.onclick = () => profSheet(b.dataset.prof, b.dataset.dept));
}
function profSheet(prof, dept) {
  const d = S.data;
  const rows = (S.byDay.get(S.day) || []).filter(r => r.prof === prof && r.dept === dept);
  const order = r => ({ D: 0, E: 1, N: 2, '*': 3 }[shiftGroup(r.shift)]);
  rows.sort((a, b) => order(a) - order(b));
  const week = [];
  for (let i = 0; i < 7 && S.day + i <= d.nDays; i++) {
    const dd = S.day + i; const r = (S.byDay.get(dd) || []).find(x => x.prof === prof && x.dept === dept && shiftGroup(x.shift) === 'D');
    week.push(`<div>${dd}일 ${Engine.WD[Engine.jsWd(d.Y, d.M, dd)]}<b>${r ? esc(String(r.number).startsWith(Engine.UNK) ? '?' : (String(r.number).match(TOKEN) || ['-'])[0]) : '-'}</b></div>`);
  }
  openSheet(`<h3>${esc(prof)} 교수</h3><p class="sub">${esc(dept)} · ${d.M}월 ${S.day}일 ${Engine.WD[Engine.jsWd(d.Y, d.M, S.day)]}</p>
    <div class="dept" style="box-shadow:none;border:1px solid var(--line)">${rows.length ? rows.map(r => rowHtml(r, true)).join('') : '<div class="empty">이 날은 연락처가 없습니다</div>'}</div>
    <h4 style="margin:16px 0 0;font-size:13px;color:var(--muted)">앞으로 7일 Day 번호</h4><div class="week">${week.join('')}</div>`);
  bindRows($('sheetBody'));
}

/* ------------------------------------------------------------ 설정 */
function renderSettings() {
  const d = S.data, theme = LS.get('theme', 'auto');
  const nw = S.res.rows.filter(r => r.warn).length;
  $('main').innerHTML = `
  <div class="card"><h3>근무표</h3>
    <div class="kv"><span>기간</span><b>${d.Y}년 ${d.M}월 (${d.nDays}일)</b><span>갱신</span><b>${d.updatedAt ? new Date(d.updatedAt).toLocaleString('ko-KR') : '-'}</b>
    <span>휴일</span><b>${d.holidays.join(', ')}일</b><span>확인 필요</span><b>${nw}건</b></div>
    <button class="btn block" id="refresh">최신 근무표 받기</button>
    <button class="btn block" id="imp">파일에서 불러오기</button></div>
  <div class="card"><h3>화면</h3><div class="seg" id="theme">
    ${[['auto', '자동'], ['light', '밝게'], ['dark', '어둡게']].map(([k, l]) => `<button data-t="${k}" aria-pressed="${theme === k}">${l}</button>`).join('')}</div>
    ${S.favs.size ? `<div class="kv"><span>즐겨찾기</span><b>${esc([...S.favs].join(', '))}</b></div><button class="btn block" id="clrFav">즐겨찾기 모두 지우기</button>` : '<p style="margin:0;color:var(--muted);font-size:13px">과 이름 옆 ☆를 누르면 즐겨찾기가 맨 위에 옵니다</p>'}</div>
  <div class="card"><h3>보안</h3><button class="btn block" id="lockNow">비밀번호 다시 입력하기</button></div>
  ${isAdmin() ? `<div class="card"><h3>관리자</h3><p style="margin:0;color:var(--muted);font-size:13px">새 달 근무표 등록, 부서 근무표 수정(엑셀·사진), 게시는 관리자만 할 수 있습니다.</p>
    <button class="btn primary block" id="adm">관리자 화면 열기</button>
    <button class="btn block" id="admHide">이 기기에서 관리자 메뉴 숨기기</button></div>` : ''}
  <p style="text-align:center;color:var(--faint);font-size:12px">전담 콜북 · ${esc(d.sourceName || '')}</p>`;
  $('refresh').onclick = () => syncRemote(true);
  $('imp').onclick = () => pickFile('.json,application/json', importBlobFile);
  $('theme').querySelectorAll('button').forEach(b => b.onclick = () => { LS.set('theme', b.dataset.t); applyTheme(); render(); });
  $('clrFav') && ($('clrFav').onclick = () => { S.favs.clear(); LS.set('favs', []); render(); });
  $('lockNow').onclick = () => { LS.del('pw'); showLock(); };
  $('adm') && ($('adm').onclick = () => window.Admin && Admin.open());
  $('admHide') && ($('admHide').onclick = () => { LS.del('adminMode'); $('adminFromLock').hidden = true; render(); });
}

/* ------------------------------------------------------------ 시트 / 토스트 / 달력 */
function openSheet(html) {
  $('sheetBody').innerHTML = html; $('scrim').hidden = false; $('sheet').hidden = false;
  requestAnimationFrame(() => { $('scrim').classList.add('on'); $('sheet').classList.add('on'); });
}
function closeSheet() {
  $('scrim').classList.remove('on'); $('sheet').classList.remove('on');
  setTimeout(() => { $('scrim').hidden = true; $('sheet').hidden = true; $('sheetBody').innerHTML = ''; }, 250);
}
$('scrim').onclick = () => { if (!window.Admin?.busy) closeSheet(); };
let tt; function toast(t) { const el = $('toast'); el.textContent = t; el.classList.add('on'); clearTimeout(tt); tt = setTimeout(() => el.classList.remove('on'), 1800); }
function calSheet() {
  const d = S.data, np = nowPos(); const first = Engine.jsWd(d.Y, d.M, 1);
  let cells = '월화수목금토일'.split('').map(c => `<div class="h">${c}</div>`).join('') + '<div></div>'.repeat(first);
  for (let i = 1; i <= d.nDays; i++) cells += `<button data-day="${i}" class="${d.holidays.includes(i) ? 'hol' : ''} ${i === S.day ? 'sel' : ''} ${np.Y === d.Y && np.M === d.M && np.d === i ? 'today' : ''}">${i}</button>`;
  openSheet(`<h3>${d.Y}년 ${d.M}월</h3><div class="cal">${cells}</div>`);
  $('sheetBody').querySelectorAll('[data-day]').forEach(b => b.onclick = () => { S.day = +b.dataset.day; closeSheet(); render(); window.scrollTo(0, 0); });
}

/* ------------------------------------------------------------ 이벤트 */
$('prev').onclick = () => { if (S.day > 1) { S.day--; render(); } else toast('이번 근무표의 첫날입니다'); };
$('next').onclick = () => { if (S.day < S.data.nDays) { S.day++; render(); } else toast('이번 근무표의 마지막 날입니다'); };
$('todayBtn').onclick = () => { const np = nowPos(); S.day = np.d; S.shift = np.s; render(); };
$('dateBtn').onclick = calSheet;
document.querySelectorAll('.shifts button').forEach(b => b.onclick = () => { S.shift = b.dataset.s; render(); });
$('q').oninput = () => { S.q = $('q').value; render(); };
$('qClear').onclick = () => { $('q').value = ''; S.q = ''; render(); $('q').focus(); };
$('tabs').querySelectorAll('button').forEach(b => b.onclick = () => { S.tab = b.dataset.tab; render(); window.scrollTo(0, 0); });
addEventListener('scroll', () => $('top').classList.toggle('scrolled', scrollY > 4), { passive: true });
let sx = null;
$('main').addEventListener('touchstart', e => { sx = [e.touches[0].clientX, e.touches[0].clientY]; }, { passive: true });
$('main').addEventListener('touchend', e => {
  if (!sx || S.tab !== 'home') return; const dx = e.changedTouches[0].clientX - sx[0], dy = e.changedTouches[0].clientY - sx[1]; sx = null;
  if (Math.abs(dx) > 80 && Math.abs(dy) < 40) (dx < 0 ? $('next') : $('prev')).click();
}, { passive: true });
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.data && Date.now() - lastSync > 30000) syncRemote(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.data) { const np = nowPos(); if (np.Y === S.data.Y && np.M === S.data.M && !S.q) render(); } });
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});

window.App = { S, LS, Crypt, setData, render, toast, openSheet, closeSheet, pickFile, esc, $, DATA_URL, showLock };
boot();
