// 상담사 프로필 검사: 작성기준서의 코드로 볼 수 있는 항목을 확인한다(원문 사실 대조는 검수담당이 따로 한다)
// 사용: node check-profile.cjs <내용.json> <워드.docx> <PPT.pptx> [--render] [--exclude <예시 이름>]
//   --render   LibreOffice로 두 파일의 그림을 떠서 경로를 알려 준다(그림을 열어 넘침·잘림을 직접 본다)
//   --exclude  예시 겹침 검사에서 뺄 예시 파일 이름(그 상담사 본인의 예시로 시험할 때)
'use strict';
const { spawnSync } = require('child_process');
const { fs, path, programRoot, EXAMPLE_DIR, TEMPLATE_DIR, WORKSPACE, FIELDS, TAGS, all, textOf, loadZip, docxCells, pptxShapes } = require('./profile-lib.cjs');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const excludes = args.flatMap((a, i) => (args[i - 1] === '--exclude' ? [a] : []));
const [dataFile, docxFile, pptxFile] = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--exclude');

const results = [];
const ok = (m) => results.push(['✔', m]);
const bad = (m) => results.push(['✖', m]);
const warn = (m) => results.push(['⚠', m]);
const list = (v) => (Array.isArray(v) ? v : v ? [v] : []).map((s) => String(s).trim()).filter(Boolean);
const len = (s) => [...String(s)].length;
const hashTags = (v) => list(v).map((t) => '#' + t.replace(/^#/, '').replace(/\s+/g, '')).join(' ');
const norm = (s) => String(s).normalize('NFKC').replace(/[\s​-‍⁠]+/g, '');
const sentences = (lines) => lines.join(' ').split(/(?<=[.!?。])\s+/).map((s) => s.trim()).filter(Boolean);
const range = (n, lo, hi) => n >= lo && n <= hi;

function checkData(d) {
  String(d.예명 || '').trim() ? ok(`예명: ${d.예명}`) : bad('예명이 비어 있습니다.');
  FIELDS.includes(d.분야) ? ok(`분야: ${d.분야}`) : bad(`분야가 ${FIELDS.join('·')} 중 하나가 아닙니다.`);
  const styles = list(d.상담스타일);
  styles.length === 3 ? ok(`상담 스타일 3개: ${styles.join(', ')}`) : bad(`상담 스타일이 ${styles.length}개입니다(3개).`);
  const tags = list(d.상담태그).map((t) => t.replace(/^#/, ''));
  const offList = tags.filter((t) => !TAGS.includes(t));
  tags.length === 3 && !offList.length ? ok(`상담태그 3개, 모두 목록 안: ${hashTags(tags)}`) : bad(`상담태그는 목록 안에서 3개여야 합니다(지금 ${tags.length}개${offList.length ? `, 목록 밖: ${offList.join(', ')}` : ''}).`);
  const lineRule = (label, lines, lo, hi) => {
    const long = lines.filter((l) => len(l) > 30);
    range(lines.length, lo, hi) && !long.length ? ok(`${label}: ${lines.length}줄, 모두 30자 이내`)
      : bad(`${label}: ${lines.length}줄(기준 ${lo}~${hi}줄)${long.length ? `, 30자 넘는 줄: ${long.map((l) => `"${l}"(${len(l)}자)`).join(' ')}` : ''}`);
  };
  lineRule('워드 주요 약력', list(d.약력), 1, 5);
  lineRule('워드 리딩 정보', list(d.리딩), 2, 5);
  const intro = list(d.특징), introLen = len(intro.join(' ')), introSent = sentences(intro).length;
  range(introLen, 250, 400) && range(introSent, 4, 7) ? ok(`특징과 강점(소개글): ${introSent}문장, ${introLen}자`) : bad(`특징과 강점(소개글): ${introSent}문장, ${introLen}자(기준 4~7문장, 250~400자)`);
  const p = d.PPT || {};
  const sub = (label, lines, source, lo, hi) => {
    const missing = lines.filter((l) => !source.includes(l));
    range(lines.length, lo, hi) && !missing.length ? ok(`PPT ${label}: ${lines.length}줄, 모두 워드에 있는 줄`)
      : bad(`PPT ${label}: ${lines.length}줄(기준 ${lo}~${hi}줄)${missing.length ? `, 워드에 없는 줄: ${missing.map((l) => `"${l}"`).join(' ')}` : ''}`);
  };
  sub('약력사항', list(p.약력), list(d.약력), 1, 4);
  sub('리딩정보', list(p.리딩), list(d.리딩), 2, 5);
  const comment = list(p.코멘트), commentLen = len(comment.join(' ')), commentSent = sentences(comment).length;
  commentLen <= 150 && commentLen > 0 ? ok(`홍카페 코멘트: ${commentSent}문장, ${commentLen}자`) : bad(`홍카페 코멘트: ${commentLen}자(기준 150자 이내, 비면 안 됨)`);
  if (comment.length && !range(commentSent, 2, 3)) warn(`홍카페 코멘트가 ${commentSent}문장입니다(권장 2~3문장).`);
  const rec = list(p.추천), recLen = len(rec.join(' '));
  rec.length && recLen <= 16 ? ok(`홍카페 추천: "${rec.join(' / ')}" ${recLen}자`) : bad(`홍카페 추천: ${recLen}자(기준 1~16자, 띄어쓰기 포함)`);
  const free = [d.한줄카피, ...list(d.약력), ...list(d.리딩), ...intro, ...comment, ...rec].join(' ');
  const strong = free.match(/반드시|100\s*%|적중률|무조건|확실하게\s*(?:재회|합격)|보장/g);
  if (strong) warn(`보장·수치 표현이 있습니다(${[...new Set(strong)].join(', ')}). 원문에 그대로 있는 표현인지 확인하세요.`);
  const c = d.연락처 || {};
  const empty = ['휴대폰', '연결전화', '이메일', '주소', '은행명', '계좌번호', '계좌주명'].filter((k) => !String(c[k] || '').trim());
  if (empty.length) warn(`원문에 없어 비운 연락처·계좌 칸: ${empty.join(', ')} → 보고서 확인 필요에 적으세요.`);
}

async function checkFiles(d) {
  const cells = await docxCells(docxFile);
  const cell = (t, r, c) => cells[t]?.[r]?.[c] || [];
  const same = (label, actual, expected) => (JSON.stringify(actual) === JSON.stringify(expected) ? ok(`워드 ${label} 확인`) : bad(`워드 ${label}이(가) 내용과 다릅니다: ${JSON.stringify(actual)} ≠ ${JSON.stringify(expected)}`));
  same('예명', cell(0, 0, 1)[0], String(d.예명).trim());
  same('상담 스타일', cell(0, 0, 3)[0], list(d.상담스타일).join(', '));
  const c = d.연락처 || {};
  same('휴대폰', cell(0, 1, 1)[0] || '', String(c.휴대폰 || '').trim());
  same('연결 전화', cell(0, 1, 3)[0] || '', String(c.연결전화 || '').trim());
  same('이메일', cell(0, 2, 1)[0] || '', String(c.이메일 || '').trim());
  same('주소', cell(0, 3, 1)[0] || '', String(c.주소 || '').trim());
  same('계좌(은행명·계좌번호·계좌주명)', (cell(0, 4, 1)[0] || '').replace(/\s+/g, ' ').trim(),
    `은행명 : ${String(c.은행명 || '').trim()} 계좌번호: ${String(c.계좌번호 || '').trim()} 계좌주명 : ${String(c.계좌주명 || '').trim()}`.replace(/\s+/g, ' ').trim());
  const mark = (cell(0, 5, 1)[0] || '').match(/(사주|신점|타로|기타)\s*\(\s*O\s*\)/g) || [];
  mark.length === 1 && mark[0].startsWith(d.분야) ? ok(`워드 분야 표시: ${d.분야}`) : bad(`워드 분야 표시가 맞지 않습니다: ${mark.join(', ') || '표시 없음'}`);
  same('상담태그', cell(1, 0, 1).at(-1), hashTags(d.상담태그));
  same('주요 약력', cell(2, 0, 0), list(d.약력));
  same('리딩 정보', cell(3, 0, 0), list(d.리딩));
  same('특징과 강점', cell(4, 0, 0), list(d.특징));

  const shapes = await pptxShapes(pptxFile);
  const pptLines = shapes.flatMap((s) => s.lines.map((l) => l.trim())).filter(Boolean);
  const pptText = pptLines.join('\n');
  const has = (label, line) => (pptLines.includes(line) ? ok(`PPT ${label} 확인`) : bad(`PPT에 ${label}이(가) 없습니다: "${line}"`));
  has('이름', String(d.예명).trim());
  has('상담분야(워드 상담태그와 같음)', hashTags(d.상담태그));
  has('코멘트 태그(워드 상담 스타일과 같음)', hashTags(d.상담스타일));
  const missing = [...list(d.PPT?.약력), ...list(d.PPT?.리딩), ...list(d.PPT?.코멘트), ...list(d.PPT?.추천), ...list(d.특징)].filter((l) => !pptLines.includes(l));
  missing.length ? bad(`PPT에 빠진 줄: ${missing.map((l) => `"${l}"`).join(' ')}`) : ok('PPT 약력·리딩·코멘트·추천·소개글 줄 모두 들어감');
  for (const [file, label] of [[docxFile, '워드'], [pptxFile, 'PPT']]) {
    const zip = await loadZip(file);
    const xmls = await Promise.all(Object.keys(zip.files).filter((n) => /\.xml$/.test(n)).map((n) => zip.file(n).async('string')));
    xmls.some((x) => /\{\{[^}]+\}\}/.test(x)) ? bad(`${label}에 채우지 않은 자리표시({{…}})가 남았습니다.`) : ok(`${label} 자리표시 모두 채움`);
  }
  // 실명(계좌주명)은 2~3자라도 본다. 그 밖의 값은 4자 이상만 본다(짧은 값은 다른 글자와 우연히 겹친다)
  const contact = d.연락처 || {};
  const realName = String(contact.계좌주명 || '').trim();
  const privates = Object.entries(contact).map(([k, v]) => [k, String(v || '').trim()]).filter(([k, v]) => (k === '계좌주명' ? len(v) >= 2 : len(v) >= 4)).map(([, v]) => v);
  const leaked = privates.filter((v) => norm(pptText).includes(norm(v)));
  const pattern = pptText.match(/01[016789][-\s.]?\d{3,4}[-\s.]?\d{4}|[\w.+-]+@[\w-]+\.[\w.]+/g);
  leaked.length || pattern ? bad(`PPT에 연락처·계좌·실명으로 보이는 글자가 있습니다${pattern ? `: ${pattern.join(', ')}` : ''}.`) : ok('PPT에 연락처·계좌·실명 없음');
  if (realName && len(realName) >= 2) {
    const free = [d.한줄카피, ...list(d.약력), ...list(d.리딩), ...list(d.특징), ...list(d.PPT?.코멘트), ...list(d.PPT?.추천)].join(' ');
    norm(free).includes(norm(realName)) ? bad('소개·약력·리딩·코멘트에 실명(계좌주명)이 들어 있습니다. 예명으로 바꾸세요.') : ok('소개 문구에 실명 없음');
  }
}

async function fileTexts(file) {
  const zip = await loadZip(file);
  if (/\.docx$/i.test(file)) return all(await zip.file('word/document.xml').async('string'), /<w:p[ >][\s\S]*?<\/w:p>/g).map((p) => textOf(p, 'w:t'));
  const slides = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  const out = [];
  for (const s of slides) out.push(...all(await zip.file(s).async('string'), /<a:p>[\s\S]*?<\/a:p>/g).map((p) => textOf(p, 'a:t')));
  return out;
}
function walk(dir) { return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)])); }

