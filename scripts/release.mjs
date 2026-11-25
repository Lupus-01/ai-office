#!/usr/bin/env node
// 배포(npm run office:release, 대표 PC): 지금 회사 구성을 실명을 빼고 공유 파일로 쓰고, 바뀌었으면 커밋해 포크 main에 올린다.
//   node scripts/release.mjs --check                    미리 보기: 무엇이 바뀌는지·올라갈 커밋만 보여 준다(쓰기·커밋·push 없음)
//   node scripts/release.mjs [--name <실명>[,<실명>]] [--yes]
//     --name  처음 한 번 뺄 실명을 주면 프로그램 폴더 .office/release.json(Git 제외)에 기억한다
//     --yes   자리 표시 수가 지난번보다 줄어도 올린다(실명을 잘못 적으면 자리 표시가 줄어 실명이 그대로 남을 수 있어 기본은 멈춘다)
// 올릴 저장소 주소도 처음 배포 때 기억해 두고, 바뀌면 멈춘다.
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { insideOfficeRun } from '../lib/dashboard-access.mjs';
import { writeFileAtomic } from '../lib/org.mjs';
import { programRoot, workspaceRoot } from '../lib/paths.mjs';
import { SHARED_FILES_REL, SHARED_ORG_REL, publishSharedFiles, publishSharedOrg } from '../lib/shared-org.mjs';
import { gitRunner, releaseProgram, updateMessage } from '../lib/updates.mjs';

function parse(args) {
  const out = { name: null, erp: null, check: false, yes: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--name') out.name = args[++i] ?? '';
    else if (a.startsWith('--name=')) out.name = a.slice(7);
    else if (a === '--erp') out.erp = args[++i] ?? '';
    else if (a.startsWith('--erp=')) out.erp = a.slice(6);
    else if (a === '--check') out.check = true;
    else if (a === '--yes' || a === '-y') out.yes = true;
    else throw new Error(`알 수 없는 인자입니다: ${a}`);
  }
  return out;
}

function printShared(shared) {
  const s = shared.summary;
  const replaced = Object.values(shared.replaced).reduce((a, b) => a + b, 0);
  const prev = shared.previousPlaceholders;
  console.log(`회사 구성: 부서 ${s.departments}개 · 직원 ${s.roster}명 · 실명 ${replaced}곳을 자리 표시로 바꿈(자리 표시 ${shared.placeholders}곳${prev === null ? '' : `, 지난번 ${prev}곳`})`);
  if (shared.erpReplaced) console.log(`ERP 주소 ${shared.erpReplaced}곳을 자리 표시로 바꿈(받는 PC가 처음 가져올 때 입력)`);
  for (const c of shared.changes) console.log(`  - ${c}`);
  const f = shared.files;
  if (!f) return;
  console.log(`보관함 자료(${SHARED_FILES_REL}, 문서 정보의 작성자·회사명은 지우고 올림): 파일 ${f.total}개 · 추가 ${f.added.length} · 바뀜 ${f.changed.length} · 삭제 ${f.removed.length}`);
  for (const [label, list] of [['추가', f.added], ['바뀜', f.changed], ['삭제', f.removed]]) for (const p of list.slice(0, 10)) console.log(`  - ${label}: 보관함/${p}`);
  for (const d of f.kept) console.log(`  - 이 PC에 원본(보관함/${d})이 없어 저장소에 실린 것을 그대로 둡니다`);
}

