// 공유 회사 구성: 대표가 쓰는 회사 구성(부서·직원·지침·회사 규칙)을 레포의 shared/company-org.json으로 배포한다.
// - 대표 PC(publish): 현재 회사 구성을 내보내며 대표 실명을 자리 표시({{담당자 이름}})로 바꾼다. 공개 저장소라 개인 흔적이 남으면 쓰지 않는다.
// - 받는 PC(apply): 자리 표시를 그 PC 사용자의 이름으로 채워 회사 구성을 통째로 바꾸고, 작업 공간 .office/shared-org.json에 표식을 남긴다.
// - 서버 시작(refresh): 표식이 있는 PC만, 레포의 공유 파일이 바뀌었으면 같은 이름으로 다시 맞춘다. 표식이 없는 PC(대표 PC)는 건드리지 않는다.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { checkOrgImport, exportOrg, importOrg, loadOrg, writeFileAtomic } from './org.mjs';

export const SHARED_ORG_REL = 'shared/company-org.json';
export const NAME_PLACEHOLDER = '{{담당자 이름}}';

export const sharedOrgFile = (program) => join(program, ...SHARED_ORG_REL.split('/'));
const markerFile = (root) => join(root, '.office', 'shared-org.json');
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

function cleanName(name) {
  const v = String(name ?? '').trim();
  if (!v) throw new Error('담당자 이름을 지정하세요(--name <이름>).');
  if (v.length > 30 || /[{}"\\<>\r\n\t]/.test(v)) throw new Error(`담당자 이름으로 쓸 수 없는 글자가 있습니다: ${v}`);
  return v;
}

// 문자열 값만 바꾼다(키·숫자·불리언은 그대로)
function mapStrings(value, fn) {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, fn)]));
  return value;
}

const countIn = (text, word) => (word ? text.split(word).length - 1 : 0);

// 공개 저장소에 올리면 안 되는 흔적. 비어 있으면 통과
export function sharedOrgLeaks(data, names = []) {
  const text = JSON.stringify(data);
  const leaks = [];
  for (const n of names) if (n && text.includes(n)) leaks.push(`이름 "${n}"`);
  if (/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/.test(text)) leaks.push('메일 주소');
  if (/01[016789][-\s.]?\d{3,4}[-\s.]?\d{4}/.test(text)) leaks.push('휴대폰 번호');
  if (/\d{6}-[1-4]\d{6}/.test(text)) leaks.push('주민등록번호 형태');
  if (/[A-Za-z]:\\\\Users\\\\|\/Users\/[^/"\s]+|\/home\/[^/"\s]+/.test(text)) leaks.push('사용자 폴더 경로');
  return leaks;
}

export function readSharedMarker(root) {
  try {
    const m = JSON.parse(readFileSync(markerFile(root), 'utf8'));
    return m && typeof m === 'object' && typeof m.name === 'string' ? m : null;
  } catch {
    return null;
  }
}

function readShared(program) {
  const file = sharedOrgFile(program);
  if (!existsSync(file)) throw new Error(`공유 회사 구성 파일이 없습니다: ${SHARED_ORG_REL}`);
  const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  try {
    return { text, data: JSON.parse(text) };
  } catch (err) {
    throw new Error(`공유 회사 구성 파일이 JSON 형식이 아닙니다: ${err.message}`);
  }
}

