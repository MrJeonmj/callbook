/* 전담 콜북 — 관리자 (Claude API · 게시)
 * API 키·GitHub 토큰은 관리자 휴대폰(이 브라우저)에만 저장된다. 앱 파일·데이터 파일에는 들어가지 않는다.
 */
'use strict';
(function () {
const { LS, Crypt, setData, toast, openSheet, closeSheet, pickFile, esc, $ } = App;
const A = { busy: false, draft: null, dirty: false };
const cfgA = () => LS.get('admin', { apiKey: '', model: '', pw: '', gh: { owner: '', repo: '', branch: 'main', path: App.DATA_URL, token: '' } });
const clone = o => JSON.parse(JSON.stringify(o));
const now = () => new Date().toISOString();
const ruleKey = u => u.key.startsWith('IM:') ? u.key.split(':')[1].split('/')[0] : u.key;

/* ------------------------------------------------------------ Claude API */
const DOMAIN = `당신은 병원 "전담간호사 근무표"를 교수별 내선번호표로 바꾸는 앱의 관리자 도우미입니다.
근무표 구조: 과별 블록마다 간호사 행(이름, 개인폰/번호 메모, 1~말일 근무코드)과 하단·옆 메모(번호 안내)가 있습니다.
근무코드: D/E/N(+팀 글자 a·b·c·d 소문자, 예: Da=Day A팀), D0·E0·N0·X7~X11·X07~X10(시간 근무), DZ·D85·X09(코디), ★(Primary call/당직 표시)는 코드에 그대로 붙여 둡니다. 휴무: P Q O G S F v / H U 결 교 노. 그 밖의 코드(SP PH RH HO CE OE UE OH TR D3 DQ R 등)는 그대로 옮기되 해석하지 않습니다.
셀 색: 비뇨(외래/병동) 노란색 = 병동 전담 Primary call 근무자, 심장혈관외과 파란 배경 = AICU 근무자.
사용자 원칙: 번호가 틀린 날이 있으면 안 됩니다. 확실하지 않으면 추측하지 말고 unclear로 보고하거나 비워 두세요. 답변은 한국어로.`;

/* ------------------------------------------------------------ 키·토큰 보관 (관리자 PIN으로 암호화)
 * jc.admin = 일반 설정(모델·저장소 이름 등), jc.adminSec = { apiKey, token }을 PIN으로 AES-256 암호화한 것.
 * 풀린 값은 앱을 닫을 때까지 메모리(SEC)에만 둔다. 예전 평문 저장분은 PIN을 정해 저장하면 암호화로 바뀐다. */
let SEC = null, PIN = '';
const legacySec = () => { const c = cfgA(); return c.apiKey || c.gh?.token ? { apiKey: c.apiKey || '', token: c.gh?.token || '' } : null; };
const hasApiKey = () => !!(cfgA().apiKey || LS.get('adminSec')?.hasKey);
const hasSec = () => !!(legacySec() || LS.get('adminSec'));
async function secrets() {
  if (SEC) return SEC;
  const old = legacySec(); if (old) return old;
  const enc = LS.get('adminSec'); if (!enc) return { apiKey: '', token: '' };
  let msg = '';
  for (;;) {
    const pin = await askPin(msg); if (pin == null) throw new Error('관리자 PIN을 입력해야 합니다');
    try { SEC = await Crypt.open(enc, pin); PIN = pin; return SEC; } catch { msg = 'PIN이 맞지 않습니다'; }
  }
}
function askPin(msg) {
  return new Promise(res => {
    const el = document.createElement('div'); el.className = 'pinBox';
    el.innerHTML = `<div class="box stack"><h3>관리자 PIN</h3>${msg ? `<p class="wt" style="color:var(--bad)">${esc(msg)}</p>` : ''}
      <input id="pinIn" type="password" inputmode="numeric" autocomplete="off" placeholder="PIN">
      <button class="btn primary block" id="pinOk">확인</button><button class="btn block" id="pinNo">취소</button>
      <button class="btn block" id="pinForgot" style="background:none;border:0;color:var(--muted)">PIN을 잊었어요</button></div>`;
    document.body.append(el);
    const i = el.querySelector('#pinIn'); setTimeout(() => i.focus(), 50);
    const done = v => { el.remove(); res(v); };
    el.querySelector('#pinOk').onclick = () => done(i.value);
    i.onkeydown = e => { if (e.key === 'Enter') done(i.value); };
    el.querySelector('#pinNo').onclick = () => done(null);
    el.querySelector('#pinForgot').onclick = () => {
      if (!confirm('저장된 Claude API 키와 GitHub 토큰을 지웁니다.\n관리자 설정에서 다시 넣고 새 PIN을 정하세요.')) return;
      LS.del('adminSec'); SEC = null; PIN = ''; done(null); toast('지웠습니다. 관리자 설정에서 다시 넣어 주세요');
    };
  });
}

async function claude({ system, content, tool, maxTokens = 16000 }) {
  const c = cfgA(), { apiKey } = await secrets();
  if (!apiKey) throw new Error('관리자 설정에 Claude API 키를 넣어 주세요');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
    body: JSON.stringify({ model: c.model || 'claude-sonnet-4-5', max_tokens: maxTokens, system, messages: [{ role: 'user', content }], tools: [tool], tool_choice: { type: 'tool', name: tool.name } }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Claude API 오류 ${r.status}: ${j.error?.message || r.statusText}`);
  const t = (j.content || []).find(x => x.type === 'tool_use');
  if (!t) throw new Error('Claude 응답에 결과가 없습니다');
  if (j.stop_reason === 'max_tokens') throw new Error('Claude 응답이 길어서 잘렸습니다. 사진을 나눠서 올려 주세요');
  return t.input;
}
async function listModels(key) {
  const r = await fetch('https://api.anthropic.com/v1/models?limit=100', { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' } });
  const j = await r.json(); if (!r.ok) throw new Error(j.error?.message || r.status);
  return (j.data || []).map(m => ({ id: m.id, name: m.display_name || m.id }));
}

const REVIEW_TOOL = {
  name: 'report_rule_review',
  description: '과별 번호 안내 메모를 현재 번호 규칙과 비교한 결과',
  input_schema: { type: 'object', properties: {
    units: { type: 'array', items: { type: 'object', properties: {
      key: { type: 'string', description: '과 키(입력 그대로)' },
      status: { type: 'string', enum: ['ok', 'changed', 'unclear'] },
      summary: { type: 'string', description: '바뀐 점 또는 확인 결과 한두 문장' },
      cfg: { type: 'object', description: 'status=changed일 때만: 이 과의 새 규칙 전체. 현재 규칙과 똑같은 키·구조를 유지하고 값만 바꿀 것' },
      question: { type: 'string', description: '관리자에게 확인할 질문(없으면 생략)' } }, required: ['key', 'status', 'summary'] } },
    overall: { type: 'string' } }, required: ['units'] },
};
const DEPT_TOOL = {
  name: 'report_department_schedule',
  description: '한 과의 근무표를 읽은 결과',
  input_schema: { type: 'object', properties: {
    nurses: { type: 'array', items: { type: 'object', properties: {
      name: { type: 'string', description: '간호사 이름(기존 명단에 같은 사람이 있으면 그 표기 그대로)' },
      info: { type: 'string', description: '이름 옆 번호·메모(보이면). 안 보이면 빈 문자열' },
      codes: { type: 'array', items: { type: ['string', 'null'] }, description: '1일~말일 근무코드. 사진에 없거나 못 읽은 날은 null' },
      marks: { type: 'array', items: { type: ['string', 'null'] }, description: '1일~말일 셀 색: Y=노랑, B=파랑, ""=없음, null=모름' } }, required: ['name', 'codes'] } },
    memo_changes: { type: 'string', description: '번호 안내 메모가 기존과 달라졌으면 내용, 아니면 빈 문자열' },
    cfg: { type: 'object', description: '메모 때문에 번호 규칙이 바뀌어야 할 때만: 이 과의 새 규칙 전체(현재와 같은 구조)' },
    notes: { type: 'string', description: '읽기 어려웠던 칸 등 관리자에게 알릴 점' } }, required: ['nurses'] },
};

/* ------------------------------------------------------------ 화면 */
function header() {
  const d = A.draft || App.S.data;
  return `<h3>관리자</h3>${d ? `<p class="sub">${d.Y}년 ${d.M}월 · ${A.dirty ? '<b style="color:var(--warn)">게시 안 한 변경 있음</b>' : '게시본과 같음'}</p>` : '<p class="sub">아직 근무표가 없습니다</p>'}`;
}
function open() {
  const c = cfgA();
  if (!A.draft && App.S.data) A.draft = clone(App.S.data);
  const ready = hasApiKey() && c.pw;
  openSheet(`<div class="admin stack">${header()}
    ${!ready ? '<div class="banner">먼저 아래 "관리자 설정"에서 Claude API 키와 근무표 비밀번호를 넣어 주세요.</div>' : ''}
    ${legacySec() ? '<div class="banner">관리자 설정에서 PIN을 정해 저장하면 키·토큰이 암호화됩니다.</div>' : ''}
    <button class="btn brand block" id="aNew">새 달 근무표 올리기 (엑셀)</button>
    <button class="btn block" id="aFix" ${A.draft ? '' : 'disabled'}>부서 근무표 수정 (엑셀·사진)</button>
    <button class="btn block" id="aRule" ${A.draft ? '' : 'disabled'}>번호 규칙 보기·수정</button>
    ${Object.keys(A.draft?.memoChanged || {}).length ? `<button class="btn block" id="aMemo">메모 바뀐 과 ${Object.keys(A.draft.memoChanged).length}곳 보기</button>` : ''}
    <h4>당직표</h4>
    <button class="btn brand block" id="aDutyNew" ${A.draft ? '' : 'disabled'}>새 달 당직표 올리기 (엑셀)</button>
    <button class="btn block" id="aDutyFix" ${A.draft?.duty ? '' : 'disabled'}>부서 당직표 수정 (엑셀·사진)</button>
    <h4>게시</h4>
    <button class="btn primary block" id="aPub" ${A.draft ? '' : 'disabled'}>모두에게 게시 (GitHub)</button>
    <button class="btn block" id="aExp" ${A.draft ? '' : 'disabled'}>데이터 파일로 내보내기 (메신저 공유용)</button>
    <button class="btn block" id="aXlsx" ${A.draft ? '' : 'disabled'}>결과 엑셀 받기</button>
    <h4>기타</h4>
    <button class="btn block" id="aLog" ${A.draft ? '' : 'disabled'}>변경 이력</button>
    <button class="btn block" id="aSet">관리자 설정</button>
    ${A.dirty ? '<button class="btn block danger" id="aDiscard">게시 안 한 변경 버리기</button>' : ''}
    <button class="btn block" id="aClose" style="background:none;border:0;color:var(--muted)">닫기</button></div>`);
  $('aNew').onclick = newMonth; $('aFix').onclick = fixDept; $('aRule').onclick = rules;
  $('aDutyNew').onclick = dutyNew; $('aDutyFix').onclick = dutyFix;
  $('aMemo') && ($('aMemo').onclick = memoView);
  $('aPub').onclick = publish; $('aExp').onclick = exportBlob; $('aXlsx').onclick = exportXlsx;
  $('aLog').onclick = showLog; $('aSet').onclick = settings; $('aClose').onclick = closeSheet;
  $('aDiscard') && ($('aDiscard').onclick = () => { A.draft = App.S.data ? clone(App.S.data) : null; A.dirty = false; toast('변경을 버렸습니다'); open(); });
}
function busy(msg) { A.busy = !!msg; const el = $('aBusy'); if (el) { el.hidden = !msg; el.querySelector('span').textContent = msg || ''; } }
const busyHtml = '<div class="prog" id="aBusy" hidden><div class="spin"></div><span></span></div>';
function back() { return '<button class="btn block" data-back style="background:none;border:0;color:var(--muted)">← 관리자 메뉴</button>'; }
function bindBack() { document.querySelectorAll('[data-back]').forEach(b => b.onclick = open); }

/* ------------------------------------------------------------ 설정 */
function settings() {
  const c = cfgA();
  openSheet(`<div class="admin stack"><h3>관리자 설정</h3><p class="sub">이 휴대폰에만 저장됩니다. 다른 사람 앱에는 들어가지 않습니다.</p>
    <label class="field">Claude API 키<input id="sKey" type="password" value="" placeholder="${hasApiKey() ? '저장됨 · 바꿀 때만 입력' : 'sk-ant-...'}" autocomplete="off"></label>
    <label class="field">모델<select id="sModel"><option value="${esc(c.model)}">${esc(c.model || '키 입력 후 "모델 불러오기"')}</option></select></label>
    <button class="btn block" id="sLoad">모델 불러오기 · 연결 확인</button>
    <label class="field">근무표 비밀번호 (모든 사용자가 같은 비밀번호로 엽니다)<input id="sPw" type="password" value="${esc(c.pw || LS.get('pw') || '')}" autocomplete="new-password"></label>
    <h4>GitHub 게시 (앱이 올라가 있는 저장소)</h4>
    <label class="field">계정(owner)<input id="sOwner" value="${esc(c.gh.owner)}" autocapitalize="off"></label>
    <label class="field">저장소(repo)<input id="sRepo" value="${esc(c.gh.repo)}" autocapitalize="off"></label>
    <label class="field">브랜치<input id="sBranch" value="${esc(c.gh.branch || 'main')}" autocapitalize="off"></label>
    <label class="field">데이터 파일 경로<input id="sPath" value="${esc(c.gh.path || App.DATA_URL)}" autocapitalize="off"></label>
    <label class="field">GitHub 토큰 (Contents 쓰기 권한)<input id="sTok" type="password" value="" placeholder="${legacySec()?.token || LS.get('adminSec')?.hasToken ? '저장됨 · 바꿀 때만 입력' : 'github_pat_...'}" autocomplete="off"></label>
    <button class="btn block" id="sGh">GitHub 연결 확인</button>
    <h4>관리자 PIN</h4>
    <label class="field">키·토큰을 이 PIN으로 암호화해 저장합니다 (4자리 이상)<input id="sPin" type="password" inputmode="numeric" autocomplete="new-password" placeholder="${LS.get('adminSec') ? '정해져 있음 · 바꿀 때만 입력' : '새 PIN'}"></label>
    ${busyHtml}
    <button class="btn primary block" id="sSave">저장</button>${back()}</div>`);
  bindBack();
  // 키·토큰은 jc.admin에 넣지 않는다 (PIN 암호화 → jc.adminSec)
  const read = () => ({ model: $('sModel').value, pw: $('sPw').value,
    gh: { owner: $('sOwner').value.trim(), repo: $('sRepo').value.trim(), branch: $('sBranch').value.trim() || 'main', path: $('sPath').value.trim() || App.DATA_URL } });
  $('sLoad').onclick = async () => {
    busy('모델 목록을 불러오는 중…');
    try {
      const ms = await listModels($('sKey').value.trim() || (await secrets()).apiKey);
      const cur = $('sModel').value;
      const pref = ms.find(m => m.id === cur) || ms.find(m => /sonnet/i.test(m.id)) || ms[0];
      $('sModel').innerHTML = ms.map(m => `<option value="${esc(m.id)}" ${m.id === pref?.id ? 'selected' : ''}>${esc(m.name)} (${esc(m.id)})</option>`).join('');
      toast(`연결됨 · 모델 ${ms.length}개`);
    } catch (e) { toast('연결 실패: ' + e.message); }
    busy('');
  };
  $('sGh').onclick = async () => {
    const g = read().gh; busy('GitHub 확인 중…');
    try { const token = $('sTok').value.trim() || (await secrets()).token; const r = await fetch(`https://api.github.com/repos/${g.owner}/${g.repo}`, { headers: ghHeaders(token) }); const j = await r.json();
      if (!r.ok) throw new Error(j.message || r.status);
      toast(j.permissions?.push ? '쓰기 권한 확인됨' : '저장소는 보이지만 쓰기 권한이 없습니다');
    } catch (e) { toast('GitHub 실패: ' + e.message); }
    busy('');
  };
  $('sSave').onclick = async () => {
    const n = read();
    if (n.pw && n.pw.length < 6) return toast('비밀번호는 6자 이상으로 해 주세요');
    const blob = LS.get('blob');
    if (n.pw && blob) {
      const same = await Crypt.open(blob, n.pw).then(() => true, () => false);
      if (!same && !confirm('게시된 근무표와 다른 비밀번호입니다.\n이대로 게시하면 모든 사용자가 새 비밀번호를 입력해야 합니다.\n바꿀까요?')) return;
    }
    // 키·토큰: 새로 넣은 것 + (안 넣은 칸은) 기존 것을 PIN으로 암호화해 저장
    const keyIn = $('sKey').value.trim(), tokIn = $('sTok').value.trim(), pinIn = $('sPin').value;
    if (pinIn && pinIn.length < 4) return toast('PIN은 4자리 이상으로 해 주세요');
    let old = { apiKey: '', token: '' };
    try { if ((!keyIn || !tokIn) && hasSec()) old = await secrets(); } catch (e) { return toast(e.message); }
    const next = { apiKey: keyIn || old.apiKey, token: tokIn || old.token }, pin = pinIn || PIN;
    if ((next.apiKey || next.token) && !pin) return toast('관리자 PIN을 정해 주세요');
    if (next.apiKey || next.token) { LS.set('adminSec', { ...(await Crypt.seal(next, pin)), hasKey: !!next.apiKey, hasToken: !!next.token }); SEC = next; PIN = pin; }
    LS.set('admin', n); if (n.pw && !blob) LS.set('pw', n.pw); toast('저장했습니다'); open();
  };
}
const ghHeaders = token => ({ Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + token, 'X-GitHub-Api-Version': '2022-11-28' });

/* ------------------------------------------------------------ 새 달 */
function newMonth() {
  pickFile('.xlsx', async f => {
    openSheet(`<div class="admin stack"><h3>새 달 근무표</h3><p class="sub">${esc(f.name)}</p>${busyHtml}<div id="nm"></div>${back()}</div>`); bindBack();
    busy('엑셀 읽는 중…');
    try {
      const book = await Engine.readXlsx(await f.arrayBuffer());
      const ex = Engine.extractBook(book, f.name);
      const base = A.draft || App.S.data;
      const draft = { ...ex, cfg: clone(base?.cfg || Engine.DEFAULT_CFG), ...(base?.duty ? { duty: clone(base.duty) } : {}), updatedAt: now(), log: [...(base?.log || []).slice(-40), { at: now(), what: `${ex.Y}년 ${ex.M}월 근무표 등록 (${f.name})` }] };
      draft.memoChanged = Engine.memoDiff(base?.units, ex.units);
      const res = Engine.compute(draft);
      busy('');
      let html = `<div class="card" style="box-shadow:none;border:1px solid var(--line)"><div class="kv">
        <span>기간</span><b>${ex.Y}년 ${ex.M}월 (${ex.nDays}일)</b><span>휴일</span><b>${ex.holidays.join(', ')}일</b>
        <span>처리한 과</span><b>${ex.units.length}개</b><span>제외</span><b>${esc(ex.skipped.join(', '))}</b>
        <span>확인 필요</span><b>${res.rows.filter(r => r.warn).length}줄</b></div>
        ${ex.issues.map(t => `<div class="wt" style="color:var(--warn);font-size:13px">⚠ ${esc(t)}</div>`).join('')}
        <label class="field">연월이 틀리면 고치기<input id="nmYm" value="${ex.Y}-${String(ex.M).padStart(2, '0')}"></label>
        <label class="field">휴일(일자, 쉼표)<input id="nmHol" value="${ex.holidays.join(',')}"></label></div>`;
      html += res.changed.length ? `<div class="banner">메모와 번호 규칙이 다른 과 ${res.changed.length}곳: ${esc(res.changed.map(c => c.name).join(', '))}</div>` : '<div class="banner" style="background:var(--accent-soft);color:var(--accent)">메모의 번호·교수 이름이 기존 규칙과 모두 일치합니다. 팀 이동 같은 변화는 Claude 검토로 확인하세요.</div>';
      html += memoDiffHtml(draft.memoChanged);
      html += `<button class="btn primary block" id="nmAi">Claude로 메모 전체 검토</button><div id="nmAiOut" class="diff"></div>
        <button class="btn block" id="nmApply">이 근무표로 미리보기 (게시 전)</button>`;
      $('nm').innerHTML = html;
      const fix = () => {
        const [y, m] = $('nmYm').value.split('-').map(Number);
        const hol = $('nmHol').value.split(/[,\s]+/).map(Number).filter(Boolean);
        if (y !== draft.Y || m !== draft.M || hol.join() !== draft.holidays.join()) {
          const ex2 = Engine.extractBook(book, f.name, { ym: [y, m], holidays: hol }); Object.assign(draft, ex2, { cfg: draft.cfg, duty: draft.duty, memoChanged: draft.memoChanged, updatedAt: draft.updatedAt, log: draft.log });
        }
      };
      $('nmAi').onclick = async () => { fix(); await review(draft, $('nmAiOut')); };
      if (hasApiKey()) { $('nmAi').textContent = 'Claude로 메모 다시 검토'; fix(); review(draft, $('nmAiOut')); }   // 키가 있으면 자동 검토
      $('nmApply').onclick = () => { fix(); A.draft = draft; A.dirty = true; setData(clone(draft)); toast('미리보기로 바꿨습니다. 확인 후 게시하세요'); open(); };
    } catch (e) { busy(''); $('nm').innerHTML = `<div class="banner">${esc(e.message)}</div>`; }
  });
}
async function review(draft, out, keys) {
  const units = draft.units.filter(u => !keys || keys.includes(u.key)).map(u => ({ key: u.key, name: u.name, memo: u.memo.slice(0, 3000), current_rule: draft.cfg[ruleKey(u)] ?? null,
    local_check: Engine.ruleCheck(u, draft.cfg), memo_changed_lines: (draft.memoChanged || {})[u.key] || null, note: ['EYE', 'PS', 'REHAB', 'OS', 'DERM'].includes(ruleKey(u)) ? '교수-PA 짝은 메모에서 매번 자동으로 읽음(규칙 없음)' : '' }));
  busy('Claude가 메모를 검토하는 중… (30초~1분)');
  try {
    const r = await claude({ system: DOMAIN, tool: REVIEW_TOOL, content: [{ type: 'text', text:
      `${draft.Y}년 ${draft.M}월 근무표의 과별 번호 안내 메모와 현재 번호 규칙입니다. 메모가 규칙과 달라진 곳(번호 변경, 교수 추가·삭제·팀 이동, 시간대·인원별 규칙 변경, 새 예외)을 찾아 주세요. memo_changed_lines는 지난 자료와 달라진 메모 줄입니다(있으면 특히 살펴 주세요).\n` +
      `규칙이 바뀌어야 하면 status=changed와 함께 그 과의 새 규칙 전체를 cfg로 주세요(키·구조는 현재와 동일). current_rule이 null인 과는 cfg 없이 summary만.\n\n` + JSON.stringify(units) }] });
    busy('');
    const list = (r.units || []).filter(x => x.status !== 'ok');
    out.innerHTML = `<div class="diffItem"><b>${esc(r.overall || '')}</b><span style="font-size:13px;color:var(--muted)">문제없음 ${(r.units || []).filter(x => x.status === 'ok').length}곳 · 확인 ${list.length}곳</span></div>` +
      list.map((x, i) => {
        const old = draft.cfg[ruleKey({ key: x.key })];
        const can = x.status === 'changed' && x.cfg && old && sameShape(old, x.cfg);
        return `<div class="diffItem"><label>${can ? `<input type="checkbox" data-i="${i}" checked>` : ''}${esc(draft.units.find(u => u.key === x.key)?.name || x.key)} · ${x.status === 'changed' ? '변경' : '확인 필요'}</label>
          <div style="font-size:13.5px">${esc(x.summary)}</div>${x.question ? `<div class="wt">? ${esc(x.question)}</div>` : ''}
          ${x.cfg ? `<pre>${esc(diffText(old, x.cfg))}</pre>` : ''}${x.cfg && !can ? '<div class="wt">규칙 구조가 달라 자동 적용하지 않습니다. "번호 규칙 보기·수정"에서 직접 고치세요.</div>' : ''}</div>`;
      }).join('') + (list.some(x => x.cfg) ? '<button class="btn primary block" id="rvApply">선택한 규칙 변경 적용</button>' : '');
    const b = out.querySelector('#rvApply');
    if (b) b.onclick = () => {
      out.querySelectorAll('[data-i]:checked').forEach(c => { const x = list[+c.dataset.i]; draft.cfg[ruleKey({ key: x.key })] = x.cfg; draft.log.push({ at: now(), what: `${x.key} 번호 규칙 변경: ${x.summary}` }); });
      toast('규칙에 반영했습니다. 미리보기로 확인하세요');
    };
  } catch (e) { busy(''); out.innerHTML = `<div class="banner">${esc(e.message)}</div>`; }
}
function sameShape(a, b) {
  if (Array.isArray(a)) return Array.isArray(b);
  if (a && typeof a === 'object') return b && typeof b === 'object' && !Array.isArray(b) && Object.keys(a).every(k => k in b);
  return typeof b !== 'object';
}
function diffText(a, b) {
  const fa = flat(a), fb = flat(b), out = [];
  for (const k of new Set([...Object.keys(fa), ...Object.keys(fb)])) if (fa[k] !== fb[k]) out.push(`${k}: ${fa[k] ?? '(없음)'} → ${fb[k] ?? '(삭제)'}`);
  return out.join('\n') || '(값 변화 없음)';
}
function flat(o, p = '', r = {}) { if (o && typeof o === 'object') { for (const [k, v] of Object.entries(o)) flat(v, p ? p + '.' + k : k, r); } else r[p] = String(o); return r; }

/* ------------------------------------------------------------ 부서 수정 */
function fixDept() {
  const d = A.draft;
  openSheet(`<div class="admin stack"><h3>부서 근무표 수정</h3><p class="sub">수정된 부서 근무표를 엑셀이나 사진으로 올리면 그 부서만 바꿉니다</p>
    <label class="field">부서<select id="fxU">${d.units.map((u, i) => `<option value="${i}">${esc(u.name)}</option>`).join('')}</select></label>
    <label class="check"><input type="checkbox" id="fxDrop">올린 자료에 없는 간호사는 이 부서에서 빼기</label>
    <button class="btn primary block" id="fxPhoto">사진으로 (여러 장 가능)</button>
    <button class="btn block" id="fxXlsx">엑셀로</button>${busyHtml}<div id="fxOut"></div>${back()}</div>`);
  bindBack();
  $('fxPhoto').onclick = () => pickFile('image/*', fs => fromImages(+$('fxU').value, fs), true);
  $('fxXlsx').onclick = () => pickFile('.xlsx', f => fromXlsx(+$('fxU').value, f));
}
async function shrink(file) {
  const bmp = await createImageBitmap(file); const s = Math.min(1, 1800 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas'); c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.88).split(',')[1];
}
function deptPrompt(u, d, extra) {
  const grid = Engine.unitToGrid(u, d.nDays).map(r => r.join('\t')).join('\n');
  return `${d.Y}년 ${d.M}월(${d.nDays}일) "${u.name}" 근무표가 수정되었습니다. ${extra}\n` +
    `codes와 marks는 길이 ${d.nDays}의 배열(1일~${d.nDays}일)로, 자료에 없는 날은 null로 두세요. 코드 표기는 원본 그대로(팀 글자는 소문자, ★ 유지).\n` +
    `기존 명단과 같은 사람은 이름 표기를 기존과 똑같이 맞추세요. 메모(번호 안내)가 바뀌었으면 memo_changes에 적고, 번호 규칙이 바뀌어야 하면 cfg에 새 규칙 전체를 주세요.\n\n` +
    `[현재 저장된 근무표 (#노랑/#파랑은 셀 색)]\n${grid}\n\n[현재 메모]\n${u.memo}\n\n[현재 번호 규칙]\n${JSON.stringify(d.cfg[ruleKey(u)] ?? null)}`;
}
async function fromImages(ui, files) {
  const d = A.draft, u = d.units[ui];
  busy(`사진 ${files.length}장 준비 중…`);
  try {
    const imgs = []; for (const f of files) imgs.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: await shrink(f) } });
    busy('Claude가 사진을 읽는 중… (1분 정도)');
    const r = await claude({ system: DOMAIN, tool: DEPT_TOOL, content: [...imgs, { type: 'text', text: deptPrompt(u, d, '첨부 사진에서 이 부서 근무표를 읽어 주세요. 셀 배경색(노랑/파랑)도 확인하세요.') }] });
    busy(''); showDeptDiff(ui, r);
  } catch (e) { busy(''); $('fxOut').innerHTML = `<div class="banner">${esc(e.message)}</div>`; }
}
async function fromXlsx(ui, f) {
  const d = A.draft, u = d.units[ui];
  busy('엑셀 읽는 중…');
  try {
    const book = await Engine.readXlsx(await f.arrayBuffer());
    let found = null;
    try {
      const ex = Engine.extractBook(book, f.name, { ym: [d.Y, d.M], holidays: d.holidays });
      found = ex.units.find(x => x.key === u.key) || ex.units.find(x => x.name.replace(/\s/g, '') === u.name.replace(/\s/g, ''));
      if (!found && ex.units.length === 1) found = ex.units[0];
    } catch {}
    if (found) {
      busy('');
      const { unit, keptMemo } = Engine.mergeRevised(u, found);
      return showDeptDiff(ui, { nurses: unit.nurses, memo_changes: !keptMemo && unit.memo !== u.memo ? '엑셀의 메모가 기존과 다릅니다' : '', notes: keptMemo ? '엑셀에서 직접 읽음 · 메모가 없어 기존 번호 안내 유지' : '엑셀에서 직접 읽음' }, unit);
    }
    // 양식이 달라 자동 인식이 안 되면 표를 글로 바꿔 Claude에게
    const rows = []; for (let r = 1; r <= Math.min(book.maxRow, 120); r++) { const row = book.grid.get(r); if (!row) continue; const cells = []; for (let c = 1; c <= Math.min(book.maxCol, 50); c++) { const x = row.get(c); cells.push((x?.v ?? '') + (x?.fill && /FFC000|FFFF00/.test(x.fill) ? '#노랑' : '')); } rows.push(cells.join('\t').replace(/\t+$/, '')); }
    busy('양식이 달라 Claude가 표를 읽는 중…');
    const res = await claude({ system: DOMAIN, tool: DEPT_TOOL, content: [{ type: 'text', text: deptPrompt(u, d, '아래는 수정본 엑셀의 셀 내용(탭 구분)입니다.') + '\n\n[수정본 엑셀]\n' + rows.join('\n') }] });
    busy(''); showDeptDiff(ui, res);
  } catch (e) { busy(''); $('fxOut').innerHTML = `<div class="banner">${esc(e.message)}</div>`; }
}
function mergeUnit(u, r, drop, nDays) {
  const nu = clone(u); const key = s => String(s).replace(/\s/g, '');
  const seen = new Set();
  for (const n of r.nurses || []) {
    let t = nu.nurses.find(x => key(x.name) === key(n.name));
    if (!t) { t = { name: n.name, info: n.info || '', codes: Array(nDays).fill(''), marks: Array(nDays).fill('') }; nu.nurses.push(t); }
    seen.add(t);
    if (n.info) t.info = n.info;
    for (let i = 0; i < nDays; i++) {
      if (n.codes?.[i] != null) t.codes[i] = String(n.codes[i]).trim();
      if (n.marks?.[i] != null) t.marks[i] = n.marks[i] === 'Y' || n.marks[i] === 'B' ? n.marks[i] : '';
    }
  }
  if (drop) nu.nurses = nu.nurses.filter(x => seen.has(x));
  return nu;
}
function showDeptDiff(ui, r, wholeUnit) {
  const d = A.draft, u = d.units[ui], drop = $('fxDrop').checked;
  const nu = wholeUnit ? Object.assign(clone(wholeUnit), { key: u.key, name: u.name, kind: u.kind, order: u.order }) : mergeUnit(u, r, drop, d.nDays);
  if (wholeUnit && !drop) { // 엑셀에 없는 기존 간호사는 유지
    for (const n of u.nurses) if (!nu.nurses.some(x => x.name.replace(/\s/g, '') === n.name.replace(/\s/g, ''))) nu.nurses.push(clone(n));
  }
  let changes = 0;
  const head = `<tr><th>이름</th>${Array.from({ length: d.nDays }, (_, i) => `<th>${i + 1}</th>`).join('')}</tr>`;
  const body = nu.nurses.map(n => {
    const o = u.nurses.find(x => x.name.replace(/\s/g, '') === n.name.replace(/\s/g, ''));
    return `<tr><td class="nm">${esc(n.name)}${o ? '' : ' <span class="badge">새로</span>'}</td>${n.codes.map((c, i) => {
      const ch = !o || o.codes[i] !== c || (o.marks?.[i] || '') !== (n.marks?.[i] || ''); if (ch && o) changes++;
      return `<td class="${ch ? 'chg' : ''}" title="${o ? esc(o.codes[i]) + ' → ' : ''}${esc(c)}">${esc(c)}${n.marks?.[i] === 'Y' ? '🟨' : n.marks?.[i] === 'B' ? '🟦' : ''}</td>`;
    }).join('')}</tr>`;
  }).join('');
  const removed = u.nurses.filter(o => !nu.nurses.some(n => n.name.replace(/\s/g, '') === o.name.replace(/\s/g, '')));
  $('fxOut').innerHTML = `<div class="stack"><div class="kv"><span>바뀐 칸</span><b>${changes}칸</b><span>새 간호사</span><b>${nu.nurses.filter(n => !u.nurses.some(o => o.name.replace(/\s/g, '') === n.name.replace(/\s/g, ''))).length}명</b>${removed.length ? `<span>빠지는 간호사</span><b>${esc(removed.map(n => n.name).join(', '))}</b>` : ''}</div>
    ${r.memo_changes ? `<div class="banner">메모 변경: ${esc(r.memo_changes)}</div>` : ''}${r.notes ? `<div class="wt" style="color:var(--muted)">${esc(r.notes)}</div>` : ''}
    ${r.cfg ? `<div class="diffItem"><label><input type="checkbox" id="fxCfg" checked>번호 규칙도 바꾸기</label><pre>${esc(diffText(d.cfg[ruleKey(u)], r.cfg))}</pre></div>` : ''}
    <div class="gridwrap"><table>${head}${body}</table></div>
    <button class="btn primary block" id="fxApply">이대로 반영 (게시 전 미리보기)</button></div>`;
  const fc = $('fxOut').querySelector('td.chg'); if (fc) fc.scrollIntoView({ block: 'nearest', inline: 'center' });
  // 수정본 엑셀의 메모가 바뀌었으면 그 과만 Claude 검토(키가 있을 때). 적용한 규칙은 "이대로 반영" 때 함께 들어간다
  const md = wholeUnit ? Engine.memoDiff([u], [nu]) : {};
  let tmp = null;
  if (md[u.key] && hasApiKey()) {
    tmp = { ...d, cfg: clone(d.cfg), log: [], memoChanged: md, units: d.units.map((x, i) => i === ui ? nu : x) };
    $('fxOut').insertAdjacentHTML('beforeend', '<div id="fxAi" class="diff" style="margin-top:8px"></div>'); review(tmp, $('fxAi'), [u.key]);
  }
  $('fxApply').onclick = () => {
    if (md[u.key]) d.memoChanged = { ...(d.memoChanged || {}), ...md };
    if (tmp?.log.length) { d.cfg[ruleKey(u)] = tmp.cfg[ruleKey(u)]; d.log = [...(d.log || []), ...tmp.log]; }
    d.units[ui] = nu;
    if (r.cfg && $('fxCfg')?.checked && sameShape(d.cfg[ruleKey(u)], r.cfg)) d.cfg[ruleKey(u)] = r.cfg;
    if (r.memo_changes && !wholeUnit) { d.manualWarn = d.manualWarn || {}; d.manualWarn[u.key] = `수정본 메모 변경: ${r.memo_changes}`; }
    d.updatedAt = now(); d.log = [...(d.log || []), { at: now(), what: `${u.name} 근무표 수정 (${changes}칸)` }];
    A.dirty = true; setData(clone(d)); toast(`${u.name} 반영 · 게시해야 다른 사람에게 보입니다`); open();
  };
}

