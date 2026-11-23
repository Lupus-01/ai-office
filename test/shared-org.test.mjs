import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { loadSettings, saveSettings } from '../lib/settings.mjs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportOrg, loadCompanyRules, loadOrg, saveCompanyRules, saveOrg } from '../lib/org.mjs';
import JSZip from 'jszip';
import {
  NAME_PLACEHOLDER, SHARED_ORG_REL, SHARED_VAULT_DIRS, applySharedOrg, publishSharedFiles, publishSharedOrg, readSharedMarker, refreshSharedOrg,
  sharedFilesDir, sharedFilesSha, sharedOrgBackupDir, sharedOrgFile, sharedOrgLeaks, sharedOrgStatus, stopSharedOrg,
} from '../lib/shared-org.mjs';

function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return dir;
}

// 대표 PC 구성: 지침과 부서 요약에 대표 실명이 들어 있다
const ownerOrg = () => ({
  departments: [
    { id: 'care', name: '상담사관리부', en: 'CARE', engine: 'claude', model: 'sonnet', summary: '발신자 호칭은 "담당 매니저 가나다"이다.' },
    { id: 'quality', name: '품질검수부', en: 'QUALITY', engine: 'claude', summary: '검수' },
  ],
  roster: [
    { id: 'care-1', name: '관리팀장', department: 'care', title: '팀장', lead: true, specialty: '취합', instructions: '상담사 목록(담당자 가나다)에서 찾는다. 담당자 가나다 기준으로 내려받는다.' },
    { id: 'quality-1', name: '검수팀장', department: 'quality', title: '팀장', lead: true, specialty: '검수' },
  ],
});

function ownerPc(t) {
  const root = tempDir(t, 'office-shared-owner-');
  saveOrg(root, ownerOrg());
  saveCompanyRules(root, '가나다 대표의 회사 규칙');
  return root;
}

test('publish: 대표 실명을 자리 표시로 바꿔 레포 공유 파일로 쓰고, 같은 내용이면 다시 쓰지 않는다', (t) => {
  const root = ownerPc(t);
  const program = tempDir(t, 'office-shared-program-');
  const r = publishSharedOrg({ root, program, names: ['가나다'] });
  assert.equal(r.changed, true);
  assert.equal(r.file, join(program, ...SHARED_ORG_REL.split('/')));
  assert.deepEqual(r.replaced, { 가나다: 4 });
  assert.deepEqual(r.summary, { departments: 2, roster: 2, company: true });
  const text = readFileSync(r.file, 'utf8');
  assert.ok(!text.includes('가나다'), '공유 파일에 실명이 없다');
  assert.equal(text.split(NAME_PLACEHOLDER).length - 1, 4);
  // 대표 PC의 원래 구성은 그대로
  assert.ok(JSON.stringify(exportOrg(root)).includes('가나다'));
  assert.equal(publishSharedOrg({ root, program, names: ['가나다'] }).changed, false);
});

test('publish: 메일 주소·휴대폰 번호·사용자 폴더 경로가 남아 있으면 쓰지 않는다', (t) => {
  const program = tempDir(t, 'office-shared-program-');
  for (const leak of ['문의는 boss@example.com', '연락처 010-1234-5678', 'C:\\Users\\boss\\Desktop 폴더', '/Users/boss/Desktop 폴더']) {
    const root = tempDir(t, 'office-shared-owner-');
    saveOrg(root, ownerOrg());
    saveCompanyRules(root, leak);
    assert.throws(() => publishSharedOrg({ root, program, names: ['가나다'] }), /올리면 안 되는 내용/, leak);
  }
  assert.equal(existsSync(sharedOrgFile(program)), false, '실패하면 파일을 만들지 않는다');
  assert.deepEqual(sharedOrgLeaks({ company: '가나다 님' }, ['가나다']), ['이름 "가나다"(회사 공통 규칙)']);
  assert.deepEqual(sharedOrgLeaks({ company: '깨끗한 규칙' }, ['가나다']), []);
  // 어느 부서·직원의 어느 항목인지 알려 주고, 배열 안 값도 본다
  assert.deepEqual(sharedOrgLeaks({ company: '', departments: [{ id: 'a', name: '가부', capabilities: ['연락 010-2222-3333'] }], roster: [{ id: 'a-1', name: '김', instructions: 'x@y.com' }] }),
    ['휴대폰 번호(부서 가부 capabilities)', '메일 주소(직원 김(a-1) instructions)']);
  // 긴 숫자 id 안의 010… 은 휴대폰으로 보지 않는다
  assert.deepEqual(sharedOrgLeaks({ company: '상품 번호 9901012345678901' }), []);
});

