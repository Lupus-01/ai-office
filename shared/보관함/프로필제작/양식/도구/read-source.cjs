// 상담사 원문 읽기: 워드(.docx)의 문단과 표 칸 글자를 순서대로 보여 준다(.txt·.md는 그대로)
// 사용: node read-source.cjs <원문 파일>
// 연락처·계좌도 그대로 보이므로 결과를 보고서·로그에 옮겨 적지 않는다(내용 JSON의 연락처 칸에만 쓴다)
'use strict';
const { fs, path, all, textOf, loadZip } = require('./profile-lib.cjs');

(async () => {
  const file = process.argv[2];
  if (!file) throw new Error('사용법: node read-source.cjs <원문 파일>');
  const ext = path.extname(file).toLowerCase();
  if (ext === '.txt' || ext === '.md') { process.stdout.write(fs.readFileSync(file, 'utf8')); return; }
  if (ext !== '.docx') throw new Error(`${ext || '확장자 없음'} 파일은 읽지 못합니다. 워드(.docx)로 저장해 달라고 하세요(.doc·.hwp는 한글/워드에서 .docx로 다시 저장).`);
  const xml = await (await loadZip(file)).file('word/document.xml').async('string');
  const body = xml.slice(xml.indexOf('<w:body>'), xml.lastIndexOf('</w:body>'));
  // 표 밖 문단과 표를 문서 순서대로 보여 준다
  const parts = all(body, /<w:tbl>[\s\S]*?<\/w:tbl>|<w:p[ >][\s\S]*?<\/w:p>/g);
  let t = 0;
  for (const part of parts) {
    if (part.startsWith('<w:tbl>')) {
      t++;
      all(part, /<w:tr[ >][\s\S]*?<\/w:tr>/g).forEach((tr, r) => {
        const cells = all(tr, /<w:tc>[\s\S]*?<\/w:tc>/g).map((tc) => all(tc, /<w:p[ >][\s\S]*?<\/w:p>/g).map((p) => textOf(p, 'w:t')).filter((s) => s.trim()).join(' ⏎ '));
        console.log(`[표${t}-${r + 1}] ${cells.join(' || ')}`);
      });
    } else {
      const text = textOf(part, 'w:t');
      if (text.trim()) console.log(text);
    }
  }
  const media = Object.keys((await loadZip(file)).files).filter((n) => n.startsWith('word/media/'));
  if (media.length) console.log(`\n(그림 ${media.length}개 포함 — 프로필 파일에는 넣지 않습니다)`);
})().catch((e) => { console.error('오류:', e.message); process.exit(1); });
