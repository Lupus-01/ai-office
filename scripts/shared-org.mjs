#!/usr/bin/env node
// 공유 회사 구성(shared/company-org.json) 받기·올리기
//   node scripts/shared-org.mjs status                         공유 파일·이 PC 적용 상태 보기
//   node scripts/shared-org.mjs apply --name <이름> [--yes]     공유 구성을 이 PC에 가져오기(이후 서버를 켤 때 새 버전으로 자동 맞춤)
//   node scripts/shared-org.mjs apply                          이미 가져온 PC에서 저장된 이름으로 지금 다시 맞추기
//   node scripts/shared-org.mjs stop                           자동 맞춤 그만두기(회사 구성은 그대로)
//   node scripts/shared-org.mjs publish --name <이름>[,<이름>] [--check]  (대표 PC) 지금 회사 구성을 이름을 빼고 공유 파일로 쓰기(--check는 미리 보기)
import { insideOfficeRun } from '../lib/dashboard-access.mjs';
import { programRoot, workspaceRoot } from '../lib/paths.mjs';
import { ensureWorkspace, isCompatRoot } from '../lib/workspace.mjs';
import { SHARED_FILES_REL, SHARED_ORG_REL, applySharedOrg, publishSharedFiles, publishSharedOrg, sharedOrgStatus, stopSharedOrg } from '../lib/shared-org.mjs';

const USAGE = `사용법:
  node scripts/shared-org.mjs status
  node scripts/shared-org.mjs apply --name <이름> [--yes]
  node scripts/shared-org.mjs stop
  node scripts/shared-org.mjs publish --name <이름>[,<이름>] [--check]`;

function parse(args) {
  const out = { yes: false, name: null, erp: null, check: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--yes' || a === '-y') out.yes = true;
    else if (a === '--check') out.check = true;
    else if (a === '--name') {
      out.name = args[++i];
      if (out.name === undefined) throw new Error('--name 뒤에 이름을 적으세요.');
    } else if (a.startsWith('--name=')) out.name = a.slice(7);
    else if (a === '--erp') {
      out.erp = args[++i];
      if (out.erp === undefined) throw new Error('--erp 뒤에 ERP 주소를 적으세요.');
    } else if (a.startsWith('--erp=')) out.erp = a.slice(6);
    else throw new Error(`알 수 없는 인자입니다: ${a}`);
  }
  return out;
}

const describe = (s) => `부서 ${s.departments}개 · 직원 ${s.roster}명${s.company ? ' · 회사 공통 규칙 있음' : ''}`;

async function main([cmd, ...rest]) {
  if (insideOfficeRun()) throw new Error('공유 회사 구성은 사용자가 프로그램 폴더에서 직접 실행합니다(비서실장 실행에서는 쓸 수 없습니다).');
  const program = programRoot();
  const root = workspaceRoot();
  const opts = parse(rest);
  if (cmd === 'status') {
    const s = sharedOrgStatus({ root, program });
    if (!s.exists) console.log(`공유 회사 구성 파일이 없습니다(${SHARED_ORG_REL}).`);
    else console.log(`공유 회사 구성: ${s.summary ? describe(s.summary) : '형식 오류'}`);
    console.log(`이 PC 회사 구성: 부서 ${s.current.departments}개 · 직원 ${s.current.roster}명`);
    console.log(`함께 받는 보관함 자료: ${s.files.total ? `파일 ${s.files.total}개` : '없음'} (${s.files.dirs.map((d) => `보관함/${d}`).join(', ')})`);
    if (s.subscribed) console.log(`가져옴: 담당자 이름 ${s.name} · ${s.appliedAt} · ${s.upToDate ? '최신' : '새 버전 있음(서버를 다시 켜거나 apply)'}`);
    else console.log('아직 가져오지 않았습니다.');
    if (s.erpNeeded) console.log('ERP 주소가 아직 없습니다. 상담사관리부 업무를 쓰려면 한 번 알려 주세요: node scripts/shared-org.mjs apply --erp <ERP 주소>');
    else if (s.erp) console.log('ERP 주소: 입력됨');
    return;
  }
  if (cmd === 'apply') {
    if (!isCompatRoot(root, program)) ensureWorkspace(root, { program });
    const r = await applySharedOrg({ root, program, name: opts.name ?? undefined, erp: opts.erp ?? undefined, force: opts.yes });
    console.log(`공유 회사 구성을 가져왔습니다: ${describe(r.summary)} · 담당자 이름 ${r.name}`);
    console.log(`에이전트 파일: 생성·갱신 ${r.sync.changed.length}개, 삭제 ${r.sync.removed.length}개`);
    if (r.erpNeeded) console.log('ERP 주소가 아직 없습니다. 상담사관리부 업무(상담사 메일 등)를 쓰려면 한 번 알려 주세요: node scripts/shared-org.mjs apply --erp <ERP 주소>');
    else if (r.erp) console.log('ERP 주소: 입력됨(이 PC에만 저장)');
    if (r.backup) console.log(`바꾸기 전 구성 백업: ${r.backup}`);
    if (r.files.total) console.log(`보관함 자료(양식 등): ${r.files.total}개 중 ${r.files.copied.length}개를 넣음${r.files.backup ? ` · 바꾸기 전 파일 백업: ${r.files.backup}` : ''}`);
    console.log('앞으로 서버를 켤 때 새 버전이 있으면 자동으로 맞춥니다(이 PC에서 고친 부서·지침·양식은 덮어쓰고, 바꾸기 전 것은 .office/shared-org-backups/에 남깁니다). 그만두려면 stop.');
    return;
  }
  if (cmd === 'stop') {
    console.log(stopSharedOrg(root) ? '자동 맞춤을 그만뒀습니다. 지금 회사 구성은 그대로입니다.' : '자동 맞춤을 쓰고 있지 않습니다.');
    return;
  }
  if (cmd === 'publish') {
    const names = String(opts.name ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!names.length) throw new Error('공개 파일에서 뺄 이름을 --name으로 지정하세요.');
    // 보관함 자료의 흔적 검사를 먼저 한다(흔적이 있으면 회사 구성도 쓰지 않는다)
    await publishSharedFiles({ root, program, names, dryRun: true });
    const r = publishSharedOrg({ root, program, names, erp: opts.erp, dryRun: opts.check });
    const counts = Object.values(r.replaced).reduce((a, b) => a + b, 0);
    const head = r.dryRun ? (r.changed ? '올리면 공유 파일이 바뀝니다(미리 보기, 쓰지 않음)' : '바뀐 내용이 없습니다') : r.changed ? '공유 파일을 썼습니다' : '바뀐 내용이 없습니다';
    console.log(`${head}: ${SHARED_ORG_REL} · ${describe(r.summary)} · 이름 ${counts}곳을 자리 표시로 바꿈`);
    for (const c of r.changes) console.log(`  - ${c}`);
    const f = await publishSharedFiles({ root, program, names, dryRun: opts.check });
    console.log(`보관함 자료(${SHARED_FILES_REL}): 파일 ${f.total}개 · 추가 ${f.added.length} · 바뀜 ${f.changed.length} · 삭제 ${f.removed.length}${f.dryRun ? '(미리 보기, 쓰지 않음)' : ''}`);
    for (const d of f.kept) console.log(`  - 이 PC에 원본(보관함/${d})이 없어 저장소에 실린 것을 그대로 둡니다`);
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