test('publish: 빈 회사·잘못된 이름·받아 쓰는 PC에서는 거부한다', async (t) => {
  const program = tempDir(t, 'office-shared-program-');
  assert.throws(() => publishSharedOrg({ root: tempDir(t, 'office-shared-empty-'), program, names: ['가나다'] }), /부서 0개/);
  const root = ownerPc(t);
  assert.throws(() => publishSharedOrg({ root, program, names: [''] }), /이름을 지정/);
  assert.throws(() => publishSharedOrg({ root, program, names: ['{{x}}'] }), /쓸 수 없는 글자/);
  publishSharedOrg({ root, program, names: ['가나다'] });
  const member = tempDir(t, 'office-shared-member-');
  await applySharedOrg({ root: member, program, name: '라마바' });
  assert.throws(() => publishSharedOrg({ root: member, program, names: ['라마바'] }), /받아 쓰는 PC/);
});

test('apply: 빈 PC에 자리 표시를 그 사람 이름으로 채워 가져오고 표식을 남긴다', async (t) => {
  const program = tempDir(t, 'office-shared-program-');
  publishSharedOrg({ root: ownerPc(t), program, names: ['가나다'] });
  const member = tempDir(t, 'office-shared-member-');
  const r = await applySharedOrg({ root: member, program, name: ' 라마바 ' });
  assert.equal(r.name, '라마바');
  assert.deepEqual(r.summary, { departments: 2, roster: 2, company: true });
  const org = loadOrg(member);
  assert.equal(org.roster.find((p) => p.id === 'care-1').instructions, '상담사 목록(담당자 라마바)에서 찾는다. 담당자 라마바 기준으로 내려받는다.');
  assert.equal(loadCompanyRules(member).trim(), '라마바 대표의 회사 규칙');
  assert.ok(!JSON.stringify(exportOrg(member)).includes(NAME_PLACEHOLDER));
  assert.ok(existsSync(join(member, '.claude', 'agents', 'care-1.md')), '에이전트 파일도 만든다');
  const marker = readSharedMarker(member);
  assert.equal(marker.name, '라마바');
  assert.match(marker.sha256, /^[0-9a-f]{64}$/);
  const s = sharedOrgStatus({ root: member, program });
  assert.equal(s.subscribed, true);
  assert.equal(s.upToDate, true);
});

test('apply: 표식 없이 이미 구성이 있는 PC(대표 PC)는 --yes 없이 덮어쓰지 않는다', async (t) => {
  const program = tempDir(t, 'office-shared-program-');
  const owner = ownerPc(t);
  publishSharedOrg({ root: owner, program, names: ['가나다'] });
  const before = exportOrg(owner);
  await assert.rejects(applySharedOrg({ root: owner, program, name: '가나다' }), /이미 회사 구성/);
  assert.deepEqual(exportOrg(owner), before);
  assert.equal(readSharedMarker(owner), null);
  await assert.rejects(applySharedOrg({ root: tempDir(t, 'office-shared-member-'), program }), /이름을 지정/);
  await assert.rejects(applySharedOrg({ root: tempDir(t, 'office-shared-member-'), program: tempDir(t, 'office-shared-noprog-'), name: '라마바' }), /파일이 없습니다/);
  // --yes(force)면 덮어쓴다
  const r = await applySharedOrg({ root: owner, program, name: '사아자', force: true });
  assert.equal(r.name, '사아자');
  assert.ok(JSON.stringify(exportOrg(owner)).includes('사아자'));
});

