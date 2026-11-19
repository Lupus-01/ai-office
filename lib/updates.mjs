// 업데이트·배포: 대표 PC가 포크 main에 올리고(release), 파트장 PC가 받는다(update).
// git 실행·서버 켜고 끄기·의존성 설치·진행 중 업무 확인은 바깥에서 넣는다(테스트에서 바꿔 넣는다).
import { spawnSync } from 'node:child_process';
import { SHARED_ORG_REL } from './shared-org.mjs';

export function gitRunner(cwd) {
  return (args, { allowFail = false } = {}) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
    if (r.error) throw new Error(`git을 실행하지 못했습니다: ${r.error.message}`);
    const out = (r.stdout || '').trim();
    const err = (r.stderr || '').trim();
    if (r.status !== 0 && !allowFail) throw new Error(`git ${args.find((a) => !a.startsWith('-') && !a.includes('=')) || args[0]}에 실패했습니다: ${err || out}`);
    return { ok: r.status === 0, out, err };
  };
}

const lines = (s) => String(s || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
const count = (git, range) => Number(git(['rev-list', '--count', range]).out) || 0;
const PACKAGE_FILES = ['package.json', 'package-lock.json'];

// 추적 파일 중 HEAD와 달라진 것(스테이징 여부 무관, 새 파일은 보지 않는다)
function dirtyFiles(git) {
  return lines(git(['-c', 'core.quotepath=off', 'diff', '--name-only', 'HEAD']).out);
}

function upstreamOf(git) {
  const u = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { allowFail: true });
  if (!u.ok || !u.out.includes('/')) {
    throw new Error(`이 프로그램 폴더는 받아 올 원격 브랜치를 찾지 못했습니다(git clone으로 받은 폴더인지 확인하세요).${u.err ? ` git: ${u.err}` : ''}`);
  }
  const [remote, ...rest] = u.out.split('/');
  return { ref: u.out, remote, branch: rest.join('/') };
}

// git 원격 주소를 사람이 여는 주소로(https://github.com/<소유자>/<저장소>)
export function webUrl(remoteUrl) {
  const s = String(remoteUrl || '').trim();
  const ssh = s.match(/^git@([^:]+):(.+?)(?:\.git)?\/?$/);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  return s.replace(/^git\+/, '').replace(/\/\/[^@/]+@/, '//').replace(/\.git\/?$/, '').replace(/\/$/, '');
}
const sameRepo = (a, b) => webUrl(a).toLowerCase() === webUrl(b).toLowerCase();

// 파트장 PC: 원격의 새 커밋을 fast-forward로 받는다.
// busy(): 진행 중 업무 수, stopServer(), startServer(), install(): npm ci, installStale(): 설치가 깨졌거나 lock보다 오래됐는가
// from: 대표가 보낸 저장소 주소(있으면 이 PC가 받는 주소와 같은지 본다). switchRemote: 다르면 그 주소로 바꿔 받는다
export async function updateProgram({
  git, busy = async () => 0, stopServer = async () => false, startServer = async () => {}, install = async () => {},
  installStale = () => false, force = false, from = null, switchRemote = false,
}) {
  const up = upstreamOf(git);
  const dirty = dirtyFiles(git);
  if (dirty.length) throw new Error(`프로그램 폴더에 고친 파일이 있어 업데이트하지 않았습니다: ${dirty.join(', ')}`);
  let switched = null;
  if (from) {
    const current = git(['remote', 'get-url', up.remote]).out;
    if (!sameRepo(current, from)) {
      if (!switchRemote) {
        throw Object.assign(new Error(`이 PC는 ${webUrl(current)}에서 받고 있습니다. 보내 준 주소(${webUrl(from)})와 다릅니다. 그 주소로 바꿔 받으려면 --switch를 붙이세요.`), { code: 'REMOTE_MISMATCH' });
      }
      git(['remote', 'set-url', up.remote, from]);
      switched = { from: webUrl(current), to: webUrl(from) };
    }
  }
  git(['fetch', '--quiet', up.remote]);
  const ahead = count(git, `${up.ref}..HEAD`);
  if (ahead) throw new Error(`이 PC에만 있는 커밋이 ${ahead}개 있어 그대로 받을 수 없습니다. 프로그램 폴더를 직접 고친 적이 있는지 확인하세요.`);
  const behind = count(git, `HEAD..${up.ref}`);
  const from0 = git(['rev-parse', '--short', 'HEAD']).out;
  const stale = installStale();
  if (!behind && !stale) return { updated: false, repaired: false, from: from0, to: from0, commits: [], files: [], switched };
  const active = await busy();
  if (active && !force) throw new Error(`진행 중인 업무가 ${active}건 있습니다. 끝난 뒤 다시 업데이트하세요(지금 하려면 --force, 진행 중 업무는 멈춥니다).`);
  const commits = behind ? lines(git(['log', '--no-merges', '--format=%s', `HEAD..${up.ref}`]).out) : [];
  const files = behind ? lines(git(['-c', 'core.quotepath=off', 'diff', '--name-only', 'HEAD', up.ref]).out) : [];
  await stopServer();
  let failure = null;
  let installed = false;
  try {
    if (behind) git(['merge', '--ff-only', '--quiet', up.ref]);
    // 부품 목록이 바뀌었거나, 지난번 설치가 끝나지 않았으면 다시 설치한다
    if (stale || files.some((f) => PACKAGE_FILES.includes(f)) || installStale()) {
      await install();
      installed = true;
    }
  } catch (err) {
    failure = err;
  }
  // 받기·설치에 실패해도 서버는 다시 켜 본다. 실패 원인은 받기·설치 쪽을 먼저 알린다
  try {
    await startServer();
  } catch (err) {
    if (failure) failure.message += ` (서버도 다시 켜지 못했습니다: ${err.message})`;
    else failure = err;
  }
  if (failure) throw failure;
  return {
    updated: behind > 0, repaired: !behind && installed, from: from0, to: git(['rev-parse', '--short', 'HEAD']).out, commits, files,
    installed, sharedChanged: files.includes(SHARED_ORG_REL), switched,
  };
}