async function main(args) {
  if (insideOfficeRun()) throw new Error('대시보드 업무 실행 중인 AI는 배포할 수 없습니다.');
  const opts = parse(args);
  const program = programRoot();
  const root = workspaceRoot();
  const configFile = join(program, '.office', 'release.json');
  const saved = (() => {
    try { return JSON.parse(readFileSync(configFile, 'utf8')); } catch { return {}; }
  })();
  const names = opts.name !== null ? opts.name.split(',').map((s) => s.trim()).filter(Boolean) : Array.isArray(saved.names) ? saved.names : [];
  if (!names.length) throw new Error('공개 파일에서 뺄 실명을 처음 한 번 --name <실명>으로 알려 주세요.');
  // 내부 관리 사이트(ERP) 주소도 실명처럼 처음 한 번 알려 주면 기억하고, 올릴 때 자리 표시로 바꾼다
  const erp = opts.erp !== null ? opts.erp.trim() : typeof saved.erp === 'string' ? saved.erp : '';
  const r = await releaseProgram({
    git: gitRunner(program),
    check: opts.check,
    expectedPush: saved.pushUrl || null,
    publish: async ({ dryRun }) => {
      // 먼저 미리 보기로 자리 표시 수를 보고, 줄었으면 쓰기 전에 멈춘다
      const preview = publishSharedOrg({ root, program, names, erp: erp || null, dryRun: true });
      if (!dryRun && !opts.yes && preview.previousPlaceholders !== null && preview.placeholders < preview.previousPlaceholders) {
        printShared(preview);
        throw new Error(`자리 표시가 지난번 ${preview.previousPlaceholders}곳에서 ${preview.placeholders}곳으로 줄었습니다. 실명을 잘못 적었으면 실명이 그대로 공개될 수 있어 멈췄습니다. 지침에서 실명을 뺀 게 맞으면 --yes를 붙이세요.`);
      }
      // 보관함 자료도 먼저 미리 보기로 흔적을 검사한다(흔적이 있으면 회사 구성도 쓰기 전에 멈춘다)
      const filesPreview = await publishSharedFiles({ root, program, names, erp: erp || null, dryRun: true });
      if (dryRun) return { ...preview, files: filesPreview };
      return { ...publishSharedOrg({ root, program, names, erp: erp || null }), files: await publishSharedFiles({ root, program, names, erp: erp || null }) };
    },
  });
  if (opts.name !== null || opts.erp !== null || (r.pushed && !saved.pushUrl)) {
    mkdirSync(join(program, '.office'), { recursive: true });
    writeFileAtomic(configFile, JSON.stringify({ ...saved, names, ...(erp ? { erp } : {}), ...(r.pushed && !saved.pushUrl ? { pushUrl: r.url } : {}) }, null, 2) + '\n');
  }
  printShared(r.shared);
  if (r.check) {
    console.log(`\n미리 보기입니다(쓰기·커밋·push 안 함). 올릴 곳: ${r.url}`);
    if (r.shared.changed) console.log(`공유 파일(${SHARED_ORG_REL})이 위처럼 바뀝니다. 바뀐 지침에 실제 상담사·고객 이름이 없는지 확인하세요.`);
    if (r.shared.files?.changedAny) console.log(`보관함 자료(${SHARED_FILES_REL})가 위처럼 바뀝니다. 바뀐 양식·기준서에 실제 상담사·고객 이름이 없는지 확인하세요.`);
    console.log(r.commits.length ? `함께 올라갈 커밋:\n${r.commits.map((c) => `  - ${c}`).join('\n')}` : '함께 올라갈 다른 커밋은 없습니다.');
    return;
  }
  if (!r.pushed) {
    console.log('올릴 새 변경이 없습니다. 파트장님 PC는 이미 최신을 받을 수 있는 상태입니다.');
    return;
  }
  console.log(`\nGitHub에 올렸습니다(${r.head}). 이번에 나간 변경:`);
  for (const c of r.commits.slice(0, 15)) console.log(`  - ${c}`);
  if (r.commits.length > 15) console.log(`  … 외 ${r.commits.length - 15}개`);
  console.log(`\n파트장님께 보낼 문구:\n${updateMessage(r.url)}`);
  console.log('\n자동 검사(CI)는 GitHub Actions에서 몇 분 뒤 끝납니다.');
}

try {
  await main(process.argv.slice(2));
} catch (err) {
  console.error(`오류: ${err.message}`);
  process.exit(1);
}