test('refresh: 표식이 없으면 건드리지 않고, 공유 파일이 바뀐 PC만 저장된 이름으로 다시 맞춘다', async (t) => {
  const program = tempDir(t, 'office-shared-program-');
  const owner = ownerPc(t);
  publishSharedOrg({ root: owner, program, names: ['가나다'] });
  // 대표 PC: 표식 없음 → 그대로
  const ownerBefore = exportOrg(owner);
  assert.deepEqual(await refreshSharedOrg({ root: owner, program }), { applied: false, reason: 'not-subscribed' });
  assert.deepEqual(exportOrg(owner), ownerBefore);

  const member = tempDir(t, 'office-shared-member-');
  await applySharedOrg({ root: member, program, name: '라마바' });
  assert.deepEqual(await refreshSharedOrg({ root: member, program }), { applied: false, reason: 'up-to-date' });

  // 대표가 부서를 하나 더 만들어 다시 올림
  const next = ownerOrg();
  next.departments.push({ id: 'trend', name: 'AI트렌드부', en: 'TREND', engine: 'claude', summary: '조사' });
  next.roster.push({ id: 'trend-1', name: '트렌드팀장', department: 'trend', title: '팀장', lead: true, specialty: '조사' });
  saveOrg(owner, next);
  publishSharedOrg({ root: owner, program, names: ['가나다'] });
  assert.equal(sharedOrgStatus({ root: member, program }).upToDate, false);
  const r = await refreshSharedOrg({ root: member, program });
  assert.equal(r.applied, true);
  assert.equal(r.name, '라마바');
  assert.equal(loadOrg(member).departments.length, 3);
  assert.equal(sharedOrgStatus({ root: member, program }).upToDate, true);

  // 공유 파일이 사라지면 아무것도 하지 않는다
  rmSync(sharedOrgFile(program));
  assert.deepEqual(await refreshSharedOrg({ root: member, program }), { applied: false, reason: 'no-file' });
  assert.equal(loadOrg(member).departments.length, 3);
});

test('서버 시작: 받아 쓰는 PC는 레포의 공유 구성이 바뀌었으면 켤 때 맞춘다(레포에 공유 파일이 있을 때)', async (t) => {
  const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
  if (!existsSync(sharedOrgFile(REPO))) return t.skip('레포에 공유 회사 구성 파일이 없음');
  const shared = JSON.parse(readFileSync(sharedOrgFile(REPO), 'utf8'));
  const member = tempDir(t, 'office-shared-member-');
  mkdirSync(join(member, '.office'), { recursive: true });
  writeFileSync(join(member, '.office', 'shared-org.json'), JSON.stringify({ version: 1, name: '라마바', sha256: 'old', appliedAt: '2026-01-01T00:00:00.000Z' }));
  const publicDir = join(tempDir(t, 'office-shared-public-'), 'public');
  mkdirSync(publicDir);
  writeFileSync(join(publicDir, 'index.html'), '<!doctype html>');
  const { startServer } = await import('../dashboard/server.mjs');
  const handle = await startServer({ root: member, program: REPO, port: 0, publicDir, quiet: true });
  await handle.close();
  assert.equal(loadOrg(member).departments.length, shared.departments.length);
  assert.ok(!JSON.stringify(exportOrg(member)).includes(NAME_PLACEHOLDER));
  assert.equal(sharedOrgStatus({ root: member, program: REPO }).upToDate, true);
});

test('publish 미리 보기: 쓰지 않고 바뀌는 부서·직원·규칙과 자리 표시 수를 알려 준다', (t) => {
  const root = ownerPc(t);
  const program = tempDir(t, 'office-shared-program-');
  let r = publishSharedOrg({ root, program, names: ['가나다'], dryRun: true });
  assert.equal(r.changed, true);
  assert.deepEqual(r.changes, ['처음 올리는 공유 구성입니다.']);
  assert.equal(existsSync(sharedOrgFile(program)), false, '미리 보기는 파일을 쓰지 않는다');
  publishSharedOrg({ root, program, names: ['가나다'] });

  const next = ownerOrg();
  next.departments.push({ id: 'trend', name: 'AI트렌드부', en: 'TREND', engine: 'claude', summary: '조사' });
  next.roster[0].instructions = '상담사 목록에서 찾는다.';
  saveOrg(root, next);
  r = publishSharedOrg({ root, program, names: ['가나다'], dryRun: true });
  assert.deepEqual(r.changes, ['부서 추가: AI트렌드부', '직원 바뀜: 관리팀장 (instructions)']);
  assert.equal(r.previousPlaceholders, 4);
  assert.equal(r.placeholders, 2, '지침에서 실명 두 곳이 빠지면 자리 표시도 준다');
  // 이름을 잘못 적으면 실명이 남지만 자리 표시가 0이 된다(release가 지난번보다 줄면 멈춘다)
  const typo = publishSharedOrg({ root, program, names: ['가나라'], dryRun: true });
  assert.equal(typo.placeholders, 0);
  assert.equal(typo.previousPlaceholders, 4);
});