/* ------------------------------------------------------------ 규칙 직접 수정 */
function rules() {
  const d = A.draft, keys = Object.keys(d.cfg).filter(k => !k.startsWith('_'));
  openSheet(`<div class="admin stack"><h3>번호 규칙</h3><p class="sub">근무표 메모에 글로 적힌 번호 규칙입니다. 구조(키)는 유지하고 값만 고치세요.</p>
    <label class="field">과<select id="rk">${keys.map(k => `<option>${k}</option>`).join('')}</select></label>
    <label class="field">메모 원문<textarea id="rmemo" readonly style="min-height:110px"></textarea></label>
    <label class="field">규칙(JSON)<textarea id="rj"></textarea></label>
    <button class="btn primary block" id="rs">저장 (게시 전 미리보기)</button>
    <label class="field">고정으로 붙일 ⚠ 문구 (비우면 없음)<input id="rw"></label>${back()}</div>`);
  bindBack();
  const unitOf = k => d.units.find(u => ruleKey(u) === k);
  const load = () => { const k = $('rk').value; $('rj').value = JSON.stringify(d.cfg[k], null, 1); $('rmemo').value = (unitOf(k)?.memo || '').replace(/ ¦ /g, '\n'); $('rw').value = (d.manualWarn || {})[unitOf(k)?.key] || ''; };
  $('rk').onchange = load; load();
  $('rs').onclick = () => {
    const k = $('rk').value; let v;
    try { v = JSON.parse($('rj').value); } catch { return toast('JSON 형식이 맞지 않습니다'); }
    if (!sameShape(d.cfg[k], v)) return toast('기존 규칙과 구조가 다릅니다');
    d.cfg[k] = v; const u = unitOf(k); d.manualWarn = d.manualWarn || {};
    if (u) { if ($('rw').value.trim()) d.manualWarn[u.key] = $('rw').value.trim(); else delete d.manualWarn[u.key]; }
    d.updatedAt = now(); d.log = [...(d.log || []), { at: now(), what: `${k} 번호 규칙 직접 수정` }];
    A.dirty = true; setData(clone(d)); toast('저장했습니다'); open();
  };
}

