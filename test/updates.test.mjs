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

test('update: 새 버전이 없어도 지난 설치가 끝나지 않았으면 설치부터 다시 하고 서버를 켠다', { skip: !hasGit && 'git 없음' }, async (t) => {
  const { clone } = setup(t);
  const member = clone('member');
  let stale = true;
  const h = hooks();
  const r = await updateProgram({ git: gitRunner(member), ...h, install: async () => { h.calls.push('install'); stale = false; }, installStale: () => stale });
  assert.equal(r.updated, false);
  assert.equal(r.repaired, true);
  assert.deepEqual(h.calls, ['stop', 'install', 'start']);
  const again = await updateProgram({ git: gitRunner(member), ...hooks(), installStale: () => stale });
  assert.equal(again.repaired, false, '설치가 끝났으면 다시 하지 않는다');
});

test('update: 설치에 실패하면 설치 실패를 먼저 알리고, 서버는 다시 켜 본다', { skip: !hasGit && 'git 없음' }, async (t) => {
  const { owner, clone } = setup(t);
  const member = clone('member');
  commit(owner, 'package-lock.json', '{"v":2}\n', 'chore: 부품');
  sh(owner, 'push', '-q');
  const h = hooks();
  await assert.rejects(updateProgram({
    git: gitRunner(member), ...h,
    install: async () => { h.calls.push('install'); throw new Error('부품 설치(npm ci)에 실패했습니다'); },
    startServer: async () => { h.calls.push('start'); throw new Error('서버를 켜지 못했습니다.'); },
  }), /부품 설치\(npm ci\)에 실패했습니다 \(서버도 다시 켜지 못했습니다: 서버를 켜지 못했습니다\.\)/);
  assert.deepEqual(h.calls, ['stop', 'install', 'start']);
});

test('update: 보내 준 주소와 받는 주소가 다르면 멈추고, --switch면 그 주소로 바꿔 받는다', { skip: !hasGit && 'git 없음' }, async (t) => {
  const { dir, bare, owner, clone } = setup(t);
  const member = clone('member');
  // 같은 이력을 가진 새 저장소(포크)에 새 커밋
  const fork = join(dir, 'fork.git');
  sh(dir, 'clone', '-q', '--bare', bare, fork);
  const forkWork = join(dir, 'fork-work');
  sh(dir, 'clone', '-q', fork, forkWork);
  commit(forkWork, 'README.md', '포크\n', 'feat: 포크에만 있는 변경');
  sh(forkWork, 'push', '-q');
  await assert.rejects(updateProgram({ git: gitRunner(member), ...hooks(), from: fork }), (err) => err.code === 'REMOTE_MISMATCH' && /보내 준 주소/.test(err.message));
  assert.equal(webUrl(sh(member, 'remote', 'get-url', 'origin')), webUrl(bare), '거부하면 주소를 바꾸지 않는다');
  const r = await updateProgram({ git: gitRunner(member), ...hooks(), from: fork, switchRemote: true });
  assert.equal(r.updated, true);
  assert.deepEqual(r.commits, ['feat: 포크에만 있는 변경']);
  assert.equal(r.switched.to, webUrl(fork));
  // 같은 주소면(끝의 .git·대소문자 차이 무시) 그냥 받는다
  const same = await updateProgram({ git: gitRunner(member), ...hooks(), from: `${fork}`.replace(/\.git$/, '') });
  assert.equal(same.updated, false);
  void owner;
});

test('release: 미리 보기는 쓰기·커밋·push를 하지 않고, 올릴 저장소가 바뀌면 멈추며, 처음 생긴 공유 파일도 커밋한다', { skip: !hasGit && 'git 없음' }, async (t) => {
  const { bare, owner } = setup(t);
  const calls = [];
  const publish = (text) => async ({ dryRun }) => {
    calls.push(dryRun);
    if (!dryRun) write(owner, SHARED_ORG_REL, text);
    return { changed: true, summary: { departments: 2, roster: 2 } };
  };
  const head = sh(owner, 'rev-parse', 'HEAD');
  const preview = await releaseProgram({ git: gitRunner(owner), publish: publish('{"v":9}\n'), check: true });
  assert.equal(preview.check, true);
  assert.equal(preview.pushed, false);
  assert.deepEqual(calls, [true]);
  assert.equal(sh(owner, 'rev-parse', 'HEAD'), head);
  assert.equal(sh(owner, 'status', '--porcelain'), '');

  await assert.rejects(releaseProgram({ git: gitRunner(owner), publish: publish('{"v":9}\n'), expectedPush: 'https://github.com/someone/else' }), /올릴 저장소가 바뀌었습니다/);

  // 공유 파일이 아직 Git에 없을 때(처음 배포)도 커밋해서 올린다
  sh(owner, 'rm', '-q', '--', SHARED_ORG_REL);
  sh(owner, 'commit', '-q', '-m', 'chore: 공유 파일 없앰');
  const r = await releaseProgram({ git: gitRunner(owner), publish: publish('{"v":10}\n'), expectedPush: bare });
  assert.equal(r.sharedCommitted, true);
  assert.equal(r.pushed, true);
  assert.equal(lf(sh(bare, 'show', `main:${SHARED_ORG_REL}`)), '{"v":10}');
});