test('apply: 바꾸기 전 구성을 백업하고, 이미 받아 쓰는 PC의 회사 설정은 그대로 둔다', async (t) => {
  const program = tempDir(t, 'office-shared-program-');
  const owner = ownerPc(t);
  saveSettings(owner, { mode: 'auto', chief: { engine: 'claude', model: 'sonnet', effort: 'high' }, budget: { calls: 240, minutes: 180 } });
  publishSharedOrg({ root: owner, program, names: ['가나다'] });

  const member = tempDir(t, 'office-shared-member-');
  saveOrg(member, { departments: [{ id: 'mine', name: '내부서', en: 'MINE', engine: 'claude', summary: '내 것' }], roster: [] });
  const first = await applySharedOrg({ root: member, program, name: '라마바', force: true });
  assert.ok(first.backup && existsSync(first.backup), '덮어쓰기 전 구성을 남긴다');
  assert.equal(JSON.parse(readFileSync(first.backup, 'utf8')).departments[0].name, '내부서');
  assert.equal(loadSettings(member).budget.calls, 240, '처음 가져올 때는 공유 설정을 쓴다');

  // 파트장이 상단에서 예산을 바꾼 뒤 대표가 새 구성을 올림
  saveSettings(member, { ...loadSettings(member), budget: { calls: 40, minutes: 60 } });
  const next = ownerOrg();
  next.departments.push({ id: 'trend', name: 'AI트렌드부', en: 'TREND', engine: 'claude', summary: '조사' });
  saveOrg(owner, next);
  publishSharedOrg({ root: owner, program, names: ['가나다'] });
  const r = await refreshSharedOrg({ root: member, program });
  assert.equal(r.applied, true);
  assert.ok(r.backup && existsSync(r.backup));
  assert.equal(loadOrg(member).departments.length, 3);
  assert.equal(loadSettings(member).budget.calls, 40, '받아 쓰는 PC의 회사 설정은 덮어쓰지 않는다');
  assert.ok(readdirSync(sharedOrgBackupDir(member)).length >= 2);
});

test('stop: 자동 맞춤을 그만둬도 회사 구성은 남고, 이후 새 버전을 받지 않는다', async (t) => {
  const program = tempDir(t, 'office-shared-program-');
  publishSharedOrg({ root: ownerPc(t), program, names: ['가나다'] });
  const member = tempDir(t, 'office-shared-member-');
  await applySharedOrg({ root: member, program, name: '라마바' });
  assert.equal(stopSharedOrg(member), true);
  assert.equal(stopSharedOrg(member), false);
  assert.equal(loadOrg(member).departments.length, 2);
  mkdirSync(join(program, 'shared'), { recursive: true });
  writeFileSync(sharedOrgFile(program), readFileSync(sharedOrgFile(program), 'utf8').replace('품질검수부', '품질검수실'));
  assert.deepEqual(await refreshSharedOrg({ root: member, program }), { applied: false, reason: 'not-subscribed' });
  assert.ok(loadOrg(member).departments.some((d) => d.name === '품질검수부'));
});