/* ------------------------------------------------------------ 메모 변경 (지난 자료와 다른 문구) */
function memoDiffHtml(mc) {
  const ks = Object.keys(mc || {});
  if (!ks.length) return '';
  return `<div class="banner">메모가 지난 자료와 바뀐 과 ${ks.length}곳 — 비고·번호 규칙을 고쳐야 하는지 확인하세요</div><div class="diff">${ks.map(k => `<div class="diffItem"><b>${esc(mc[k].name)}</b>
    ${mc[k].added.map(t => `<div class="wt" style="color:var(--ok)">+ ${esc(t)}</div>`).join('')}${mc[k].removed.map(t => `<div class="wt" style="color:var(--bad)">− ${esc(t)}</div>`).join('')}</div>`).join('')}</div>`;
}
function memoView() {
  openSheet(`<div class="admin stack"><h3>메모 바뀐 과</h3>${memoDiffHtml(A.draft.memoChanged)}
    <button class="btn block" id="mvClear">확인 완료 (표시 지우기)</button>${back()}</div>`); bindBack();
  $('mvClear').onclick = () => { const d = A.draft; d.memoChanged = {}; d.updatedAt = now(); A.dirty = true; setData(clone(d)); toast('표시를 지웠습니다 · 게시하면 사용자 화면에서도 사라집니다'); open(); };
}

