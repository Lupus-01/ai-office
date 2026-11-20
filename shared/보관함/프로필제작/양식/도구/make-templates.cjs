// 한 번만 실행: 예시/원본 파일의 양식에서 견본 내용을 지우고 자리표시({{칸}})를 넣은 빈 틀을 만든다.
// 서식(글꼴·크기·글머리표·칸 위치)은 원본 그대로 둔다. 결과: 양식/틀/
'use strict';
const { fs, path, EXAMPLE_DIR, TEMPLATE_DIR, FIELDS, elem, all, textOf, loadZip, saveZip } = require('./profile-lib.cjs');
const SRC = path.join(EXAMPLE_DIR, '원본 파일');

// ---------- 워드 ----------
const BASE = '<w:rFonts w:eastAsiaTheme="minorHAnsi" w:hint="eastAsia"/>';
const run = (rPrInner, text) => `<w:r><w:rPr>${rPrInner}</w:rPr><w:t xml:space="preserve">${text}</w:t></w:r>`;
const paras = (xml) => all(xml, /<w:p[ >][\s\S]*?<\/w:p>/g);
// 표·행·칸의 문서 안 위치를 구한다(같은 모양의 빈칸이 여럿이라 글자 바꾸기 대신 위치로 고친다)
function cellIndex(xml) {
  const out = [];
  const tre = /<w:tbl>[\s\S]*?<\/w:tbl>/g; let t, ti = 0;
  while ((t = tre.exec(xml))) {
    const rre = /<w:tr[ >][\s\S]*?<\/w:tr>/g; let r, ri = 0;
    while ((r = rre.exec(t[0]))) {
      const cre = /<w:tc>[\s\S]*?<\/w:tc>/g; let c, ci = 0;
      while ((c = cre.exec(r[0]))) out.push({ t: ti, r: ri, c: ci++, start: t.index + r.index + c.index, xml: c[0] });
      ri++;
    }
    ti++;
  }
  return out;
}
function rebuildMarks(cell, key, names) {
  // 분야 줄: 안내문(작은 글씨) 앞의 본문 글자를 "이름 ({{키_이름}})" 꼴 한 글자 묶음으로 다시 쓴다
  const p = paras(cell)[0];
  const runs = all(p, /<w:r[ >][\s\S]*?<\/w:r>/g);
  const note = runs.filter((r) => /<w:sz w:val="16"\/>/.test(r));
  const firstMain = runs.find((r) => !note.includes(r));
  const rPr = (elem(firstMain, 'w:rPr').match(/<w:rPr>([\s\S]*)<\/w:rPr>/) || [, BASE])[1];
  const text = names.map((n) => `${n} ({{${key}_${n}}})`).join(' ') + '  ';
  const np = `${p.slice(0, p.indexOf('>') + 1)}${elem(p, 'w:pPr')}${run(rPr, text)}${note.join('')}</w:p>`;
  return cell.replace(p, np);
}
async function makeDocx() {
  const zip = await loadZip(path.join(SRC, '상담사프로필_원본.docx'));
  let xml = await zip.file('word/document.xml').async('string');
  const edits = [];
  const at = (t, r, c) => cellIndex(xml).find((x) => x.t === t && x.r === r && x.c === c);
  const put = (t, r, c, fn) => { const cell = at(t, r, c); edits.push({ start: cell.start, end: cell.start + cell.xml.length, xml: fn(cell.xml) }); };
  const firstParaRun = (text, bold = false) => (cell) => { const p = paras(cell)[0]; return cell.replace(p, p.replace(/<\/w:p>$/, run(BASE + (bold ? '<w:b/>' : ''), text) + '</w:p>')); };
  put(0, 0, 1, firstParaRun('{{예명}}', true));
  put(0, 0, 3, (cell) => { const p = paras(cell)[0]; return cell.replace(p, `<w:p>${elem(p, 'w:pPr')}${run(BASE, '{{상담스타일}}')}</w:p>` + p); });
  put(0, 1, 1, firstParaRun('{{휴대폰}}'));
  put(0, 1, 3, firstParaRun('{{연결전화}}'));
  put(0, 2, 1, firstParaRun('{{이메일}}'));
  put(0, 3, 1, firstParaRun('{{주소}}'));
  put(0, 4, 1, (cell) => { const p = paras(cell)[0]; const first = all(p, /<w:r[ >][\s\S]*?<\/w:r>/g)[0];
    const rPr = (elem(first, 'w:rPr').match(/<w:rPr>([\s\S]*)<\/w:rPr>/) || [, BASE])[1];
    return cell.replace(p, `${p.slice(0, p.indexOf('>') + 1)}${elem(p, 'w:pPr')}${run(rPr, '은행명 : {{은행명}}   계좌번호: {{계좌번호}}   계좌주명 : {{계좌주명}}')}</w:p>`); });
  put(0, 5, 1, (cell) => rebuildMarks(cell, '분야', ['사주', '신점', '타로', '기타']));
  put(0, 6, 1, (cell) => rebuildMarks(cell, '타로', ['사주타로', '펫타로', '점성술']));
  put(1, 0, 1, (cell) => { const p = paras(cell)[0]; const pPr = elem(p, 'w:pPr');
    return cell.replace(p, `<w:p>${pPr}${run(BASE, '{{한줄카피}}')}</w:p><w:p>${pPr}${run(BASE, '{{상담태그}}')}</w:p>`); });
  // 약력·리딩: 회색 빈 문단 5개 → 검은 글씨 자리표시 문단 1개(채울 때 줄마다 복제)
  for (const [t, key] of [[2, '약력'], [3, '리딩'], [4, '특징']]) put(t, 0, 0, (cell) => {
    const ps = paras(cell); const pPr = elem(ps[0], 'w:pPr').replace(/<w:color [^>]*\/>/, '');
    return cell.replace(ps.join(''), `<w:p>${pPr}${run(BASE, `{{${key}}}`)}</w:p>`);
  });
  for (const e of edits.sort((a, b) => b.start - a.start)) xml = xml.slice(0, e.start) + e.xml + xml.slice(e.end);
  zip.file('word/document.xml', xml);
  const out = path.join(TEMPLATE_DIR, '상담사프로필_틀.docx');
  await saveZip(zip, out);
  return out;
}