// ── 보관함 자료(양식·도구) ──
// 작성자·회사 정보가 든 가짜 워드(실제 문서 정보 칸과 같은 이름)
// 실제 워드·PPT처럼 폴더 항목 없이 파일 항목만 둔다
async function fakeDocx(text, person) {
  const z = new JSZip();
  const put = (name, xml) => z.file(name, xml, { createFolders: false, date: new Date('2026-01-01T00:00:00Z') });
  put('[Content_Types].xml', '<Types/>');
  put('docProps/core.xml', `<cp:coreProperties xmlns:cp="c" xmlns:dc="d"><dc:creator>${person}</dc:creator><cp:lastModifiedBy>${person}</cp:lastModifiedBy><dc:title>틀</dc:title></cp:coreProperties>`);
  put('docProps/app.xml', `<Properties><Company>${person} 회사</Company><Manager>${person}</Manager></Properties>`);
  put('word/document.xml', `<w:document><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`);
  return z.generateAsync({ type: 'nodebuffer' });
}
const kitFile = (root, rel) => join(root, '보관함', '프로필제작', '양식', ...rel.split('/'));
function putKit(root, files) {
  for (const [rel, data] of Object.entries(files)) { mkdirSync(dirname(kitFile(root, rel)), { recursive: true }); writeFileSync(kitFile(root, rel), data); }
}
const sharedKit = (program, rel) => join(sharedFilesDir(program), '프로필제작', '양식', ...rel.split('/'));

test('보관함 자료 publish: 양식을 shared/보관함/에 싣고 문서 정보(작성자·회사)는 지우며, 실명·연락처가 있으면 쓰지 않는다', async (t) => {
  const root = ownerPc(t);
  const program = tempDir(t, 'office-shared-program-');
  putKit(root, { '작성기준서.md': '# 기준\n', '도구/check.cjs': 'ok\n', '틀/틀.docx': await fakeDocx('{{예명}} 소개', '홍길동') });
  const dry = await publishSharedFiles({ root, program, names: ['가나다'], dryRun: true });
  assert.deepEqual(dry.added, ['프로필제작/양식/도구/check.cjs', '프로필제작/양식/작성기준서.md', '프로필제작/양식/틀/틀.docx']);
  assert.equal(existsSync(sharedFilesDir(program)), false, '미리 보기는 쓰지 않는다');

  const r = await publishSharedFiles({ root, program, names: ['가나다'] });
  assert.equal(r.total, 3);
  const z = await JSZip.loadAsync(readFileSync(sharedKit(program, '틀/틀.docx')));
  for (const part of ['docProps/core.xml', 'docProps/app.xml']) assert.doesNotMatch(await z.file(part).async('string'), /홍길동/, `${part}의 사람 이름을 지운다`);
  assert.match(await z.file('docProps/core.xml').async('string'), /<dc:title>틀<\/dc:title>/, '그 밖의 문서 정보는 그대로');
  assert.match(await z.file('word/document.xml').async('string'), /\{\{예명\}\} 소개/, '본문은 그대로');
  const sourceZip = await JSZip.loadAsync(readFileSync(kitFile(root, '틀/틀.docx')));
  assert.deepEqual(Object.keys(z.files).sort(), Object.keys(sourceZip.files).sort(), '원본에 없는 항목(지금 시각의 폴더 항목 등)을 더하지 않는다: 더하면 올릴 때마다 파일이 달라진다');
  const original = await JSZip.loadAsync(readFileSync(kitFile(root, '틀/틀.docx')));
  assert.match(await original.file('docProps/core.xml').async('string'), /홍길동/, '대표 PC의 원본은 그대로');
  assert.equal((await publishSharedFiles({ root, program, names: ['가나다'] })).changedAny, false, '같은 내용이면 다시 쓰지 않는다');

  // 원본에서 지운 파일은 공유본에서도 지운다
  rmSync(kitFile(root, '도구/check.cjs'));
  assert.deepEqual((await publishSharedFiles({ root, program, names: ['가나다'] })).removed, ['프로필제작/양식/도구/check.cjs']);
  assert.equal(existsSync(sharedKit(program, '도구/check.cjs')), false);

  // 실명·연락처가 남아 있으면 아무것도 쓰지 않는다(문서 본문도 검사)
  putKit(root, { '작성기준서.md': '# 기준\n담당 가나다 010-1234-5678\n' });
  await assert.rejects(publishSharedFiles({ root, program, names: ['가나다'] }), (err) => /이름 "가나다"\(보관함\/프로필제작\/양식\/작성기준서\.md\)/.test(err.message) && /휴대폰 번호/.test(err.message));
  assert.equal(readFileSync(sharedKit(program, '작성기준서.md'), 'utf8'), '# 기준\n');
  putKit(root, { '작성기준서.md': '# 기준\n', '틀/틀.docx': await fakeDocx('담당 가나다', '홍길동') });
  await assert.rejects(publishSharedFiles({ root, program, names: ['가나다'] }), /이름 "가나다"\(보관함\/프로필제작\/양식\/틀\/틀\.docx\)/);

  // 원본 폴더가 없는 PC(양식을 안 옮긴 집 PC 등)는 실린 것을 그대로 둔다
  const kept = await publishSharedFiles({ root: ownerPc(t), program, names: ['가나다'] });
  assert.deepEqual(kept.kept, [...SHARED_VAULT_DIRS], '원본이 없는 폴더는 모두 그대로 둔다');
  assert.equal(kept.changedAny, false);
  assert.ok(existsSync(sharedKit(program, '작성기준서.md')));
});

