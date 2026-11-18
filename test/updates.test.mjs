import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SHARED_ORG_REL } from '../lib/shared-org.mjs';
import { gitRunner, releaseProgram, updateMessage, updateProgram, webUrl } from '../lib/updates.mjs';

// 테스트 커밋 작성자(사용자 git 설정과 무관하게)
const GIT_ENV = { GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.invalid' };
Object.assign(process.env, GIT_ENV);

const hasGit = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
// Windows의 core.autocrlf로 받은 파일 줄바꿈이 CRLF가 될 수 있다
const lf = (s) => s.replace(/\r\n/g, '\n');

function sh(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function write(repo, rel, text) {
  mkdirSync(join(repo, ...rel.split('/').slice(0, -1)), { recursive: true });
  writeFileSync(join(repo, ...rel.split('/')), text);
}

function commit(repo, rel, text, message) {
  write(repo, rel, text);
  sh(repo, 'add', '--', rel);
  sh(repo, 'commit', '-q', '-m', message);
}

// 원격(bare)과 대표 PC 사본(owner). 파트장 PC 사본은 clone(name)으로 만든다
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'office-updates-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const bare = join(dir, 'remote.git');
  sh(dir, 'init', '-q', '--bare', bare);
  sh(bare, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  const owner = join(dir, 'owner');
  sh(dir, 'clone', '-q', bare, owner);
  sh(owner, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  commit(owner, 'README.md', '처음\n', 'chore: 처음');
  commit(owner, SHARED_ORG_REL, '{"v":1}\n', 'chore: 공유 구성');
  sh(owner, 'push', '-q', '-u', 'origin', 'main');
  const clone = (name) => {
    const p = join(dir, name);
    sh(dir, 'clone', '-q', bare, p);
    return p;
  };
  return { dir, bare, owner, clone };
}

function hooks(overrides = {}) {
  const calls = [];
  return {
    calls,
    busy: async () => overrides.busy ?? 0,
    stopServer: async () => { calls.push('stop'); return true; },
    startServer: async () => { calls.push('start'); },
    install: async () => { calls.push('install'); },
  };
}

test('webUrl: git 원격 주소를 열 수 있는 주소로', () => {
  assert.equal(webUrl('https://github.com/Lupus-01/ai-office.git'), 'https://github.com/Lupus-01/ai-office');
  assert.equal(webUrl('git@github.com:Lupus-01/ai-office.git'), 'https://github.com/Lupus-01/ai-office');
  assert.equal(webUrl('https://user:token@github.com/x/y.git'), 'https://github.com/x/y');
  assert.match(updateMessage('https://github.com/x/y'), /"https:\/\/github\.com\/x\/y 최신 버전으로 업데이트해줘"/);
});

test('update: 이미 최신이면 서버를 건드리지 않는다', { skip: !hasGit && 'git 없음' }, async (t) => {
  const { clone } = setup(t);
  const member = clone('member');
  const h = hooks();
  const r = await updateProgram({ git: gitRunner(member), ...h });
  assert.equal(r.updated, false);
  assert.deepEqual(h.calls, []);
});

test('update: 새 커밋을 fast-forward로 받고, 서버를 껐다 켜며, 부품·공유 구성 변경을 알려 준다', { skip: !hasGit && 'git 없음' }, async (t) => {
  const { owner, clone } = setup(t);
  const member = clone('member');
  commit(owner, 'README.md', '둘째\n', 'docs: 안내 고침');
  sh(owner, 'push', '-q');
  let h = hooks();
  let r = await updateProgram({ git: gitRunner(member), ...h });
  assert.equal(r.updated, true);
  assert.deepEqual(r.commits, ['docs: 안내 고침']);
  assert.equal(r.installed, false);
  assert.equal(r.sharedChanged, false);
  assert.deepEqual(h.calls, ['stop', 'start']);
  assert.equal(lf(readFileSync(join(member, 'README.md'), 'utf8')), '둘째\n');

  commit(owner, 'package-lock.json', '{}\n', 'chore: 부품');
  commit(owner, SHARED_ORG_REL, '{"v":2}\n', 'chore: 공유 회사 구성 갱신');
  sh(owner, 'push', '-q');
  h = hooks();
  r = await updateProgram({ git: gitRunner(member), ...h });
  assert.deepEqual(r.commits, ['chore: 공유 회사 구성 갱신', 'chore: 부품']);
  assert.equal(r.installed, true);
  assert.equal(r.sharedChanged, true);
  assert.deepEqual(h.calls, ['stop', 'install', 'start']);
});

test('update: 고친 파일·이 PC에만 있는 커밋·진행 중 업무가 있으면 받지 않는다(--force는 업무만 넘긴다)', { skip: !hasGit && 'git 없음' }, async (t) => {
  const { owner, clone } = setup(t);
  const member = clone('member');
  commit(owner, 'README.md', '둘째\n', 'docs: 안내 고침');
  sh(owner, 'push', '-q');

  write(member, 'README.md', '파트장이 고침\n');
  let h = hooks();
  await assert.rejects(updateProgram({ git: gitRunner(member), ...h }), /고친 파일이 있어.*README\.md/);
  assert.deepEqual(h.calls, []);
  sh(member, 'checkout', '-q', '--', 'README.md');

  h = hooks({ busy: 2 });
  await assert.rejects(updateProgram({ git: gitRunner(member), ...h }), /진행 중인 업무가 2건/);
  assert.deepEqual(h.calls, []);
  const forced = await updateProgram({ git: gitRunner(member), ...h, force: true });
  assert.equal(forced.updated, true);

  const other = clone('other');
  commit(other, 'local.txt', 'x\n', 'local');
  commit(owner, 'README.md', '셋째\n', 'docs: 또 고침');
  sh(owner, 'push', '-q');
  await assert.rejects(updateProgram({ git: gitRunner(other), ...hooks() }), /이 PC에만 있는 커밋이 1개/);
});

test('release: 공유 구성이 바뀌면 커밋해 올리고, 바뀐 게 없으면 올리지 않는다', { skip: !hasGit && 'git 없음' }, async (t) => {
  const { bare, owner, clone } = setup(t);
  const publish = (text) => async () => {
    write(owner, SHARED_ORG_REL, text);
    return { changed: true, summary: { departments: 3, roster: 5 } };
  };
  let r = await releaseProgram({ git: gitRunner(owner), publish: publish('{"v":1}\n') });
  assert.equal(r.pushed, false);
  assert.equal(r.sharedCommitted, false);

  r = await releaseProgram({ git: gitRunner(owner), publish: publish('{"v":2}\n') });
  assert.equal(r.pushed, true);
  assert.equal(r.sharedCommitted, true);
  assert.deepEqual(r.commits, ['chore: 공유 회사 구성 갱신 (부서 3개 · 직원 5명)']);
  assert.equal(r.url, webUrl(bare));
  assert.equal(sh(bare, 'log', '-1', '--format=%s', 'main'), 'chore: 공유 회사 구성 갱신 (부서 3개 · 직원 5명)');

  // 개발 커밋만 있어도 올린다
  commit(owner, 'lib.txt', 'code\n', 'feat: 기능');
  r = await releaseProgram({ git: gitRunner(owner), publish: publish('{"v":2}\n') });
  assert.equal(r.pushed, true);
  assert.equal(r.sharedCommitted, false);
  assert.deepEqual(r.commits, ['feat: 기능']);

  // 파트장 PC는 그대로 받는다
  const member = clone('member');
  assert.equal(lf(readFileSync(join(member, ...SHARED_ORG_REL.split('/')), 'utf8')), '{"v":2}\n');
});

test('release: 커밋 안 된 코드 변경·원격이 앞섬·main이 아님이면 올리지 않는다', { skip: !hasGit && 'git 없음' }, async (t) => {
  const { owner, clone } = setup(t);
  const publish = async () => ({ changed: false, summary: { departments: 1, roster: 1 } });
  write(owner, 'README.md', '고치는 중\n');
  await assert.rejects(releaseProgram({ git: gitRunner(owner), publish }), /커밋하지 않은 프로그램 변경.*README\.md/);
  sh(owner, 'checkout', '-q', '--', 'README.md');

  const home = clone('home');
  commit(home, 'home.txt', 'x\n', '집 PC 작업');
  sh(home, 'push', '-q');
  await assert.rejects(releaseProgram({ git: gitRunner(owner), publish }), /이 PC에 없는 커밋이 1개/);
  sh(owner, 'pull', '-q', '--ff-only');

  sh(owner, 'checkout', '-q', '-b', 'work');
  await assert.rejects(releaseProgram({ git: gitRunner(owner), publish }), /main 브랜치에서만/);
});
