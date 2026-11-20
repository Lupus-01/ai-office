// 공유 회사 구성: 대표가 쓰는 회사 구성(부서·직원·지침·회사 규칙)을 레포의 shared/company-org.json으로 배포한다.
// - 대표 PC(publish): 현재 회사 구성을 내보내며 대표 실명을 자리 표시({{담당자 이름}})로 바꾼다. 공개 저장소라 개인 흔적이 남으면 쓰지 않는다.
// - 받는 PC(apply): 자리 표시를 그 PC 사용자의 이름으로 채워 회사 구성을 통째로 바꾸고, 작업 공간 .office/shared-org.json에 표식을 남긴다.
//   바꾸기 전 구성은 .office/shared-org-backups/에 남긴다. 회사 설정(비서실장 모델·예산 등)은 처음 가져올 때만 공유 파일 값을 쓴다.
// - 서버 시작(refresh): 표식이 있는 PC만, 레포의 공유 파일이 바뀌었으면 같은 이름으로 다시 맞춘다. 표식이 없는 PC(대표 PC)는 건드리지 않는다.
// - 보관함 자료(SHARED_VAULT_DIRS): 상담사 개인정보가 없는 양식·도구만 레포 shared/보관함/에 함께 싣고, 받는 PC의 작업 공간 보관함/에 같은 경로로 넣는다.
//   워드·PPT·엑셀은 올릴 때 문서 정보(작성자·수정자·회사명)를 지운다. 예시(실제 상담사 프로필)·받은 파일·지식창고 자료는 싣지 않는다.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { checkOrgImport, exportOrg, importOrg, loadOrg, writeFileAtomic } from './org.mjs';

export const SHARED_ORG_REL = 'shared/company-org.json';
export const NAME_PLACEHOLDER = '{{담당자 이름}}';
export const SHARED_FILES_REL = 'shared/보관함';
export const SHARED_VAULT_DIRS = Object.freeze(['프로필제작/양식']);
const BACKUP_KEEP = 10;

export const sharedOrgFile = (program) => join(program, ...SHARED_ORG_REL.split('/'));
const markerFile = (root) => join(root, '.office', 'shared-org.json');
export const sharedOrgBackupDir = (root) => join(root, '.office', 'shared-org-backups');
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

// 모든 문자열 값마다 [위치, 값]을 돌려준다. 위치는 사람이 읽는 이름(부서·직원 이름 + 항목)으로
function* walk(value, where) {
  if (typeof value === 'string') yield [where, value];
  else if (Array.isArray(value)) for (const v of value) yield* walk(v, where);
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) yield* walk(v, `${where} ${k}`);
}
function* strings(data) {
  yield* walk(data.company, '회사 공통 규칙');
  for (const d of data.departments || []) yield* walk(d, `부서 ${d?.name || d?.id}`);
  for (const p of data.roster || []) yield* walk(p, `직원 ${p?.name || p?.id}(${p?.id})`);
  yield* walk(data.settings, '회사 설정');
}

const countIn = (text, word) => (word ? text.split(word).length - 1 : 0);
const LEAKS = [
  ['메일 주소', /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/],
  ['휴대폰 번호', /(?<!\d)01[016789][-\s.]?\d{3,4}[-\s.]?\d{4}(?!\d)/],
  ['주민등록번호 형태', /(?<!\d)\d{6}-[1-4]\d{6}(?!\d)/],
  ['사용자 폴더 경로', /[A-Za-z]:\\Users\\|\/Users\/[^/"\s]+|\/home\/[^/"\s]+/],
];

// 공개 저장소에 올리면 안 되는 흔적. 비어 있으면 통과. 항목마다 어디서 찾았는지 붙인다
export function sharedOrgLeaks(data, names = []) {
  const leaks = [];
  for (const [where, text] of strings(data)) {
    for (const n of names) if (n && text.includes(n)) leaks.push(`이름 "${n}"(${where})`);
    for (const [label, re] of LEAKS) if (re.test(text)) leaks.push(`${label}(${where})`);
  }
  return [...new Set(leaks)];
}