// 대표 PC: 공유 회사 구성을 다시 쓰고(publish) 바뀌었으면 커밋한 뒤, 원격 main에 올린다(강제 push 없음).
// check: 미리 보기만(쓰기·커밋·push 없음). expectedPush: 올릴 저장소 주소(다르면 거부)
export async function releaseProgram({ git, publish, check = false, expectedPush = null }) {
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).out;
  if (branch !== 'main') throw new Error(`main 브랜치에서만 배포합니다(지금: ${branch}).`);
  const up = upstreamOf(git);
  const url = webUrl(git(['remote', 'get-url', up.remote]).out);
  if (expectedPush && !sameRepo(url, expectedPush)) throw new Error(`올릴 저장소가 바뀌었습니다: 지금 ${url}, 지난 배포 ${webUrl(expectedPush)}. 원격 설정을 확인하세요.`);
  const dirty = dirtyFiles(git).filter((f) => f !== SHARED_ORG_REL);
  if (dirty.length) throw new Error(`커밋하지 않은 프로그램 변경이 있어 배포하지 않았습니다: ${dirty.join(', ')}. 개발을 마무리해 커밋한 뒤 배포하세요.`);
  git(['fetch', '--quiet', up.remote]);
  const behind = count(git, `HEAD..${up.ref}`);
  if (behind) throw new Error(`원격에 이 PC에 없는 커밋이 ${behind}개 있습니다(다른 PC에서 올림). 먼저 합친 뒤 배포하세요.`);
  const shared = await publish({ dryRun: check });
  const pending = lines(git(['log', '--no-merges', '--format=%s', `${up.ref}..HEAD`]).out);
  if (check) return { check: true, pushed: false, url, shared, commits: pending };
  let sharedCommitted = false;
  if (lines(git(['-c', 'core.quotepath=off', 'status', '--porcelain', '--untracked-files=all', '--', SHARED_ORG_REL]).out).length) {
    git(['add', '--', SHARED_ORG_REL]);
    const s = shared.summary;
    git(['commit', '--quiet', '-m', `chore: 공유 회사 구성 갱신 (부서 ${s.departments}개 · 직원 ${s.roster}명)`]);
    sharedCommitted = true;
  }
  const ahead = count(git, `${up.ref}..HEAD`);
  if (!ahead) return { pushed: false, sharedCommitted, commits: [], url, shared };
  const commits = lines(git(['log', '--no-merges', '--format=%s', `${up.ref}..HEAD`]).out);
  git(['push', '--quiet', up.remote, `HEAD:refs/heads/${up.branch}`]);
  return { pushed: true, sharedCommitted, commits, url, shared, head: git(['rev-parse', '--short', 'HEAD']).out };
}

export const updateMessage = (url) => `AI Office가 업데이트됐습니다. 터미널에서 Claude(또는 Codex)를 열고 이렇게 말해 주세요.\n"${url} 최신 버전으로 업데이트해줘"`;