test('보관함 자료 apply·refresh: 받는 PC 보관함/에 넣고, 자료만 바뀌면 회사 구성은 그대로 둔 채 자료만 맞춘다(고친 파일은 백업)', async (t) => {
  const owner = ownerPc(t);
  const program = tempDir(t, 'office-shared-program-');
  putKit(owner, { '작성기준서.md': '# 기준 1\n', '도구/check.cjs': 'v1\n' });
  publishSharedOrg({ root: owner, program, names: ['가나다'] });
  await publishSharedFiles({ root: owner, program, names: ['가나다'] });

  const member = tempDir(t, 'office-shared-member-');
  const a = await applySharedOrg({ root: member, program, name: '라마바' });
  assert.equal(a.files.total, 2);
  assert.equal(a.files.copied.length, 2);
  assert.equal(readFileSync(kitFile(member, '작성기준서.md'), 'utf8'), '# 기준 1\n');
  assert.equal(readSharedMarker(member).filesSha256, sharedFilesSha(program));
  assert.deepEqual(await refreshSharedOrg({ root: member, program }), { applied: false, reason: 'up-to-date' });
  assert.equal(sharedOrgStatus({ root: member, program }).files.total, 2);

  // 받는 PC에서 고친 규칙·양식, 그 PC에만 있는 파일
  saveCompanyRules(member, '이 PC에서 고친 규칙');
  writeFileSync(kitFile(member, '작성기준서.md'), '# 이 PC에서 고침\n');
  writeFileSync(kitFile(member, '내 메모.md'), '지우지 않는다\n');
  // 대표가 양식만 고쳐 올림
  putKit(owner, { '작성기준서.md': '# 기준 2\n' });
  await publishSharedFiles({ root: owner, program, names: ['가나다'] });
  assert.equal(sharedOrgStatus({ root: member, program }).upToDate, false);
  const r = await refreshSharedOrg({ root: member, program });
  assert.equal(r.applied, true);
  assert.equal(r.filesOnly, true);
  assert.deepEqual(r.files.copied, ['프로필제작/양식/작성기준서.md']);
  assert.equal(readFileSync(kitFile(member, '작성기준서.md'), 'utf8'), '# 기준 2\n');
  assert.equal(readFileSync(join(r.files.backup, '프로필제작', '양식', '작성기준서.md'), 'utf8'), '# 이 PC에서 고침\n', '덮어쓰기 전 파일을 백업한다');
  assert.ok(existsSync(kitFile(member, '내 메모.md')), '레포에 없는 이 PC 파일은 지우지 않는다');
  assert.match(loadCompanyRules(member), /이 PC에서 고친 규칙/, '자료만 바뀌면 회사 구성을 다시 덮어쓰지 않는다');
  assert.equal(sharedOrgStatus({ root: member, program }).upToDate, true);

  // 대표 PC(표식 없음)에는 넣지 않는다
  assert.deepEqual(await refreshSharedOrg({ root: owner, program }), { applied: false, reason: 'not-subscribed' });
});