// 이전 공유 파일과 새 내용의 차이를 사람이 읽는 줄로(부서·직원 추가·삭제, 바뀐 항목)
export function describeOrgChanges(prev, next) {
  if (!prev) return ['처음 올리는 공유 구성입니다.'];
  const out = [];
  const byId = (list) => new Map((list || []).map((x) => [x.id, x]));
  const diff = (label, a, b) => {
    const A = byId(a);
    const B = byId(b);
    for (const [id, x] of B) {
      if (!A.has(id)) { out.push(`${label} 추가: ${x.name || id}`); continue; }
      const keys = [...new Set([...Object.keys(A.get(id)), ...Object.keys(x)])].filter((k) => JSON.stringify(A.get(id)[k]) !== JSON.stringify(x[k]));
      if (keys.length) out.push(`${label} 바뀜: ${x.name || id} (${keys.join(', ')})`);
    }
    for (const [id, x] of A) if (!B.has(id)) out.push(`${label} 삭제: ${x.name || id}`);
  };
  diff('부서', prev.departments, next.departments);
  diff('직원', prev.roster, next.roster);
  if ((prev.company || '') !== (next.company || '')) out.push('회사 공통 규칙 바뀜');
  if (JSON.stringify(prev.settings ?? null) !== JSON.stringify(next.settings ?? null)) out.push('회사 설정 바뀜(처음 가져오는 PC에만 적용)');
  return out.length ? out : ['바뀐 내용 없음'];
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

// ── 보관함 자료(양식·도구) ───────────────────────────────────────────────
export const sharedFilesDir = (program) => join(program, ...SHARED_FILES_REL.split('/'));
const vaultDir = (root) => join(root, '보관함');
const fromRel = (base, rel) => join(base, ...rel.split('/'));
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
// 레포에서 공유 대상 경로인지(배포할 때 커밋하지 않은 프로그램 변경으로 보지 않는다)
export const isSharedPath = (rel) => rel === SHARED_ORG_REL || rel.startsWith(`${SHARED_FILES_REL}/`);

// 폴더 아래 파일의 상대 경로(/ 구분, 정렬). 폴더가 없으면 빈 목록
function listFiles(dir) {
  const out = [];
  const visit = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) visit(p);
      else if (e.isFile()) out.push(relative(dir, p).split(sep).join('/'));
    }
  };
  if (existsSync(dir)) visit(dir);
  return out.sort();
}

// 레포에 실린 보관함 자료 전체의 지문(없으면 null). 받는 PC 표식에 남겨 바뀌었는지 본다
export function sharedFilesSha(program) {
  const dir = sharedFilesDir(program);
  const files = listFiles(dir);
  if (!files.length) return null;
  const h = createHash('sha256');
  for (const f of files) h.update(`${f}\0${sha256(readFileSync(fromRel(dir, f)))}\n`);
  return h.digest('hex');
}