async function checkOverlap(d) {
  // 예시는 실제 상담사 개인정보가 있어 공유하지 않는다. 예시가 없는 PC(파트장 PC 등)는 대조할 문장이 없으니 건너뛴다(반려 사유 아님)
  if (!fs.existsSync(EXAMPLE_DIR)) return warn('예시 폴더(보관함/프로필제작/예시)가 없어 예시 겹침 검사를 건너뜁니다. 예시는 상담사 개인정보가 있어 공유하지 않는 자료입니다(반려 사유 아님).');
  const N = 15;
  const fixed = new Set();
  for (const f of walk(TEMPLATE_DIR).filter((f) => /\.(docx|pptx)$/i.test(f))) for (const t of await fileTexts(f)) { const n = norm(t); for (let i = 0; i + N <= n.length; i++) fixed.add(n.slice(i, i + N)); }
  const seen = new Map();
  const files = walk(EXAMPLE_DIR).filter((f) => /\.(docx|pptx)$/i.test(f) && !excludes.some((x) => path.basename(f).includes(x)));
  for (const f of files) for (const t of await fileTexts(f)) { const n = norm(t); for (let i = 0; i + N <= n.length; i++) { const w = n.slice(i, i + N); if (!fixed.has(w) && !seen.has(w)) seen.set(w, path.basename(f)); } }
  const lines = [...new Set([d.한줄카피, ...list(d.약력), ...list(d.리딩), ...list(d.특징), ...list(d.PPT?.코멘트), ...list(d.PPT?.추천)].map((s) => String(s || '').trim()).filter(Boolean))];
  const hits = [];
  for (const line of lines) {
    const n = norm(line);
    for (let i = 0; i + N <= n.length; i++) { const w = n.slice(i, i + N); if (seen.has(w)) { hits.push(`"${line}" ← ${seen.get(w)}의 "${w}…"`); break; } }
  }
  hits.length ? bad(`예시 문장과 15자 이상 겹침 ${hits.length}건:\n     ${hits.join('\n     ')}`) : ok(`예시 ${files.length}개 파일과 15자 이상 겹치는 구절 없음${excludes.length ? `(뺀 예시: ${excludes.join(', ')})` : ''}`);
}

