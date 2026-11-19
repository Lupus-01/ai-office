#!/usr/bin/env node
// 업데이트(npm run office:update): 대표가 올린 새 버전을 받아 서버를 다시 켠다. 공유 회사 구성을 쓰는 PC는 켤 때 새 구성으로 맞춘다.
//   node scripts/update.mjs [--from <저장소 주소>] [--switch] [--force]
//     --from    대표가 보내 준 주소. 이 PC가 받는 주소와 다르면 멈춘다(--switch를 붙이면 그 주소로 바꿔 받는다)
//     --force   진행 중 업무가 있어도 받는다(그 업무는 멈춘다)
// 부품을 다시 설치(npm ci)하면 몇 분 걸릴 수 있다. AI 도구로 실행할 때는 제한 시간을 10분으로 둔다.
import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { insideOfficeRun, readDashboardAccess } from '../lib/dashboard-access.mjs';
import { programRoot, workspaceRoot } from '../lib/paths.mjs';
import { runningServer } from '../lib/server-lock.mjs';
import { sharedOrgStatus } from '../lib/shared-org.mjs';
import { gitRunner, updateProgram } from '../lib/updates.mjs';
import { createClient } from './office-ask.mjs';

const ACTIVE = new Set(['running', 'queued']);

function parse(args) {
  const out = { force: false, switchRemote: false, from: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--force') out.force = true;
    else if (a === '--switch') out.switchRemote = true;
    else if (a === '--from') {
      out.from = args[++i];
      if (!out.from) throw new Error('--from 뒤에 저장소 주소를 적으세요.');
    } else if (a.startsWith('--from=')) out.from = a.slice(7);
    else throw new Error(`알 수 없는 인자입니다: ${a}`);
  }
  return out;
}

// 대표가 지시한 대화 실행 중 진행 중인 것. 상시 감시(그 감시의 회차 조회 포함)는 서버를 다시 켜면 이어지므로 세지 않는다
async function busyRuns(root) {
  if (!runningServer(root)) return 0;
  const access = readDashboardAccess(root);
  if (!access) return 0;
  const state = await createClient(access).state();
  return (state.runs || []).filter((r) => !r.phase && r.target !== 'review' && !r.continuous && !r.monitorId && ACTIVE.has(r.status)).length;
}

// 지난번 설치가 끝나지 않았거나(npm ci는 시작할 때 node_modules를 지운다) lock 파일보다 오래됐는가
function installStale(program) {
  const lock = join(program, 'package-lock.json');
  const hidden = join(program, 'node_modules', '.package-lock.json');
  if (!existsSync(lock)) return false;
  if (!existsSync(hidden)) return true;
  return statSync(hidden).mtimeMs + 1000 < statSync(lock).mtimeMs;
}

function bg(program, cmd, extra = []) {
  const r = spawnSync(process.execPath, [join(program, 'scripts', 'office-bg.mjs'), cmd, ...extra], { cwd: program, stdio: 'inherit', windowsHide: true });
  if (r.status !== 0) throw new Error(`서버를 ${cmd === 'start' ? '켜지' : '끄지'} 못했습니다.`);
}

async function main(args) {
  if (insideOfficeRun()) throw new Error('대시보드 업무 실행 중인 AI는 프로그램을 업데이트할 수 없습니다.');
  const opts = parse(args);
  const program = programRoot();
  const root = workspaceRoot();
  let restartArgs = [];
  const r = await updateProgram({
    git: gitRunner(program),
    force: opts.force,
    from: opts.from,
    switchRemote: opts.switchRemote,
    busy: () => busyRuns(root),
    installStale: () => installStale(program),
    stopServer: async () => {
      const info = runningServer(root);
      if (!info) return false;
      // 켜져 있던 주소(포트·호스트)로 다시 켠다
      if (info.port && info.port !== 4777) restartArgs.push('--port', String(info.port));
      if (info.host && info.host !== '127.0.0.1') restartArgs.push('--host', String(info.host));
      bg(program, 'stop');
      return true;
    },
    startServer: async () => bg(program, 'start', restartArgs),
    install: async () => {
      console.log('필요한 부품을 다시 설치합니다(npm ci, 몇 분 걸릴 수 있습니다)…');
      const res = spawnSync('npm ci', { cwd: program, stdio: 'inherit', shell: true, windowsHide: true });
      if (res.status !== 0) throw new Error('부품 설치(npm ci)에 실패했습니다. 인터넷 연결을 확인하고 다시 업데이트하세요(다시 하면 설치부터 이어서 합니다).');
    },
  });
  if (r.switched) console.log(`받는 주소를 바꿨습니다: ${r.switched.from} → ${r.switched.to}`);
  if (r.updated) {
    console.log(`\n업데이트했습니다: ${r.from} → ${r.to}`);
    console.log('바뀐 내용:');
    for (const c of r.commits.slice(0, 15)) console.log(`  - ${c}`);
    if (r.commits.length > 15) console.log(`  … 외 ${r.commits.length - 15}개`);
    if (r.installed) console.log('필요한 부품도 다시 설치했습니다.');
  } else if (r.repaired) console.log(`새 버전은 없고(${r.from}), 끝나지 않았던 부품 설치를 마치고 서버를 다시 켰습니다.`);
  else console.log(`이미 최신 버전입니다(${r.from}).`);
  const s = sharedOrgStatus({ root, program });
  if (s.subscribed) console.log(s.upToDate ? `회사 구성: 대표 공유 구성 최신(부서 ${s.current.departments}개 · 직원 ${s.current.roster}명)` : '회사 구성: 새 공유 구성은 서버를 켤 때 맞춥니다. 서버가 꺼져 있으면 서버를 켜 주세요.');
  else if (s.exists && !s.current.departments) console.log('회사 구성: 아직 홍카페 공유 구성을 가져오지 않았습니다. 가져오려면 node scripts/shared-org.mjs apply --name <담당자 이름>');
}

try {
  await main(process.argv.slice(2));
} catch (err) {
  console.error(`오류: ${err.message}`);
  process.exit(1);
}
