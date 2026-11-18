#!/usr/bin/env node
// 배포(npm run office:release, 대표 PC): 지금 회사 구성을 실명을 빼고 공유 파일로 쓰고, 바뀌었으면 커밋해 포크 main에 올린다.
//   node scripts/release.mjs [--name <실명>[,<실명>]]   처음 한 번 이름을 주면 프로그램 폴더 .office/release.json(Git 제외)에 기억한다
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { insideOfficeRun } from '../lib/dashboard-access.mjs';
import { writeFileAtomic } from '../lib/org.mjs';
import { programRoot, workspaceRoot } from '../lib/paths.mjs';
import { publishSharedOrg } from '../lib/shared-org.mjs';
import { gitRunner, releaseProgram, updateMessage } from '../lib/updates.mjs';

function parse(args) {
  let name = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--name') name = args[++i] ?? '';
    else if (args[i].startsWith('--name=')) name = args[i].slice(7);
    else throw new Error(`알 수 없는 인자입니다: ${args[i]}`);
  }
  return name;
}

async function main(args) {
  if (insideOfficeRun()) throw new Error('대시보드 업무 실행 중인 AI는 배포할 수 없습니다.');
  const program = programRoot();
  const root = workspaceRoot();
  const configFile = join(program, '.office', 'release.json');
  const saved = (() => {
    try { return JSON.parse(readFileSync(configFile, 'utf8')); } catch { return {}; }
  })();
  const given = parse(args);
  const names = given !== null ? given.split(',').map((s) => s.trim()).filter(Boolean) : Array.isArray(saved.names) ? saved.names : [];
  if (!names.length) throw new Error('공개 파일에서 뺄 실명을 처음 한 번 --name <실명>으로 알려 주세요.');
  const r = await releaseProgram({ git: gitRunner(program), publish: async () => publishSharedOrg({ root, program, names }) });
  if (given !== null) {
    mkdirSync(join(program, '.office'), { recursive: true });
    writeFileAtomic(configFile, JSON.stringify({ ...saved, names }, null, 2) + '\n');
  }
  const s = r.shared.summary;
  console.log(`회사 구성: ${r.sharedCommitted ? '바뀐 내용을 커밋했습니다' : '바뀐 내용 없음'} (부서 ${s.departments}개 · 직원 ${s.roster}명)`);
  if (!r.pushed) {
    console.log('올릴 새 변경이 없습니다. 파트장님 PC는 이미 최신을 받을 수 있는 상태입니다.');
    return;
  }
  console.log(`\nGitHub에 올렸습니다(${r.head}). 이번에 나간 변경:`);
  for (const c of r.commits.slice(0, 15)) console.log(`  - ${c}`);
  if (r.commits.length > 15) console.log(`  … 외 ${r.commits.length - 15}개`);
  console.log(`\n파트장님께 보낼 문구:\n${updateMessage(r.url)}`);
  if (!existsSync(join(program, '.github'))) return;
  console.log('\n자동 검사(CI)는 GitHub Actions에서 몇 분 뒤 끝납니다.');
}

try {
  await main(process.argv.slice(2));
} catch (err) {
  console.error(`오류: ${err.message}`);
  process.exit(1);
}