// 원문 대조(대표 결정: 상담사가 쓴 정보·문장을 최대한 그대로). 원문에 없는 숫자는 고칠 것, 없는 호칭·수식어는 경고
const RISKY_WORDS = ['제자', '애동', '베테랑', '전문가', '전문', '최고', '족집게', '명인', '대가', '적중', '신통', '유명', '1위'];
async function checkSource(d) {
  if (!String(d.원문 || '').trim()) { warn('내용 JSON에 원문 경로(원문)가 없어 원문 대조를 하지 못했습니다.'); return; }
  const source = [path.resolve(d.원문), path.resolve(WORKSPACE, d.원문)].find((p) => fs.existsSync(p));
  if (!source) { bad(`원문 파일을 찾지 못했습니다: ${d.원문}`); return; }
  // 양식의 고정 문구(안내문·예시 목록)는 상담사가 쓴 말이 아니므로 뺀다(예: 안내문의 "신내림/제자 이력")
  const formLines = new Set((await fileTexts(path.join(TEMPLATE_DIR, '상담사프로필_틀.docx'))).map(norm).filter(Boolean));
  const lines = (/\.docx$/i.test(source) ? await fileTexts(source) : fs.readFileSync(source, 'utf8').split(/\r?\n/)).filter((l) => !formLines.has(norm(l)));
  const src = lines.join('\n'), srcNorm = norm(src);
  const free = [d.한줄카피, ...list(d.약력), ...list(d.리딩), ...list(d.특징), ...list(d.PPT?.코멘트), ...list(d.PPT?.추천)].map((s) => String(s || '')).join(' ');
  const srcNums = new Set(src.match(/\d+/g) || []);
  const numbers = [...new Set(free.match(/\d+/g) || [])].filter((n) => !srcNums.has(n));
  numbers.length ? bad(`원문에 없는 숫자가 있습니다: ${numbers.join(', ')} → 원문에 있는 숫자만 씁니다.`) : ok('숫자는 모두 원문에 있음');
  const added = RISKY_WORDS.filter((w) => free.includes(w) && !srcNorm.includes(w)).filter((w, _, arr) => !arr.some((o) => o !== w && o.includes(w)));
  added.length ? warn(`원문에 없는 호칭·수식어: ${added.join(', ')} → 원문에 없으면 빼세요.`) : ok('원문에 없는 호칭·수식어 없음');
  // 소개글이 원문 표현을 얼마나 살렸는지(8자 이상 같은 구절이 덮는 비율). 원문이 짧으면 낮게 나오는 것이 정상이다
  const N = 8, windows = new Set();
  for (let i = 0; i + N <= srcNorm.length; i++) windows.add(srcNorm.slice(i, i + N));
  const intro = norm(list(d.특징).join(''));
  const covered = new Array(intro.length).fill(false);
  for (let i = 0; i + N <= intro.length; i++) if (windows.has(intro.slice(i, i + N))) for (let j = i; j < i + N; j++) covered[j] = true;
  const pct = intro.length ? Math.round((covered.filter(Boolean).length / intro.length) * 100) : 0;
  ok(`소개글의 원문 표현 활용: ${pct}% (원문에서 8자 이상 그대로 이어지는 구절의 비율)`);
}