/* ------------------------------------------------------------ 당직표 (교수 당직) — 근무표와 따로 올리고 고친다 */
const DUTY_TOOL = {
  name: 'report_duty_section', description: '사진에서 읽은 한 과의 당직표',
  input_schema: { type: 'object', properties: {
    rows: { type: 'array', items: { type: 'object', properties: {
      label: { type: 'string', description: '당직 줄 이름(시간대·구분). 기존 줄과 같으면 표기를 똑같이' },
      cells: { type: 'array', items: { type: ['string', 'null'] }, description: '1일~말일 칸 내용(교수 이름·코드 원문 그대로). 사진에 없거나 못 읽은 날은 null' } }, required: ['label', 'cells'] } },
    contacts_changed: { type: 'string', description: '연락처·call 순서 메모가 기존과 달라졌으면 내용, 아니면 빈 문자열' },
    notes: { type: 'string', description: '읽기 어려웠던 칸 등 관리자에게 알릴 점' } }, required: ['rows'] },
};
function dutyNew() {
  pickFile('.xlsx', async f => {
    openSheet(`<div class="admin stack"><h3>새 달 당직표</h3><p class="sub">${esc(f.name)}</p>${busyHtml}<div id="dn"></div>${back()}</div>`); bindBack();
    busy('엑셀 읽는 중…');
    try {
      const book = await Engine.readXlsx(await f.arrayBuffer());
      const du = Engine.extractDuty(book, f.name), d = A.draft;
      const on = du.sections.filter(s => s.rows.some(x => x.cells.some(Boolean))), off = du.sections.filter(s => !on.includes(s));
      busy('');
      $('dn').innerHTML = `<div class="card" style="box-shadow:none;border:1px solid var(--line)"><div class="kv">
        <span>기간</span><b>${du.Y}년 ${du.M}월 (${du.nDays}일)</b><span>입력된 과</span><b>${on.length}개</b>
        <span>미입력</span><b>${esc(off.map(s => s.name).join(', ') || '없음')}</b><span>연락처</span><b>${du.sections.reduce((n, s) => n + s.contacts.length, 0)}명</b></div>
        ${du.issues.map(t => `<div class="wt" style="color:var(--warn);font-size:13px">⚠ ${esc(t)}</div>`).join('')}
        ${d && (d.Y !== du.Y || d.M !== du.M) ? `<div class="wt" style="color:var(--warn);font-size:13px">⚠ 근무표는 ${d.Y}년 ${d.M}월입니다. 당직 탭은 근무표와 같은 달일 때 날짜가 맞습니다.</div>` : ''}</div>
        <button class="btn primary block" id="dnApply">이 당직표로 미리보기 (게시 전)</button>`;
      $('dnApply').onclick = () => {
        d.duty = du; d.updatedAt = now(); d.log = [...(d.log || []), { at: now(), what: `${du.Y}년 ${du.M}월 당직표 등록 (${f.name})` }];
        A.dirty = true; setData(clone(d)); toast('미리보기로 바꿨습니다. 확인 후 게시하세요'); open();
      };
    } catch (e) { busy(''); $('dn').innerHTML = `<div class="banner">${esc(e.message)}</div>`; }
  });
}
function dutyFix() {
  const du = A.draft.duty;
  openSheet(`<div class="admin stack"><h3>부서 당직표 수정</h3><p class="sub">수정된 당직표를 엑셀이나 사진으로 올리면 그 과만 바꿉니다</p>
    <label class="field">과<select id="dfS">${du.sections.map((s, i) => `<option value="${i}">${esc(s.name)}</option>`).join('')}</select></label>
    <button class="btn primary block" id="dfPhoto">사진으로 (여러 장 가능)</button>
    <button class="btn block" id="dfXlsx">엑셀로</button>${busyHtml}<div id="dfOut"></div>${back()}</div>`);
  bindBack();
  $('dfPhoto').onclick = () => pickFile('image/*', fs => dutyFromImages(+$('dfS').value, fs), true);
  $('dfXlsx').onclick = () => pickFile('.xlsx', f => dutyFromXlsx(+$('dfS').value, f));
}
async function dutyFromXlsx(si, f) {
  const du = A.draft.duty, s = du.sections[si];
  busy('엑셀 읽는 중…');
  try {
    const ex = Engine.extractDuty(await Engine.readXlsx(await f.arrayBuffer()), f.name, { ym: [du.Y, du.M], holidays: du.holidays });
    const n = ex.sections.find(x => x.key === s.key) || (ex.sections.length === 1 ? ex.sections[0] : null);
    if (!n) throw new Error(`엑셀에서 "${s.name} 당직표"를 찾지 못했습니다`);
    // 수정본에 연락처·메모가 없으면 기존 것 유지
    const ns = { ...n, key: s.key, name: s.name, contacts: n.contacts.length ? n.contacts : s.contacts, notes: n.notes.length ? n.notes : s.notes, chief: n.chief || s.chief };
    busy(''); showDutyDiff(si, ns, n.contacts.length ? '' : '수정본에 연락처가 없어 기존 연락처 유지');
  } catch (e) { busy(''); $('dfOut').innerHTML = `<div class="banner">${esc(e.message)}</div>`; }
}
async function dutyFromImages(si, files) {
  const du = A.draft.duty, s = du.sections[si];
  busy(`사진 ${files.length}장 준비 중…`);
  try {
    const imgs = []; for (const f of files) imgs.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: await shrink(f) } });
    busy('Claude가 사진을 읽는 중… (1분 정도)');
    const grid = Engine.dutyToGrid(s, du.nDays).map(r => r.join('\t')).join('\n');
    const r = await claude({ system: DOMAIN, tool: DUTY_TOOL, content: [...imgs, { type: 'text', text:
      `${du.Y}년 ${du.M}월(${du.nDays}일) "${s.name}" 교수 당직표가 수정되었습니다. 첨부 사진에서 이 과의 당직표를 읽어 주세요.\n` +
      `cells는 길이 ${du.nDays}의 배열(1일~${du.nDays}일). 칸에 적힌 이름·코드를 원문 그대로, 사진에 없는 날은 null.\n` +
      `[현재 저장된 당직표 (줄 이름 탭 1일…)]\n${grid}\n\n[연락처]\n${s.contacts.map(c => `${c.code ? c.code + ' ' : ''}${c.role ? c.role + ' ' : ''}${c.name}`).join(', ')}` }] });
    const ns = clone(s);
    for (const row of r.rows || []) {
      let t = ns.rows.find(x => x.label.replace(/\s/g, '') === String(row.label).replace(/\s/g, ''));
      if (!t) { t = { sub: '', label: row.label, cells: Array(du.nDays).fill('') }; ns.rows.push(t); }
      (row.cells || []).forEach((c, k) => { if (c != null && k < du.nDays) t.cells[k] = String(c).trim(); });
    }
    busy(''); showDutyDiff(si, ns, [r.contacts_changed && `연락처·메모 변경: ${r.contacts_changed}`, r.notes].filter(Boolean).join(' · '));
  } catch (e) { busy(''); $('dfOut').innerHTML = `<div class="banner">${esc(e.message)}</div>`; }
}
function showDutyDiff(si, ns, msg) {
  const du = A.draft.duty, s = du.sections[si];
  let changes = 0;
  const head = `<tr><th>줄</th>${Array.from({ length: du.nDays }, (_, i) => `<th>${i + 1}</th>`).join('')}</tr>`;
  const body = ns.rows.map(x => {
    const o = s.rows.find(y => y.label === x.label && y.sub === x.sub);
    return `<tr><td class="nm">${esc((x.sub ? x.sub + ' / ' : '') + x.label)}</td>${x.cells.map((c, k) => { const ch = (o?.cells[k] || '') !== c; if (ch) changes++; return `<td class="${ch ? 'chg' : ''}">${esc(c)}</td>`; }).join('')}</tr>`;
  }).join('');
  $('dfOut').innerHTML = `<div class="stack"><div class="kv"><span>바뀐 칸</span><b>${changes}칸</b></div>
    ${msg ? `<div class="wt" style="color:var(--muted)">${esc(msg)}</div>` : ''}
    <div class="gridwrap"><table>${head}${body}</table></div>
    <button class="btn primary block" id="dfApply">이대로 반영 (게시 전 미리보기)</button></div>`;
  const fc = $('dfOut').querySelector('td.chg'); if (fc) fc.scrollIntoView({ block: 'nearest', inline: 'center' });
  $('dfApply').onclick = () => {
    const d = A.draft; d.duty.sections[si] = ns; d.updatedAt = now(); d.log = [...(d.log || []), { at: now(), what: `${s.name} 당직표 수정 (${changes}칸)` }];
    A.dirty = true; setData(clone(d)); toast(`${s.name} 당직표 반영 · 게시해야 다른 사람에게 보입니다`); open();
  };
}

