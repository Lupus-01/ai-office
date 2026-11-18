#!/usr/bin/env node
// 업데이트(npm run office:update): 대표가 올린 새 버전을 받아 서버를 다시 켠다. 공유 회사 구성을 쓰는 PC는 켤 때 새 구성으로 맞춘다.
//   node scripts/update.mjs [--force]   진행 중 업무가 있어도 받기(그 업무는 멈춘다)
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { insideOfficeRun, readDashboardAccess } from '../lib/dashboard-access.mjs';
import { programRoot, workspaceRoot } from '../lib/paths.mjs';
import { runningServer } from '../lib/server-lock.mjs';
import { sharedOrgStatus } from '../lib/shared-org.mjs';
import { gitRunner, updateProgram } from '../lib/updates.mjs';
import { createClient } from './office-ask.mjs';

const ACTIVE = new Set(['running', 'queued']);

async function busyRuns(root) {
  if (!runningServer(root)) return 0;
  const access = readDashboardAccess(root);
  if (!access) return 0;
  const state = await createClient(access).state();
  return (state.runs || []).filter((r) => !r.phase && r.target !== 'review' && ACTIVE.has(r.status)).length;
}

function bg(program, cmd) {
  const r = spawnSync(process.execPath, [join(program, 'scripts', 'office-bg.mjs'), cmd], { cwd: program, stdio: 'inherit', windowsHide: true });
  if (r.status !== 0) throw new Error(`서버를 ${cmd === 'start' ? '켜지' : '끄지'} 못했습니다.`);
}

async function main(args) {
  if (insideOfficeRun()) throw new Error('대시보드 업무 실행 중인 AI는 프로그램을 업데이트할 수 없습니다.');
  const unknown = args.find((a) => a !== '--force');
  if (unknown) throw new Error(`알 수 없는 인자입니다: ${unknown}`);
  const program = programRoot();
  const root = workspaceRoot();
  const r = await updateProgram({
    git: gitRunner(program),
    force: args.includes('--force'),
    busy: () => busyRuns(root),
    stopServer: async () => {
      if (!runningServer(root)) return false;
      bg(program, 'stop');
      return true;
    },
    startServer: async () => bg(program, 'start'),
    install: async () => {
      console.log('필요한 부품이 바뀌어 다시 설치합니다(npm ci)…');
      const res = spawnSync('npm ci', { cwd: program, stdio: 'inherit', shell: true, windowsHide: true });
      if (res.status !== 0) throw new Error('npm ci에 실패했습니다. 인터넷 연결을 확인하고 다시 업데이트하세요.');
    },
  });
  if (!r.updated) console.log(`이미 최신 버전입니다(${r.from}).`);
  else {
    console.log(`\n업데이트했습니다: ${r.from} → ${r.to}`);
    console.log('바뀐 내용:');
    for (const c of r.commits.slice(0, 15)) console.log(`  - ${c}`);
    if (r.commits.length > 15) console.log(`  … 외 ${r.commits.length - 15}개`);
    if (r.installed) console.log('필요한 부품도 다시 설치했습니다.');
  }
  const s = sharedOrgStatus({ root, program });
  if (s.subscribed) console.log(s.upToDate ? `회사 구성: 대표 공유 구성 최신(부서 ${s.current.departments}개 · 직원 ${s.current.roster}명)` : '회사 구성: 새 공유 구성을 아직 맞추지 못했습니다. 서버 기록(.office/server.log)을 확인하세요.');
  else if (s.exists && !s.current.departments) console.log('회사 구성: 아직 홍카페 공유 구성을 가져오지 않았습니다. 가져오려면 node scripts/shared-org.mjs apply --name <담당자 이름>');
}

try {
  await main(process.argv.slice(2));
} catch (err) {
  console.error(`오류: ${err.message}`);
  process.exit(1);
}
