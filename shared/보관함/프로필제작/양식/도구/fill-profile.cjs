// 상담사 프로필 채우기: 칸별 내용 JSON → 워드(상담사프로필_<예명>.docx) + PPT(프로필_<분야>_<예명>.pptx)
// 사용: node fill-profile.cjs <내용.json> <출력 폴더 또는 .docx/.pptx 파일 경로> [--only docx|pptx] [--render]
//   --render  만든 파일의 그림을 바로 뜬다
//   --only  한 파일만 만든다(계획 단계가 워드·PPT로 나뉘어 있을 때 각 단계에서 자기 파일만 만든다)
// 서식은 양식/틀의 빈 틀을 그대로 쓰고 글자만 넣는다. 내용 JSON 형식은 양식/내용-견본.json을 보세요.
'use strict';
const { fs, path, programRoot, TEMPLATE_DIR, FIELDS, esc, fillParagraphs, loadZip, saveZip, safeName } = require('./profile-lib.cjs');

const list = (v) => (Array.isArray(v) ? v : v ? [v] : []).map((s) => String(s).trim()).filter(Boolean);
const hashTags = (v) => list(v).map((t) => '#' + t.replace(/^#/, '').replace(/\s+/g, '')).join(' ');
const single = (xml, key, value) => xml.split(`{{${key}}}`).join(esc(value ?? ''));
const MARK = '  O  ', BLANK = '     ';

function validate(d) {
  const problems = [];
  if (!String(d.예명 || '').trim()) problems.push('예명이 비어 있습니다.');
  if (!FIELDS.includes(d.분야)) problems.push(`분야는 ${FIELDS.join('·')} 중 하나여야 합니다(지금: ${d.분야 ?? '없음'}).`);
  if (!d.PPT || typeof d.PPT !== 'object') problems.push('PPT 항목(약력·리딩·코멘트·추천)이 없습니다.');
  if (problems.length) throw new Error(problems.join(' '));
}

async function fillDocx(d, out) {
  const zip = await loadZip(path.join(TEMPLATE_DIR, '상담사프로필_틀.docx'));
  let xml = await zip.file('word/document.xml').async('string');
  const c = d.연락처 || {};
  xml = single(xml, '예명', d.예명);
  xml = single(xml, '상담스타일', list(d.상담스타일).join(', '));
  for (const key of ['휴대폰', '연결전화', '이메일', '주소', '은행명', '계좌번호', '계좌주명']) xml = single(xml, key, c[key] ?? '');
  for (const n of ['사주', '신점', '타로', '기타']) xml = single(xml, `분야_${n}`, d.분야 === n ? MARK : BLANK);
  for (const n of ['사주타로', '펫타로', '점성술']) xml = single(xml, `타로_${n}`, d.분야 === '타로' && list(d.타로상담분야).includes(n) ? MARK : BLANK);
  // 1줄 카피는 원문에 있을 때만 둔다(없으면 그 문단을 지운다)
  if (String(d.한줄카피 || '').trim()) xml = single(xml, '한줄카피', d.한줄카피.trim());
  else xml = xml.replace(/<w:p(?:\s[^>]*)?>(?:(?!<\/w:p>)[\s\S])*?\{\{한줄카피\}\}[\s\S]*?<\/w:p>/, '');
  xml = single(xml, '상담태그', hashTags(d.상담태그));
  xml = fillParagraphs(xml, 'w:p', '약력', list(d.약력));
  xml = fillParagraphs(xml, 'w:p', '리딩', list(d.리딩));
  xml = fillParagraphs(xml, 'w:p', '특징', list(d.특징));
  const left = xml.match(/\{\{[^}]+\}\}/g);
  if (left) throw new Error(`워드에 채우지 못한 칸이 있습니다: ${[...new Set(left)].join(', ')}`);
  zip.file('word/document.xml', xml);
  await saveZip(zip, out);
}

async function fillPptx(d, out) {
  const zip = await loadZip(path.join(TEMPLATE_DIR, `프로필_${d.분야}_틀.pptx`));
  let xml = await zip.file('ppt/slides/slide1.xml').async('string');
  const p = d.PPT;
  xml = single(xml, '이름', d.예명);
  xml = single(xml, '상담분야', hashTags(d.상담태그));          // 워드 상담태그와 같게
  xml = single(xml, '코멘트태그', hashTags(d.상담스타일));      // 워드 상담 스타일과 같게
  xml = fillParagraphs(xml, 'a:p', '약력', list(p.약력));
  xml = fillParagraphs(xml, 'a:p', '리딩', list(p.리딩));
  xml = fillParagraphs(xml, 'a:p', '코멘트', list(p.코멘트));
  xml = fillParagraphs(xml, 'a:p', '추천', list(p.추천));
  xml = fillParagraphs(xml, 'a:p', '소개글', list(d.특징));    // 워드 특징과 강점과 같게
  const left = xml.match(/\{\{[^}]+\}\}/g);
  if (left) throw new Error(`PPT에 채우지 못한 칸이 있습니다: ${[...new Set(left)].join(', ')}`);
  zip.file('ppt/slides/slide1.xml', xml);
  await saveZip(zip, out);
}