// ---------- PPT ----------
function placeholder(p, key, tweak) {
  // 한글이 든 글자 묶음의 서식을 쓴다(숫자로 시작하는 묶음은 영문 서식이라 한글 글꼴이 빠질 수 있다)
  const runs = all(p, /<a:r>[\s\S]*?<\/a:r>/g);
  const korean = runs.find((r) => /[가-힣]/.test(textOf(r, 'a:t'))) || runs[0] || '';
  let rPr = (elem(korean, 'a:rPr') || '<a:rPr lang="ko-KR" altLang="en-US"/>').replace(/ err="1"/, '');
  rPr = setAttr(setAttr(rPr, 'lang', 'ko-KR'), 'altLang', 'en-US');
  if (tweak) rPr = tweak(rPr);
  return `<a:p>${elem(p, 'a:pPr')}<a:r>${rPr}<a:t>{{${key}}}</a:t></a:r>${elem(p, 'a:endParaRPr')}</a:p>`;
}
const setAttr = (rPr, name, value) => (new RegExp(` ${name}="[^"]*"`).test(rPr) ? rPr.replace(new RegExp(` ${name}="[^"]*"`), ` ${name}="${value}"`) : rPr.replace(/^<a:rPr/, `<a:rPr ${name}="${value}"`));
function replaceParas(sp, keep, newParas) {
  const ps = all(sp, /<a:p>[\s\S]*?<\/a:p>/g);
  const start = sp.indexOf(ps[0]), end = sp.lastIndexOf(ps.at(-1)) + ps.at(-1).length;
  return sp.slice(0, start) + ps.slice(0, keep).join('') + newParas + sp.slice(end);
}
async function makePptx(field) {
  const zip = await loadZip(path.join(SRC, `프로필_${field}_원본.pptx`));
  let xml = await zip.file('ppt/slides/slide1.xml').async('string');
  const found = {};
  xml = xml.replace(/<p:sp>[\s\S]*?<\/p:sp>/g, (sp) => {
    const ps = all(sp, /<a:p>[\s\S]*?<\/a:p>/g), texts = ps.map((p) => textOf(p, 'a:t').trim());
    const joined = texts.join(' ');
    const off = sp.match(/<a:off x="(-?\d+)" y="(-?\d+)"/), y = off ? +off[2] / 91440 : 0;
    const mark = (key, value) => { found[key] = (found[key] || 0) + 1; return value; };
    if (!joined.trim()) return sp;
    if (ps.some((p) => / sz="1600"/.test(p))) return mark('이름', replaceParas(sp, 0, placeholder(ps.find((p) => / sz="1600"/.test(p)), '이름')));
    if (texts[0] === '약력사항') return mark('약력', replaceParas(sp, 1, placeholder(ps[1], '약력')));
    if (texts[0] === '리딩정보') return mark('리딩', replaceParas(sp, 1, placeholder(ps[1], '리딩')));
    if (joined.includes('카드노출형식')) return mark('추천', replaceParas(sp, 1, placeholder(ps[1], '추천', (r) => setAttr(setAttr(r, 'sz', '1000'), 'b', '1'))));
    if (texts[0].startsWith('#')) return y < 30 ? mark('상담분야', replaceParas(sp, 0, placeholder(ps[0], '상담분야'))) : mark('코멘트태그', replaceParas(sp, 0, placeholder(ps[0], '코멘트태그')));
    if (y >= 55) return mark('소개글', replaceParas(sp, 0, placeholder(ps[0], '소개글')));
    if (y >= 38 && y < 50 && !joined.startsWith('홍카페')) return mark('코멘트', replaceParas(sp, 0, placeholder(ps[0], '코멘트')));
    return sp;
  });
  const need = ['이름', '약력', '리딩', '추천', '상담분야', '코멘트태그', '소개글', '코멘트'];
  const bad = need.filter((k) => found[k] !== 1);
  if (bad.length) throw new Error(`${field} 양식에서 칸을 정확히 하나씩 찾지 못했습니다: ${bad.map((k) => `${k}(${found[k] || 0})`).join(', ')}`);
  zip.file('ppt/slides/slide1.xml', xml);
  const out = path.join(TEMPLATE_DIR, `프로필_${field}_틀.pptx`);
  await saveZip(zip, out);
  return out;
}

(async () => {
  console.log('만듦:', await makeDocx());
  for (const field of FIELDS) console.log('만듦:', await makePptx(field));
})().catch((e) => { console.error('오류:', e.message); process.exit(1); });
