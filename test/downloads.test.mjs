import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import ExcelJS from 'exceljs';
import { DOWNLOAD_EXTS, downloadName, downloadTarget, downloadText, writeDownloadText } from '../lib/downloads.mjs';

const tempDir = () => mkdtempSync(join(tmpdir(), 'office-downloads-'));

test('downloadName: 자료 파일만 받고 경로·제어 문자를 뺀다', () => {
  assert.equal(downloadName('상담사 실적.xlsx'), '상담사 실적.xlsx');
  assert.equal(downloadName('C:\\Users\\x\\..\\실적.CSV'), '실적.csv', '확장자는 소문자로 맞춘다');
  assert.equal(downloadName('../../etc/report.pdf'), 'report.pdf');
  assert.equal(downloadName('a<b>:"c".txt'), 'abc.txt');
  for (const bad of ['setup.exe', 'run.bat', 'macro.xlsm', 'bundle.zip', 'page.html', 'script.js', '.env', 'prod.env.txt', '.xlsx', 'noext', '', null]) {
    assert.equal(downloadName(bad), null, String(bad));
  }
  assert.ok(DOWNLOAD_EXTS.includes('.xlsx') && !DOWNLOAD_EXTS.includes('.exe'));
  assert.equal([...downloadName(`${'가'.repeat(300)}.xlsx`)].length, 105, '긴 이름은 확장자를 두고 줄인다');
});

test('downloadTarget: 같은 이름과 그 글자 파일을 덮어쓰지 않는다', () => {
  const dir = join(tempDir(), 'downloads');
  try {
    const first = downloadTarget(dir, '실적.xlsx');
    assert.equal(basename(first), '실적.xlsx');
    writeFileSync(first, 'x');
    assert.equal(basename(downloadTarget(dir, '실적.xlsx')), '실적 (2).xlsx');
    // 원본 없이 글자 파일만 남아 있어도 그 이름은 다시 쓰지 않는다
    writeFileSync(join(dir, '목록.csv.txt'), 'x');
    assert.equal(basename(downloadTarget(dir, '목록.csv')), '목록 (2).csv');
  } finally { rmSync(join(dir, '..'), { recursive: true, force: true }); }
});

test('downloadText: 엑셀은 시트별 행을 탭으로 풀고 수식·링크·날짜·서식 글자를 값으로 읽는다', async () => {
  const dir = tempDir();
  try {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('상담사');
    sheet.addRow(['예명', '메일', '매출', '등록일']);
    sheet.addRow(['가상별', 'gasang@example.invalid', 1200, new Date('2026-10-26T00:00:00.000Z')]);
    sheet.addRow(['가상달', { text: 'dal@example.invalid', hyperlink: 'mailto:dal@example.invalid' }, { formula: 'C2*2', result: 2400 }, null]);
    sheet.addRow([{ richText: [{ text: '가상' }, { text: '해' }] }, '줄\n바꿈\t탭', '', '']);
    workbook.addWorksheet('빈 시트');
    const file = join(dir, '실적.xlsx');
    await workbook.xlsx.writeFile(file);
    const text = await downloadText(file);
    assert.match(text, /^# 시트: 상담사 \(4행, 칸은 탭으로 구분\)\n예명\t메일\t매출\t등록일\n가상별\tgasang@example\.invalid\t1200\t2026-10-26\n가상달\tdal@example\.invalid\t2400\n가상해\t줄 바꿈 탭\n\n# 시트: 빈 시트 \(0행/);
    const written = await writeDownloadText(file);
    assert.equal(written.name, '실적.xlsx.txt');
    assert.equal(readFileSync(written.file, 'utf8'), text);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('downloadText: 글자 파일은 UTF-8, 깨지면 EUC-KR로 읽고 풀 수 없는 형식은 비운다', async () => {
  const dir = tempDir();
  try {
    const utf8 = join(dir, 'a.csv'); writeFileSync(utf8, '\uFEFF예명,메일\n가상별,gasang@example.invalid\n');
    assert.equal(await downloadText(utf8), '예명,메일\n가상별,gasang@example.invalid\n');
    // "가나,a" 를 EUC-KR로 저장한 파일
    const euckr = join(dir, 'b.csv'); writeFileSync(euckr, Buffer.from([0xb0, 0xa1, 0xb3, 0xaa, 0x2c, 0x61]));
    assert.equal(await downloadText(euckr), '가나,a');
    const pdf = join(dir, 'c.pdf'); writeFileSync(pdf, '%PDF-1.7');
    assert.equal(await downloadText(pdf), '');
    assert.equal(await writeDownloadText(pdf), null);
    assert.ok(!existsSync(`${pdf}.txt`));
    const broken = join(dir, 'd.xlsx'); writeFileSync(broken, 'not a workbook');
    assert.equal(await downloadText(broken), '', '손상된 엑셀은 원본만 둔다');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