function render() {
  const script = path.join(programRoot(), 'scripts', 'render-doc.mjs');
  for (const file of [docxFile, pptxFile]) {
    const r = spawnSync(process.execPath, [script, file], { encoding: 'utf8' });
    const shown = `${r.stdout || ''}${r.stderr || ''}`.trim().split(/\r?\n/).filter(Boolean);
    r.status === 0 ? ok(`그림: ${shown.join(' / ')} → 열어서 글자 넘침·잘림을 직접 보세요.`) : warn(`그림을 뜨지 못했습니다(${path.basename(file)}): ${shown.slice(-2).join(' ')}`);
  }
}

(async () => {
  if (!dataFile || !docxFile || !pptxFile) throw new Error('사용법: node check-profile.cjs <내용.json> <워드.docx> <PPT.pptx> [--render] [--exclude <예시 이름>]');
  const d = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  checkData(d);
  await checkFiles(d);
  await checkOverlap(d);
  await checkSource(d);
  if (flag('--render')) render();
  for (const [mark, message] of results) console.log(`${mark} ${message}`);
  if (list(d.확인필요).length) console.log(`\n확인 필요(보고서에 적기):\n${list(d.확인필요).map((s) => `- ${s}`).join('\n')}`);
  const failed = results.filter(([m]) => m === '✖').length;
  console.log(`\n결과: ${failed ? `고칠 것 ${failed}건` : '통과'} (경고 ${results.filter(([m]) => m === '⚠').length}건)`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('오류:', e.message); process.exit(2); });