(async () => {
  const args = process.argv.slice(2);
  let only = args.includes('--only') ? args[args.indexOf('--only') + 1] : undefined;
  const [dataFile, target] = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--only');
  if (!dataFile || !target) throw new Error('사용법: node fill-profile.cjs <내용.json> <출력 폴더 또는 .docx/.pptx 파일 경로> [--only docx|pptx]');
  if (only !== undefined && !['docx', 'pptx'].includes(only)) throw new Error('--only 뒤에는 docx 또는 pptx를 씁니다.');
  // 출력에 파일 경로(.docx/.pptx)를 주면 그 이름 그대로 그 파일만 만든다(계획 단계의 output 경로를 그대로 쓰는 경우)
  const fileKind = (target.match(/\.(docx|pptx)$/i) || [])[1]?.toLowerCase();
  if (fileKind && only && only !== fileKind) throw new Error(`출력 파일(.${fileKind})과 --only ${only}가 다릅니다.`);
  if (fileKind) only = fileKind;
  const d = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  validate(d);
  const name = safeName(d.예명);
  const outDir = fileKind ? path.dirname(target) : target;
  const docx = fileKind === 'docx' ? path.resolve(target) : path.resolve(outDir, `상담사프로필_${name}.docx`);
  const pptx = fileKind === 'pptx' ? path.resolve(target) : path.resolve(outDir, `프로필_${d.분야}_${name}.pptx`);
  const made = [];
  if (only !== 'pptx') { await fillDocx(d, docx); made.push(docx); console.log(`워드: ${docx}`); }
  if (only !== 'docx') { await fillPptx(d, pptx); made.push(pptx); console.log(`PPT: ${pptx}`); }
  // --render: 만든 파일의 그림을 바로 뜬다(파일 옆 preview-<이름>/page-1.png). 그림을 열어 넘침·잘림을 본다
  if (args.includes('--render')) {
    const { spawnSync } = require('child_process');
    const script = path.join(programRoot(), 'scripts', 'render-doc.mjs');
    for (const file of made) {
      const r = spawnSync(process.execPath, [script, file], { encoding: 'utf8' });
      const shown = `${r.stdout || ''}${r.stderr || ''}`.trim().split(/\r?\n/).filter(Boolean);
      console.log(r.status === 0 ? `그림: ${shown[0]}` : `그림을 뜨지 못했습니다(${path.basename(file)}): ${shown.slice(-2).join(' ')}`);
    }
  }
  console.log(`검사(두 파일이 모두 있을 때): node "${path.join(__dirname, 'check-profile.cjs')}" "${path.resolve(dataFile)}" "${docx}" "${pptx}" --render`);
})().catch((e) => { console.error('오류:', e.message); process.exit(1); });
