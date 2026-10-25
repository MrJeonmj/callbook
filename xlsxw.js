/* 결과 엑셀 쓰기 (외부 라이브러리 없음) */
'use strict';
(function (G) {
const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(u8) { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC_T[(c ^ u8[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function zipStore(entries) { // [{name, text}]
  const enc = new TextEncoder();
  const parts = [], central = [];
  let off = 0;
  for (const e of entries) {
    const name = enc.encode(e.name), data = enc.encode(e.text), crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(8, 0, true);
    lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true);
    lh.setUint16(26, name.length, true);
    parts.push(new Uint8Array(lh.buffer), name, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true);
    ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true);
    ch.setUint16(28, name.length, true); ch.setUint32(42, off, true);
    central.push(new Uint8Array(ch.buffer), name);
    off += 30 + name.length + data.length;
  }
  const csize = central.reduce((a, b) => a + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
  end.setUint32(12, csize, true); end.setUint32(16, off, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)],
    { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}
const UNK = '알수없음';
const esc = s => String(s ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function colL(n) { let s = ''; while (n) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - m - 1) / 26; } return s; }
const XF = { def: 0, head: 1, body: 2, band: 3, warn: 4, bodyB: 5, bandB: 6, warnB: 7, bodyR: 8, bandR: 9, warnR: 10, title: 11, sub: 12, subR: 13 };
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="6"><font><sz val="10"/><name val="맑은 고딕"/><family val="3"/><charset val="129"/></font><font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="맑은 고딕"/><family val="3"/><charset val="129"/></font><font><b/><sz val="10"/><name val="맑은 고딕"/><family val="3"/><charset val="129"/></font><font><sz val="10"/><color rgb="FFC00000"/><name val="맑은 고딕"/><family val="3"/><charset val="129"/></font><font><b/><sz val="14"/><name val="맑은 고딕"/><family val="3"/><charset val="129"/></font><font><sz val="9"/><color rgb="FF666666"/><name val="맑은 고딕"/><family val="3"/><charset val="129"/></font></fonts>
<fills count="5"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF404040"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF2F2F2"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFF2CC"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FFD9D9D9"/></left><right style="thin"><color rgb="FFD9D9D9"/></right><top style="thin"><color rgb="FFD9D9D9"/></top><bottom style="thin"><color rgb="FFD9D9D9"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="14">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="3" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="4" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="0" fontId="2" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="0" fontId="2" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="0" fontId="2" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="0" fontId="3" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="0" fontId="3" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="0" fontId="3" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="5" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

function sheetXml({ title, sub, subWarn, headers, widths, data, deptIdx, startRow = 4 }) {
  const rows = [];
  const c = (ref, v, s) => v === '' || v == null ? (s ? `<c r="${ref}" s="${s}"/>` : '') : `<c r="${ref}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
  rows.push(`<row r="1">${c('A1', title, XF.title)}</row>`);
  if (sub) rows.push(`<row r="2">${c('A2', sub, subWarn ? XF.subR : XF.sub)}</row>`);
  rows.push(`<row r="${startRow}">${headers.map((h, i) => c(colL(i + 1) + startRow, h, XF.head)).join('')}</row>`);
  let prev = null, band = false;
  data.forEach((row, i) => {
    const r = startRow + 1 + i;
    if (row[deptIdx] !== prev) { band = !band; prev = row[deptIdx]; }
    const warn = String(row[row.length - 1] || '').startsWith('⚠');
    const base = warn ? 'warn' : band ? 'band' : 'body';
    rows.push(`<row r="${r}">${row.map((v, j) => {
      let k = base;
      if (j === deptIdx) k = base + 'B';
      else if (String(v ?? '').startsWith(UNK) || (warn && j === row.length - 1)) k = base + 'R';
      return c(colL(j + 1) + r, v, XF[k]);
    }).join('')}</row>`);
  });
  const last = colL(headers.length) + (startRow + data.length);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>
<sheetViews><sheetView workbookViewId="0"><pane ySplit="${startRow}" topLeftCell="A${startRow + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>
<sheetData>${rows.join('')}</sheetData>
${data.length ? `<autoFilter ref="A${startRow}:${last}"/>` : ''}
<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/>
<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/>
</worksheet>`;
}
function toBlob(sheets) {
  const entries = [];
  entries.push({ name: '[Content_Types].xml', text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>` });
  entries.push({ name: '_rels/.rels', text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` });
  const defNames = sheets.map((s, i) => s.data.length ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${esc(s.name)}'!$A$${s.startRow || 4}:$${colL(s.headers.length)}$${(s.startRow || 4) + s.data.length}</definedName>` : '').join('');
  entries.push({ name: 'xl/workbook.xml', text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets><definedNames>${defNames}</definedNames></workbook>` });
  entries.push({ name: 'xl/_rels/workbook.xml.rels', text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` });
  entries.push({ name: 'xl/styles.xml', text: STYLES });
  sheets.forEach((s, i) => entries.push({ name: `xl/worksheets/sheet${i + 1}.xml`, text: sheetXml(s) }));
  return zipStore(entries);
}
/* 교수별 결과 엑셀: 전체 · 날짜별 · 확인 필요 목록 */
function buildResultXlsx(data, res) {
  const WD = '월화수목금토일', Y = data.Y, M = data.M;
  const wd = d => WD[(new Date(Y, M - 1, d).getDay() + 6) % 7];
  const lab = d => `${M}/${String(d).padStart(2, '0')}(${wd(d)})`;
  const kind = d => data.holidays.includes(d) ? '주말·공휴일' : '평일';
  const note = r => [r.warn ? '⚠ ' + r.warn : '', r.note].filter(Boolean).join(' · ');
  const hdr = ['과', '팀/파트', '교수', '근무', '내선/연락처', '근무자', '비고'], wid = [18, 20, 14, 14, 30, 30, 50];
  const sheets = [{ name: '전체', title: `${Y}년 ${M}월 전담간호사 교수별 내선번호`, sub: '필터에서 교수 이름으로 검색 · "알수없음" = 원본만으로 번호 확정 불가(괄호 안은 추정) · 이상한 부분은 비고 앞 ⚠',
    headers: ['날짜', '구분', ...hdr], widths: [11, 10, ...wid], deptIdx: 2, data: res.rows.map(r => [lab(r.d), kind(r.d), r.dept, r.team, r.prof, r.shift, r.number, r.workers, note(r)]) }];
  for (let d = 1; d <= data.nDays; d++) {
    const rows = res.rows.filter(r => r.d === d), nw = rows.filter(r => r.warn).length;
    sheets.push({ name: lab(d).replace('/', '-'), title: `${Y}년 ${lab(d)} · ${kind(d)}`, sub: nw ? `⚠ 확인 필요 ${nw}건 (노란 줄, 비고 참고)` : '확인 필요 없음', subWarn: nw > 0,
      headers: hdr, widths: wid, deptIdx: 0, data: rows.map(r => [r.dept, r.team, r.prof, r.shift, r.number, r.workers, note(r)]) });
  }
  const seen = new Set(), wl = [];
  for (const r of res.rows) { if (!r.warn) continue; const k = [r.d, r.dept, r.team, r.shift, r.warn].join('|'); if (seen.has(k)) continue; seen.add(k); wl.push([lab(r.d), kind(r.d), r.dept, r.team, r.prof, r.shift, r.number, r.workers, '⚠ ' + r.warn]); }
  res.excluded.forEach(([d, dept, nm, why]) => wl.push([lab(d), kind(d), dept, '-', '-', 'Day', '(제외)', nm, '⚠ ' + why]));
  sheets.push({ name: '확인 필요 목록', title: '확인 필요 목록', headers: ['날짜', '구분', '과', '팀/파트', '교수', '근무', '내선/연락처', '근무자', '비고'], widths: [11, 10, 18, 20, 14, 14, 24, 26, 60], deptIdx: 2, data: wl, startRow: 3 });
  return toBlob(sheets);
}
G.XlsxOut = { buildResultXlsx };
})(window);
