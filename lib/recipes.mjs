// 고정 절차: 자주 시키는 정형 업무는 검증된 계획을 저장해 두고, 비서실장 계획 호출 없이 바로 실행한다.
// 작업 공간 org/recipes.json에 둔다(회사마다 다르다). 의도 판별이 지시에 맞는 절차 id를 고르고, 여기서 계획으로 바꾼다.
// 절차는 계획만 정한다. 외부 작업 허용·위임은 지금처럼 대표 원문 근거로만 정해지고, 절차가 허용되지 않은 외부 작업을 담고 있으면 쓰지 않는다.
//
// 형식: { version: 1, recipes: [{ id, when, plan: { goal, stages, review, deliverables, publications, gaps } }] }
// plan 안의 문자열에 쓸 수 있는 자리 표시:
//   {{task}}                업무 id
//   {{request}}             대표 지시 원문
//   {{latest:<경로 무늬>}}   작업 공간에서 무늬에 맞는 가장 최근 파일(무늬의 *는 한 폴더 이름, **는 여러 폴더). 없으면 이 절차를 쓰지 않는다
//   {{connection:<제공자>}}  연결된 그 제공자 계정이 하나일 때 그 id(예: naverworks). 없거나 여럿이면 이 절차를 쓰지 않는다
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ID = /^[a-z][a-z0-9-]{1,40}$/;

export function loadRecipes(root) {
  const file = join(root, 'org', 'recipes.json');
  if (!existsSync(file)) return [];
  let data;
  try { data = JSON.parse(readFileSync(file, 'utf8')); } catch { return []; }
  return (Array.isArray(data?.recipes) ? data.recipes : []).filter((r) => r && ID.test(r.id) && typeof r.when === 'string' && r.when.trim()
    && r.plan && typeof r.plan === 'object' && Array.isArray(r.plan.stages) && r.plan.stages.length);
}

// 의도 판별에 보여 줄 목록(계획 내용은 싣지 않는다)
export const recipeChoices = (root) => loadRecipes(root).map((r) => ({ id: r.id, when: r.when.slice(0, 300) }));

const escapeRe = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
// 무늬에 맞는 가장 최근 파일(작업 공간 기준 상대 경로). 숨김 폴더와 node_modules는 보지 않는다
export function latestFile(root, pattern) {
  const parts = String(pattern).replace(/\\/g, '/').split('/').filter(Boolean);
  if (!parts.length || parts.some((p) => p === '..')) return null;
  const fixed = [];
  while (parts.length > 1 && !parts[0].includes('*')) fixed.push(parts.shift());
  const re = new RegExp(`^${parts.map((p) => (p === '**' ? '(?:[^/]+/)*' : `${escapeRe(p).replace(/\*/g, '[^/]*')}/`)).join('').replace(/\/$/, '')}$`);
  let best = null, seen = 0;
  const walk = (dir, rel, depth) => {
    if (depth > 8 || seen > 20000) return;
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(dir, entry.name), next, depth + 1);
      else if (entry.isFile() && re.test(next)) {
        seen++;
        let mtime = 0; try { mtime = statSync(join(dir, entry.name)).mtimeMs; } catch { continue; }
        if (!best || mtime > best.mtime) best = { path: [...fixed, next].join('/'), mtime };
      }
    }
  };
  walk(join(root, ...fixed), '', 0);
  return best?.path || null;
}

// 절차 id → 계획. 쓸 수 없으면 { plan: null, reason }
export function recipePlan(root, { id, task, request = '', connections = [], allowedActions = [] } = {}) {
  const recipe = loadRecipes(root).find((r) => r.id === id);
  if (!recipe) return { plan: null, reason: '등록된 고정 절차가 아닙니다.' };
  let reason = '';
  const fill = (text) => text.replace(/\{\{(task|request|latest:[^}]+|connection:[a-z_]+)\}\}/g, (_, key) => {
    if (key === 'task') return task;
    if (key === 'request') return String(request).replace(/\[저장 위치\][^\n]*/g, '').trim();
    if (key.startsWith('latest:')) { const found = latestFile(root, key.slice(7).trim()); if (!found) reason ||= `필요한 앞선 결과 파일이 없습니다(${key.slice(7).trim()}).`; return found || ''; }
    const provider = key.slice(11);
    const linked = connections.filter((c) => c.provider === provider && c.status === 'connected');
    if (linked.length !== 1) reason ||= `연결된 ${provider} 계정이 ${linked.length ? '여럿' : '없'}습니다.`;
    return linked.length === 1 ? linked[0].id : '';
  });
  const deep = (value) => typeof value === 'string' ? fill(value) : Array.isArray(value) ? value.map(deep) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deep(v)])) : value;
  const body = deep(recipe.plan);
  if (reason) return { plan: null, reason };
  const publications = Array.isArray(body.publications) ? body.publications : [];
  if (publications.some((p) => !allowedActions.includes(p.action))) return { plan: null, reason: '대표가 이번 지시에서 시키지 않은 외부 작업이 들어 있는 절차입니다.' };
  return { recipe, plan: { version: 1, task, goal: String(body.goal || recipe.id), stages: body.stages, review: body.review || { by: 'chief', criteria: '대표 요청 충족' },
    deliverables: Array.isArray(body.deliverables) ? body.deliverables : [], gaps: [], publications } };
}