const OFFICE_EXT = /\.(docx|pptx|xlsx)$/i;
const TEXT_EXT = /\.(md|txt|json|csv|cjs|mjs|js|html?|xml)$/i;
// 문서 정보에 남는 사람·회사 이름(작성자·마지막 수정자·회사·관리자). 내용은 그대로 두고 이 값만 비운다
const OFFICE_META = { 'docProps/core.xml': ['dc:creator', 'cp:lastModifiedBy'], 'docProps/app.xml': ['Company', 'Manager'] };
const officeZip = async (buffer) => (await import('jszip')).default.loadAsync(buffer);
async function stripOfficeMeta(buffer) {
  const zip = await officeZip(buffer);
  for (const [name, tags] of Object.entries(OFFICE_META)) {
    const entry = zip.file(name);
    if (!entry) continue;
    let xml = await entry.async('string');
    for (const tag of tags) xml = xml.replace(new RegExp(`<${tag}(\\s[^>]*)?>[^<]*</${tag}>`, 'g'), `<${tag}$1></${tag}>`);
    zip.file(name, xml, { date: entry.date });
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
// 흔적 검사용 글자: 문서는 안의 XML 글자 전체(태그를 빼서 나뉜 글자도 이어지게), 글 파일은 그대로, 그 밖(그림 등)은 빈 글자
async function textOf(file, buffer) {
  if (OFFICE_EXT.test(file)) {
    const zip = await officeZip(buffer);
    const parts = [];
    for (const name of Object.keys(zip.files).filter((n) => /\.xml$/i.test(n))) parts.push((await zip.file(name).async('string')).replace(/<[^>]+>/g, ''));
    return parts.join('\n');
  }
  return TEXT_EXT.test(file) ? buffer.toString('utf8') : '';
}

// 대표 PC: 작업 공간 보관함/의 공유 대상 폴더를 레포 shared/보관함/에 맞춘다(바뀐 파일만 쓰고, 원본에서 없어진 파일은 지운다).
// 원본 폴더가 없는 PC에서는 레포에 실린 것을 그대로 둔다. 이름·연락처 같은 흔적이 있으면 아무것도 쓰지 않는다
export async function publishSharedFiles({ root, program, names = [], dryRun = false }) {
  const list = [...new Set((Array.isArray(names) ? names : [names]).map((n) => String(n ?? '').trim()).filter(Boolean))];
  const shared = sharedFilesDir(program);
  const result = { dryRun, total: 0, added: [], changed: [], removed: [], kept: [] };
  const leaks = [];
  const writes = [];
  for (const dir of SHARED_VAULT_DIRS) {
    const src = fromRel(vaultDir(root), dir);
    const dst = fromRel(shared, dir);
    if (!existsSync(src)) { result.kept.push(dir); result.total += listFiles(dst).length; continue; }
    const files = listFiles(src);
    for (const f of files) {
      const rel = `${dir}/${f}`;
      let data = readFileSync(fromRel(src, f));
      if (OFFICE_EXT.test(f)) data = await stripOfficeMeta(data);
      const text = await textOf(f, data);
      for (const n of list) if (text.includes(n)) leaks.push(`이름 "${n}"(보관함/${rel})`);
      for (const [label, re] of LEAKS) if (re.test(text)) leaks.push(`${label}(보관함/${rel})`);
      const target = fromRel(dst, f);
      if (!existsSync(target)) result.added.push(rel);
      else if (!readFileSync(target).equals(data)) result.changed.push(rel);
      else continue;
      writes.push([target, data]);
    }
    for (const f of listFiles(dst)) if (!files.includes(f)) result.removed.push(`${dir}/${f}`);
    result.total += files.length;
  }
  if (leaks.length) throw new Error(`공개 저장소에 올리면 안 되는 내용이 보관함 자료에 있어 쓰지 않았습니다: ${[...new Set(leaks)].join(', ')}`);
  result.changedAny = Boolean(result.added.length || result.changed.length || result.removed.length);
  if (!dryRun) {
    for (const [target, data] of writes) { mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, data); }
    for (const rel of result.removed) rmSync(fromRel(shared, rel), { force: true });
  }
  return result;
}

// 받는 PC: 레포의 보관함 자료를 작업 공간 보관함/에 같은 경로로 넣는다(이 PC에서 고친 양식도 덮어쓴다).
// 내용이 다른 기존 파일은 .office/shared-org-backups/<시각>-보관함/에 남긴다. 레포에 없는 이 PC의 파일은 지우지 않는다
export function syncSharedFiles({ root, program }) {
  const shared = sharedFilesDir(program);
  const files = listFiles(shared);
  const copied = [];
  let backup = null;
  for (const rel of files) {
    const data = readFileSync(fromRel(shared, rel));
    const target = fromRel(vaultDir(root), rel);
    if (existsSync(target)) {
      const cur = readFileSync(target);
      if (cur.equals(data)) continue;
      backup ||= join(sharedOrgBackupDir(root), `${stamp()}-보관함`);
      const keep = fromRel(backup, rel);
      mkdirSync(dirname(keep), { recursive: true });
      writeFileSync(keep, cur);
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
    copied.push(rel);
  }
  if (backup) {
    const dir = sharedOrgBackupDir(root);
    for (const old of readdirSync(dir).filter((f) => f.endsWith('-보관함')).sort().slice(0, -BACKUP_KEEP)) rmSync(join(dir, old), { recursive: true, force: true });
  }
  return { total: files.length, copied, backup, sha: sharedFilesSha(program) };
}

const writeMarker = (root, marker) => {
  mkdirSync(join(root, '.office'), { recursive: true });
  writeFileAtomic(markerFile(root), JSON.stringify(marker, null, 2) + '\n');
};

// 대표 PC: 지금 회사 구성에서 names(대표 실명 등)를 자리 표시로 바꿔 레포의 공유 파일로 쓴다.
// dryRun이면 쓰지 않고 무엇이 바뀌는지만 돌려준다
export function publishSharedOrg({ root, program, names, dryRun = false }) {
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
  const prevText = existsSync(file) ? readFileSync(file, 'utf8').replace(/^\uFEFF/, '') : null;
  let prev = null;
  try { prev = prevText ? JSON.parse(prevText) : null; } catch { prev = null; }
  const changed = prevText !== text;
  if (changed && !dryRun) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileAtomic(file, text);
  }
  return {
    file, changed, dryRun, replaced, summary: check.summary,
    placeholders: countIn(text, NAME_PLACEHOLDER),
    previousPlaceholders: prevText === null ? null : countIn(prevText, NAME_PLACEHOLDER),
    changes: changed ? describeOrgChanges(prev, shared) : ['바뀐 내용 없음'],
  };
}

// 바꾸기 전 구성을 남긴다(부서·직원이 있을 때만). 최근 BACKUP_KEEP개만 둔다
function backupOrg(root) {
  const cur = exportOrg(root);
  if (!cur.departments.length && !cur.roster.length) return null;
  const dir = sharedOrgBackupDir(root);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileAtomic(file, JSON.stringify(cur, null, 2) + '\n');
  const old = readdirSync(dir).filter((f) => f.endsWith('.json')).sort().slice(0, -BACKUP_KEEP);
  for (const f of old) rmSync(join(dir, f), { force: true });
  return file;
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
  // 이미 받아 쓰는 PC는 그 PC의 회사 설정(상단 모델·예산 선택)을 그대로 둔다
  if (marker) delete filled.settings;
  const backup = backupOrg(root);
  const { sync, summary } = await importOrg(root, filled, { mode: 'replace' });
  const files = syncSharedFiles({ root, program });
  writeMarker(root, { version: 1, name: who, sha256: sha256(text), filesSha256: files.sha, appliedAt: new Date().toISOString() });
  return { name: who, sync, summary, backup, files };
}

// 서버 시작 때: 표식이 있는 PC만, 레포의 공유 파일이 바뀌었으면 같은 이름으로 다시 맞춘다.
// 회사 구성은 그대로이고 보관함 자료만 바뀌었으면 자료만 넣는다(이 PC의 회사 구성을 다시 덮어쓰지 않음)
export async function refreshSharedOrg({ root, program }) {
  const marker = readSharedMarker(root);
  if (!marker) return { applied: false, reason: 'not-subscribed' };
  if (!existsSync(sharedOrgFile(program))) return { applied: false, reason: 'no-file' };
  const { text } = readShared(program);
  if (sha256(text) !== marker.sha256) return { applied: true, ...(await applySharedOrg({ root, program, name: marker.name })) };
  if ((marker.filesSha256 ?? null) === sharedFilesSha(program)) return { applied: false, reason: 'up-to-date' };
  const files = syncSharedFiles({ root, program });
  writeMarker(root, { ...marker, filesSha256: files.sha, appliedAt: new Date().toISOString() });
  return { applied: true, filesOnly: true, name: marker.name, files };
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
    if (marker) upToDate = sha256(text) === marker.sha256 && (marker.filesSha256 ?? null) === sharedFilesSha(program);
  }
  const cur = loadOrg(root);
  return { exists, summary, subscribed: Boolean(marker), name: marker?.name ?? null, appliedAt: marker?.appliedAt ?? null, upToDate,
    current: { departments: cur.departments.length, roster: cur.roster.length },
    files: { total: listFiles(sharedFilesDir(program)).length, dirs: [...SHARED_VAULT_DIRS] } };
}

// 받는 PC에서 자동 맞춤을 그만둔다(회사 구성은 그대로 둔다)
export function stopSharedOrg(root) {
  const had = existsSync(markerFile(root));
  rmSync(markerFile(root), { force: true });
  return had;
}
