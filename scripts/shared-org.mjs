#!/usr/bin/env node
// 공유 회사 구성(shared/company-org.json) 받기·올리기
//   node scripts/shared-org.mjs status                         공유 파일·이 PC 적용 상태 보기
//   node scripts/shared-org.mjs apply --name <이름> [--yes]     공유 구성을 이 PC에 가져오기(이후 서버를 켤 때 새 버전으로 자동 맞춤)
//   node scripts/shared-org.mjs apply                          이미 가져온 PC에서 저장된 이름으로 지금 다시 맞추기
//   node scripts/shared-org.mjs stop                           자동 맞춤 그만두기(회사 구성은 그대로)
//   node scripts/shared-org.mjs publish --name <이름>[,<이름>]  (대표 PC) 지금 회사 구성을 이름을 빼고 공유 파일로 쓰기
import { programRoot, workspaceRoot } from '../lib/paths.mjs';
import { ensureWorkspace, isCompatRoot } from '../lib/workspace.mjs';
import { SHARED_ORG_REL, applySharedOrg, publishSharedOrg, sharedOrgStatus, stopSharedOrg } from '../lib/shared-org.mjs';

const USAGE = `사용법:
  node scripts/shared-org.mjs status
  node scripts/shared-org.mjs apply --name <이름> [--yes]
  node scripts/shared-org.mjs stop
  node scripts/shared-org.mjs publish --name <이름>[,<이름>]`;

function parse(args) {
  const out = { yes: false, name: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--yes' || a === '-y') out.yes = true;
    else if (a === '--name') {
      out.name = args[++i];
      if (out.name === undefined) throw new Error('--name 뒤에 이름을 적으세요.');
    } else if (a.startsWith('--name=')) out.name = a.slice(7);
    else throw new Error(`알 수 없는 인자입니다: ${a}`);
  }
  return out;
}

const describe = (s) => `부서 ${s.departments}개 · 직원 ${s.roster}명${s.company ? ' · 회사 공통 규칙 있음' : ''}`;

async function main([cmd, ...rest]) {
  if (process.env.OFFICE_CHIEF_RUN === '1') throw new Error('공유 회사 구성은 사용자가 프로그램 폴더에서 직접 실행합니다(비서실장 실행에서는 쓸 수 없습니다).');
  const program = programRoot();
  const root = workspaceRoot();
  const opts = parse(rest);
  if (cmd === 'status') {
    const s = sharedOrgStatus({ root, program });
    if (!s.exists) console.log(`공유 회사 구성 파일이 없습니다(${SHARED_ORG_REL}).`);
    else console.log(`공유 회사 구성: ${s.summary ? describe(s.summary) : '형식 오류'}`);
    console.log(`이 PC 회사 구성: 부서 ${s.current.departments}개 · 직원 ${s.current.roster}명`);
    if (s.subscribed) console.log(`가져옴: 담당자 이름 ${s.name} · ${s.appliedAt} · ${s.upToDate ? '최신' : '새 버전 있음(서버를 다시 켜거나 apply)'}`);
    else console.log('아직 가져오지 않았습니다.');
    return;
  }
  if (cmd === 'apply') {
    if (!isCompatRoot(root, program)) ensureWorkspace(root, { program });
    const r = await applySharedOrg({ root, program, name: opts.name ?? undefined, force: opts.yes });
    console.log(`공유 회사 구성을 가져왔습니다: ${describe(r.summary)} · 담당자 이름 ${r.name}`);
    console.log(`에이전트 파일: 생성·갱신 ${r.sync.changed.length}개, 삭제 ${r.sync.removed.length}개`);
    console.log('앞으로 서버를 켤 때 새 버전이 있으면 자동으로 맞춥니다(이 PC에서 고친 부서·지침은 덮어씁니다). 그만두려면 stop.');
    return;
  }
  if (cmd === 'stop') {
    console.log(stopSharedOrg(root) ? '자동 맞춤을 그만뒀습니다. 지금 회사 구성은 그대로입니다.' : '자동 맞춤을 쓰고 있지 않습니다.');
    return;
  }
  if (cmd === 'publish') {
    const names = String(opts.name ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!names.length) throw new Error('공개 파일에서 뺄 이름을 --name으로 지정하세요.');
    const r = publishSharedOrg({ root, program, names });
    const counts = Object.values(r.replaced).reduce((a, b) => a + b, 0);
    console.log(`${r.changed ? '공유 파일을 썼습니다' : '바뀐 내용이 없습니다'}: ${SHARED_ORG_REL} · ${describe(r.summary)} · 이름 ${counts}곳을 자리 표시로 바꿈`);
    return;
  }
  throw Object.assign(new Error('알 수 없는 명령입니다.'), { usage: true });
}

try {
  await main(process.argv.slice(2));
} catch (err) {
  console.error(`오류: ${err.message}`);
  if (err.usage || !process.argv[2]) console.error(USAGE);
  process.exit(1);
}
