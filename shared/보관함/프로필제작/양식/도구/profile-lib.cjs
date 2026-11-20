// 상담사 프로필 도구 공통 함수: 프로그램 폴더(문서 라이브러리) 찾기, XML 문단 다루기
'use strict';
const fs = require('fs');
const path = require('path');

// 작업 공간 표식(.ai-office-workspace)의 "program:" 줄에서 프로그램 폴더를 찾는다
function programRoot() {
  if (process.env.AI_OFFICE_PROGRAM) return process.env.AI_OFFICE_PROGRAM;
  let dir = __dirname;
  for (let i = 0; i < 12; i++) {
    const marker = path.join(dir, '.ai-office-workspace');
    if (fs.existsSync(marker)) {
      const m = fs.readFileSync(marker, 'utf8').match(/^program:\s*(.+)$/m);
      if (m) return m[1].trim();
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error('프로그램 폴더를 찾지 못했습니다. 작업 공간의 .ai-office-workspace 파일을 확인하세요.');
}
const JSZip = require(path.join(programRoot(), 'node_modules', 'jszip'));

const HERE = __dirname;
const FORM_DIR = path.resolve(HERE, '..');            // 보관함/프로필제작/양식
const TEMPLATE_DIR = path.join(FORM_DIR, '틀');
const EXAMPLE_DIR = path.resolve(FORM_DIR, '..', '예시');
const WORKSPACE = path.resolve(FORM_DIR, '..', '..', '..'); // 작업 공간(보관함의 상위)
const FIELDS = ['사주', '신점', '타로'];
const TAGS = ['애정', '짝사랑', '궁합', '이별', '재회', '속궁합', '속마음', '결혼', '가족', '건강', '고민', '이사', '꿈해몽', '인간관계', '재물', '사업', '취업', '진로', '시험', '합격'];

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unesc = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
// 첫 요소(자체 닫힘 또는 내용 있는 요소)
const elem = (xml, tag) => (xml.match(new RegExp(`<${tag}(?:\\s[^>]*?)?(?:\\/>|>[\\s\\S]*?<\\/${tag}>)`)) || [''])[0];
const all = (xml, re) => xml.match(re) || [];
const textOf = (xml, t) => all(xml, new RegExp(`<${t}(?: [^>]*)?>([\\s\\S]*?)<\\/${t}>`, 'g')).map((x) => unesc(x.replace(/<[^>]+>/g, ''))).join('');

// 자리표시({{key}})가 든 문단을 값의 줄마다 복제한다. 값이 비면 글자만 비운다
function fillParagraphs(xml, p, key, value) {
  const lines = (Array.isArray(value) ? value : [value ?? '']).map((v) => String(v ?? ''));
  const re = new RegExp(`<${p}(?:\\s[^>]*)?>(?:(?!<\\/${p}>)[\\s\\S])*?\\{\\{${key}\\}\\}[\\s\\S]*?<\\/${p}>`);
  let guard = 0;
  while (re.test(xml)) {
    if (++guard > 50) throw new Error(`자리표시 {{${key}}}를 채우다 멈췄습니다.`);
    const para = xml.match(re)[0];
    const filled = (lines.length ? lines : ['']).map((line) => para.split(`{{${key}}}`).join(esc(line))).join('');
    xml = xml.replace(para, filled);
  }
  return xml;
}

async function loadZip(file) { return JSZip.loadAsync(fs.readFileSync(file)); }
async function saveZip(zip, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}
const safeName = (s) => String(s).replace(/[\\/:*?"<>|]/g, '').trim();

// 문서의 글자를 칸·도형 단위로 읽는다(검사용)
async function docxCells(file) {
  const xml = await (await loadZip(file)).file('word/document.xml').async('string');
  return all(xml, /<w:tbl>[\s\S]*?<\/w:tbl>/g).map((tbl) => all(tbl, /<w:tr[ >][\s\S]*?<\/w:tr>/g)
    .map((tr) => all(tr, /<w:tc>[\s\S]*?<\/w:tc>/g).map((tc) => all(tc, /<w:p[ >][\s\S]*?<\/w:p>/g).map((p) => textOf(p, 'w:t')).filter((s) => s.trim()))));
}
async function pptxShapes(file) {
  const xml = await (await loadZip(file)).file('ppt/slides/slide1.xml').async('string');
  return all(xml, /<p:sp>[\s\S]*?<\/p:sp>/g).map((sp) => {
    const off = sp.match(/<a:off x="(-?\d+)" y="(-?\d+)"/);
    return { x: off ? +off[1] / 91440 : 0, y: off ? +off[2] / 91440 : 0, lines: all(sp, /<a:p>[\s\S]*?<\/a:p>/g).map((p) => textOf(p, 'a:t')) };
  });
}

module.exports = { fs, path, JSZip, programRoot, FORM_DIR, TEMPLATE_DIR, EXAMPLE_DIR, WORKSPACE, FIELDS, TAGS, esc, unesc, elem, all, textOf, fillParagraphs, loadZip, saveZip, safeName, docxCells, pptxShapes };