// 대표 PC: 지금 회사 구성에서 names(대표 실명 등)를 자리 표시로 바꿔 레포의 공유 파일로 쓴다
export function publishSharedOrg({ root, program, names }) {
  if (readSharedMarker(root)) throw new Error('이 PC는 공유 회사 구성을 받아 쓰는 PC라 올릴 수 없습니다(대표 PC에서 올립니다).');
  const list = [...new Set((Array.isArray(names) ? names : [names]).map(cleanName))].sort((a, b) => b.length - a.length);
  const data = exportOrg(root);
  if (!data.departments.length) throw new Error('올릴 회사 구성이 없습니다(부서 0개).');
  const before = JSON.stringify(data);
  const replaced = Object.fromEntries(list.map((n) => [n, countIn(before, n)]));
  const shared = mapStrings(data, (s) => list.reduce((acc, n) => acc.split(n).join(NAME_PLACEHOLDER), s));
  const leaks = sharedOrgLeaks(shared, list);
  if (leaks.length) throw new Error(`공개 저장소에 올리면 안 되는 내용이 남아 있어 쓰지 않았습니다: ${leaks.join(', ')}`);
  const check = checkOrgImport(shared);
  if (!check.ok) throw new Error(`회사 구성 검증에 실패해 쓰지 않았습니다: ${check.errors.join(' / ')}`);
  const file = sharedOrgFile(program);
  const text = JSON.stringify(shared, null, 2) + '\n';
  const changed = !existsSync(file) || readFileSync(file, 'utf8').replace(/^\uFEFF/, '') !== text;
  mkdirSync(dirname(file), { recursive: true });
  if (changed) writeFileAtomic(file, text);
  return { file, changed, replaced, summary: check.summary };
}

// 받는 PC: 자리 표시를 name으로 채워 회사 구성을 통째로 바꾼다.
// 표식이 없는데 이미 부서·직원이 있으면(대표 PC 등) force 없이는 덮어쓰지 않는다
export async function applySharedOrg({ root, program, name, force = false }) {
  const marker = readSharedMarker(root);
  const who = cleanName(name ?? marker?.name);
  const { text, data } = readShared(program);
  if (!marker && !force) {
    const cur = loadOrg(root);
    if (cur.departments.length || cur.roster.length) {
      throw new Error(`이 PC에는 이미 회사 구성(부서 ${cur.departments.length}개·직원 ${cur.roster.length}명)이 있습니다. 덮어쓰려면 --yes를 붙이세요.`);
    }
  }
  const filled = mapStrings(data, (s) => s.split(NAME_PLACEHOLDER).join(who));
  const { sync, summary } = await importOrg(root, filled, { mode: 'replace' });
  mkdirSync(join(root, '.office'), { recursive: true });
  writeFileAtomic(markerFile(root), JSON.stringify({ version: 1, name: who, sha256: sha256(text), appliedAt: new Date().toISOString() }, null, 2) + '\n');
  return { name: who, sync, summary };
}

// 서버 시작 때: 표식이 있는 PC만, 레포의 공유 파일이 바뀌었으면 같은 이름으로 다시 맞춘다
export async function refreshSharedOrg({ root, program }) {
  const marker = readSharedMarker(root);
  if (!marker) return { applied: false, reason: 'not-subscribed' };
  if (!existsSync(sharedOrgFile(program))) return { applied: false, reason: 'no-file' };
  const { text } = readShared(program);
  if (sha256(text) === marker.sha256) return { applied: false, reason: 'up-to-date' };
  return { applied: true, ...(await applySharedOrg({ root, program, name: marker.name })) };
}

export function sharedOrgStatus({ root, program }) {
  const exists = existsSync(sharedOrgFile(program));
  const marker = readSharedMarker(root);
  let upToDate = null;
  let summary = null;
  if (exists) {
    const { text, data } = readShared(program);
    const check = checkOrgImport(data);
    summary = check.ok ? check.summary : null;
    if (marker) upToDate = sha256(text) === marker.sha256;
  }
  const cur = loadOrg(root);
  return { exists, summary, subscribed: Boolean(marker), name: marker?.name ?? null, appliedAt: marker?.appliedAt ?? null, upToDate,
    current: { departments: cur.departments.length, roster: cur.roster.length } };
}

// 받는 PC에서 자동 맞춤을 그만둔다(회사 구성은 그대로 둔다)
export function stopSharedOrg(root) {
  const had = existsSync(markerFile(root));
  rmSync(markerFile(root), { force: true });
  return had;
}