test('보관함 자료: 이 기능 전에 가져온 PC(표식에 자료 지문 없음)도 업데이트 뒤 서버를 켤 때 자료를 받는다', async (t) => {
  const owner = ownerPc(t);
  const program = tempDir(t, 'office-shared-program-');
  publishSharedOrg({ root: owner, program, names: ['가나다'] });
  const member = tempDir(t, 'office-shared-member-');
  await applySharedOrg({ root: member, program, name: '라마바' });
  // 예전 표식: filesSha256 칸이 없다
  const marker = readSharedMarker(member);
  delete marker.filesSha256;
  writeFileSync(join(member, '.office', 'shared-org.json'), JSON.stringify(marker));
  assert.deepEqual(await refreshSharedOrg({ root: member, program }), { applied: false, reason: 'up-to-date' }, '실린 자료가 없으면 할 일이 없다');
  // 업데이트로 양식이 실린 레포를 받음
  putKit(owner, { '작성기준서.md': '# 기준\n' });
  await publishSharedFiles({ root: owner, program, names: ['가나다'] });
  const r = await refreshSharedOrg({ root: member, program });
  assert.equal(r.filesOnly, true);
  assert.equal(readFileSync(kitFile(member, '작성기준서.md'), 'utf8'), '# 기준\n');
  assert.equal(r.files.backup, null, '처음 받는 파일은 백업할 것이 없다');
});

// ERP 주소: 공개 저장소에는 자리 표시로 올리고, 받는 PC가 처음 가져올 때 한 번 입력한다
test('ERP 주소: 올릴 때 자리 표시로 바꾸고, 받는 PC는 입력한 주소로 채워 기억한다', async (t) => {
  const { ERP_PLACEHOLDER, cleanErp } = await import('../lib/shared-org.mjs');
  const ERP = 'https://erp.example.invalid';
  const owner = ownerPc(t), program = tempDir(t, 'office-shared-program-');
  saveCompanyRules(owner, `가나다 대표의 회사 규칙\n실적 화면은 ${ERP}/erp/counselor-performance 이다.`);
  const r = publishSharedOrg({ root: owner, program, names: ['가나다'], erp: `${ERP}/` });
  assert.equal(r.erpReplaced, 1);
  const text = readFileSync(sharedOrgFile(program), 'utf8');
  assert.ok(text.includes(`${ERP_PLACEHOLDER}/erp/counselor-performance`));
  assert.ok(!text.includes('erp.example.invalid'), '주소가 공개 파일에 남지 않는다');

  // 주소 없이 가져와도 막지 않고, 자리 표시를 둔 채 주소가 필요하다고 알린다
  const pc = tempDir(t, 'office-shared-pc-');
  const first = await applySharedOrg({ root: pc, program, name: '홍길동' });
  assert.equal(first.erpNeeded, true);
  assert.ok(loadCompanyRules(pc).includes(ERP_PLACEHOLDER));
  assert.equal(sharedOrgStatus({ root: pc, program }).erpNeeded, true);

  // 주소를 한 번 주면 채우고 표식에 기억한다. 다음부터는 주소 없이도 같은 주소로 맞춘다
  const second = await applySharedOrg({ root: pc, program, erp: ERP });
  assert.equal(second.erpNeeded, false);
  assert.ok(loadCompanyRules(pc).includes(`${ERP}/erp/counselor-performance`));
  assert.equal(readSharedMarker(pc).erp, ERP);
  saveCompanyRules(owner, `가나다 대표의 새 규칙\n실적 화면은 ${ERP}/erp/counselor-performance 이다.`);
  publishSharedOrg({ root: owner, program, names: ['가나다'], erp: ERP });
  await refreshSharedOrg({ root: pc, program });
  assert.ok(loadCompanyRules(pc).includes(`새 규칙\n실적 화면은 ${ERP}/erp/`));
  assert.equal(sharedOrgStatus({ root: pc, program }).erpNeeded, false);

  // 주소 형식: https 도메인까지만
  assert.equal(cleanErp('https://erp.example.invalid/'), ERP);
  for (const bad of ['erp.example.invalid', 'http://erp.example.invalid', `${ERP}/erp/login`, 'https://user:pw@erp.example.invalid']) assert.throws(() => cleanErp(bad));
});

test('ERP 주소: 도메인만 적은 곳이 남아 있으면 올리지 않는다', (t) => {
  const owner = ownerPc(t), program = tempDir(t, 'office-shared-program-');
  saveCompanyRules(owner, '가나다 대표의 회사 규칙\n주소는 erp.example.invalid/erp 이다.');
  assert.throws(() => publishSharedOrg({ root: owner, program, names: ['가나다'], erp: 'https://erp.example.invalid' }), /ERP 주소/);
  assert.ok(!existsSync(sharedOrgFile(program)));
});
