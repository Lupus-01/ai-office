import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportOrg, loadCompanyRules, loadOrg, saveCompanyRules, saveOrg } from '../lib/org.mjs';
import {
  NAME_PLACEHOLDER, SHARED_ORG_REL, applySharedOrg, publishSharedOrg, readSharedMarker, refreshSharedOrg,
  sharedOrgFile, sharedOrgLeaks, sharedOrgStatus, stopSharedOrg,
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
  assert.deepEqual(sharedOrgLeaks({ company: '가나다 님' }, ['가나다']), ['이름 "가나다"']);
  assert.deepEqual(sharedOrgLeaks({ company: '깨끗한 규칙' }, ['가나다']), []);
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