/* ------------------------------------------------------------ 게시 · 내보내기 */
function saveBlob(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); }
async function sealed() { const c = cfgA(); if (!c.pw) throw new Error('관리자 설정에서 근무표 비밀번호를 정해 주세요'); return Crypt.seal(A.draft, c.pw); }
const utf8b64 = s => { const u8 = new TextEncoder().encode(s); let b = ''; for (let i = 0; i < u8.length; i += 0x8000) b += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(b); };
async function publish() {
  const c = cfgA(), g = { ...c.gh };
  try { g.token = (await secrets()).token; } catch (e) { return toast(e.message); }
  if (!g.owner || !g.repo || !g.token) return toast('관리자 설정에서 GitHub 정보를 넣어 주세요');
  openSheet(`<div class="admin stack"><h3>게시</h3>${busyHtml}<div id="pbOut"></div>${back()}</div>`); bindBack();
  busy('암호화 중…');
  try {
    A.draft.updatedAt = now(); const blob = await sealed(); const body = JSON.stringify(blob);
    const url = `https://api.github.com/repos/${g.owner}/${g.repo}/contents/${g.path}`;
    busy('GitHub에 올리는 중…');
    let sha; const cur = await fetch(url + '?ref=' + encodeURIComponent(g.branch), { headers: ghHeaders(g.token) });
    if (cur.ok) sha = (await cur.json()).sha;
    const r = await fetch(url, { method: 'PUT', headers: { ...ghHeaders(g.token), 'content-type': 'application/json' },
      body: JSON.stringify({ message: `근무표 ${blob.month} 갱신 ${new Date().toLocaleString('ko-KR')}`, content: utf8b64(body), branch: g.branch, ...(sha ? { sha } : {}) }) });
    const j = await r.json(); if (!r.ok) throw new Error(j.message || r.status);
    LS.set('blob', blob); LS.set('pw', c.pw); A.dirty = false; App.S.data = clone(A.draft);
    busy(''); $('pbOut').innerHTML = `<div class="banner" style="background:var(--accent-soft);color:var(--accent)">게시했습니다. 사용자는 앱을 다시 열거나 설정 › 최신 근무표 받기를 누르면 바뀝니다. (반영까지 1~2분 걸릴 수 있습니다)</div>`;
  } catch (e) { busy(''); $('pbOut').innerHTML = `<div class="banner">${esc(e.message)}</div>`; }
}
async function exportBlob() { try { const b = await sealed(); saveBlob(new Blob([JSON.stringify(b)], { type: 'application/json' }), `콜북_${b.month}.json`); toast('파일을 저장했습니다. 메신저로 보내면 사용자가 "파일에서 불러오기"로 엽니다'); } catch (e) { toast(e.message); } }
function exportXlsx() { const d = A.draft; saveBlob(XlsxOut.buildResultXlsx(d, Engine.compute(d)), `${d.Y}-${String(d.M).padStart(2, '0')}_전담간호사_교수별_내선번호.xlsx`); }
function showLog() {
  const l = [...(A.draft.log || [])].reverse();
  openSheet(`<div class="admin stack"><h3>변경 이력</h3>${l.length ? l.map(x => `<div class="diffItem"><span style="font-size:12px;color:var(--muted)">${new Date(x.at).toLocaleString('ko-KR')}</span><span>${esc(x.what)}</span></div>`).join('') : '<p class="sub">이력이 없습니다</p>'}${back()}</div>`); bindBack();
}

window.Admin = { open, get busy() { return A.busy; }, get dirty() { return A.dirty; } };
})();
