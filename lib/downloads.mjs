// 사이트 조회 단계에서 연결 사이트가 주는 파일(엑셀 내려받기 등)을 그 업무 폴더 downloads/에 저장한다.
// 직원 도구(Read)는 엑셀을 열지 못하므로 표·글자 파일은 같은 이름의 .txt로 풀어 함께 둔다.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';

export const DOWNLOAD_MAX_BYTES = 25 * 1024 * 1024;
export const DOWNLOAD_MAX_FILES = 10;
// 자료 파일만 받는다. 실행 파일·압축 파일·스크립트는 받지 않는다
export const DOWNLOAD_EXTS = ['.xlsx', '.xls', '.csv', '.tsv', '.txt', '.json', '.pdf', '.docx', '.pptx', '.hwp', '.hwpx'];
const TEXT_EXTS = ['.csv', '.tsv', '.txt', '.json'];
const TEXT_MAX_CHARS = 5 * 1000 * 1000;
const SECRET_NAME = /^\.|^계정\.env$|\.env(?:\.|$)/i;

// 경로·제어 문자를 뺀 파일 이름. 받을 수 없는 형식이면 null
export function downloadName(raw) {
  const name = String(raw ?? '').normalize('NFC').split(/[\\/]/).pop()
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '').replace(/\s+/g, ' ').trim();
  if (!name || name === '.' || name === '..' || SECRET_NAME.test(name)) return null;
  const ext = extname(name).toLowerCase();
  if (!DOWNLOAD_EXTS.includes(ext)) return null;
  const stem = [...name.slice(0, name.length - ext.length)].slice(0, 100).join('').trim();
  return stem ? stem + ext : null;
}

// 같은 이름이 있으면 " (2)"를 붙여 덮어쓰지 않는다
export function downloadTarget(dir, name) {
  mkdirSync(dir, { recursive: true });
  const ext = extname(name), stem = name.slice(0, -ext.length);
  for (let i = 1; i < 1000; i++) {
    const target = join(dir, i === 1 ? name : `${stem} (${i})${ext}`);
    if (!existsSync(target) && !existsSync(`${target}.txt`)) return target;
  }
  throw new Error('같은 이름의 파일이 너무 많습니다.');
}

const cellText = (value) => {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString().replace('T00:00:00.000Z', '').replace('.000Z', 'Z');
  if (typeof value === 'object') {
    if (Array.isArray(value.richText)) return value.richText.map((part) => part.text || '').join('');
    if ('result' in value) return cellText(value.result);   // 수식: 계산된 값
    if ('text' in value) return cellText(value.text);       // 링크: 보이는 글자
    if ('error' in value) return String(value.error);
    return '';
  }
  return String(value);
};
const oneLine = (text) => text.replace(/\r?\n/g, ' ').replace(/\t/g, ' ').trim();

async function workbookText(file) {
  const { default: ExcelJS } = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file);
  const parts = [];
  workbook.eachSheet((sheet) => {
    const rows = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const cells = [];
      for (let col = 1; col <= row.cellCount; col++) cells.push(oneLine(cellText(row.getCell(col).value)));
      while (cells.length && !cells.at(-1)) cells.pop();
      if (cells.length) rows.push(cells.join('\t'));
    });
    parts.push(`# 시트: ${sheet.name} (${rows.length}행, 칸은 탭으로 구분)\n${rows.join('\n')}`);
  });
  return parts.join('\n\n');
}

// 글자 파일은 UTF-8로 읽고, 깨지면 국내 사이트가 흔히 쓰는 EUC-KR(CP949)로 다시 읽는다
function decodeText(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, ''); }
  catch { try { return new TextDecoder('euc-kr').decode(bytes); } catch { return ''; } }
}

// 직원이 Read로 읽을 글자 내용. 풀 수 없는 형식(.xls·.pdf·.hwp 등)이나 손상된 파일은 ''
export async function downloadText(file) {
  const ext = extname(file).toLowerCase();
  try {
    const text = ext === '.xlsx' ? await workbookText(file) : TEXT_EXTS.includes(ext) ? decodeText(readFileSync(file)) : '';
    return text.length > TEXT_MAX_CHARS ? `${text.slice(0, TEXT_MAX_CHARS)}\n…(이후 생략: 파일이 너무 큽니다)` : text;
  } catch { return ''; }
}

// 저장한 파일 옆에 글자 파일(<이름>.txt)을 만든다. 원본이 이미 글자 파일이어도 UTF-8로 풀어 둔다(EUC-KR 원본은 Read에서 깨진다)
export async function writeDownloadText(target) {
  const text = await downloadText(target);
  if (!text) return null;
  const textFile = `${target}.txt`;
  writeFileSync(textFile, text, { flag: 'wx' });
  return { file: textFile, name: basename(textFile), lines: text.split('\n').length };
}
