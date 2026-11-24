// 고정 절차: 정형 업무는 저장된 계획으로 바로 시작한다(자리 표시 채우기·쓸 수 없을 때 사유)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { latestFile, loadRecipes, recipeChoices, recipePlan } from '../lib/recipes.mjs';
import { judgeCommand } from '../lib/intent.mjs';

function workspace(t, recipes) {
  const root = mkdtempSync(join(tmpdir(), 'office-recipes-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'org'), { recursive: true });
  if (recipes !== undefined) writeFileSync(join(root, 'org', 'recipes.json'), typeof recipes === 'string' ? recipes : JSON.stringify({ version: 1, recipes }));
  return root;
}
const stage = (extra = {}) => ({ id: 's1', title: '수집', dept: 'biz', agent: 'biz-1', inputs: [], dependsOn: [], output: 'outputs/{{task}}/biz/biz-1-data.json', done: '대표 지시: "{{request}}"', ...extra });
const put = (root, rel, time) => { const file = join(root, ...rel.split('/')); mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, '{}'); utimesSync(file, time, time); };

test('절차 파일이 없거나 깨졌으면 절차가 없는 것으로 본다. 형식이 틀린 항목은 버린다', (t) => {
  assert.deepEqual(loadRecipes(workspace(t)), []);
  assert.deepEqual(loadRecipes(workspace(t, '{')), []);
  const root = workspace(t, [{ id: 'ok-one', when: '수집만', plan: { stages: [stage()] } }, { id: 'Bad Id', when: 'x', plan: { stages: [stage()] } }, { id: 'no-stages', when: 'x', plan: { stages: [] } }, { id: 'no-when', plan: { stages: [stage()] } }]);
  assert.deepEqual(recipeChoices(root), [{ id: 'ok-one', when: '수집만' }], '의도 판별에는 id와 설명만 준다');
});

test('자리 표시를 채워 계획을 만든다: 업무 id, 대표 지시 원문', (t) => {
  const root = workspace(t, [{ id: 'collect', when: '수집', plan: { goal: '자료 수집', stages: [stage()], deliverables: ['s1'] } }]);
  const { plan } = recipePlan(root, { id: 'collect', task: '2026-11-24/run-a', request: '3명만 수집해줘\n\n[저장 위치] 이 작업의 산출물은…' });
  assert.equal(plan.task, '2026-11-24/run-a');
  assert.equal(plan.stages[0].output, 'outputs/2026-11-24/run-a/biz/biz-1-data.json');
  assert.equal(plan.stages[0].done, '대표 지시: "3명만 수집해줘"', '실행기가 덧붙인 저장 위치 안내는 대표 지시가 아니다');
  assert.deepEqual(plan.publications, []);
  assert.equal(recipePlan(root, { id: 'missing', task: 't' }).plan, null);
});

test('가장 최근 파일 자리 표시: 무늬에 맞는 파일 중 가장 나중 것을 쓰고, 없으면 절차를 쓰지 않는다', (t) => {
  const root = workspace(t, [{ id: 'send', when: '발송', plan: { stages: [stage({ inputs: ['{{latest:outputs/**/care/draft.json}}'] })] } }]);
  assert.match(recipePlan(root, { id: 'send', task: 't' }).reason, /앞선 결과 파일이 없습니다/);
  put(root, 'outputs/2026-11-01/run-a/care/draft.json', new Date('2026-11-01T00:00:00Z'));
  put(root, 'outputs/2026-11-20/run-b/care/draft.json', new Date('2026-11-20T00:00:00Z'));
  put(root, 'outputs/2026-11-23/run-c/care/other.json', new Date('2026-11-23T00:00:00Z'));
  put(root, 'outputs/2026-11-23/run-c/quality/draft.json', new Date('2026-11-23T00:00:00Z'));
  assert.equal(latestFile(root, 'outputs/**/care/draft.json'), 'outputs/2026-11-20/run-b/care/draft.json');
  assert.equal(latestFile(root, '../outside/*.json'), null, '작업 공간 밖은 찾지 않는다');
  assert.deepEqual(recipePlan(root, { id: 'send', task: 't' }).plan.stages[0].inputs, ['outputs/2026-11-20/run-b/care/draft.json']);
});

test('외부 작업이 든 절차는 대표가 그 작업을 시켰을 때만, 연결 계정이 하나일 때만 쓴다', (t) => {
  const publication = { id: 'p1', action: 'mail', service: 'naverworks_mail', connection: '{{connection:naverworks}}', agent: 'biz-1', target: '', recipients: [], subject: '', content: 's1', instructions: '', files: [], attachments: [] };
  const root = workspace(t, [{ id: 'send', when: '발송', plan: { stages: [stage()], publications: [publication] } }]);
  const one = [{ id: 'w1', provider: 'naverworks', status: 'connected' }];
  assert.match(recipePlan(root, { id: 'send', task: 't', connections: one, allowedActions: [] }).reason, /시키지 않은 외부 작업/);
  assert.equal(recipePlan(root, { id: 'send', task: 't', connections: one, allowedActions: ['mail'] }).plan.publications[0].connection, 'w1');
  assert.match(recipePlan(root, { id: 'send', task: 't', connections: [], allowedActions: ['mail'] }).reason, /계정이 없습니다/);
  assert.match(recipePlan(root, { id: 'send', task: 't', connections: [...one, { id: 'w2', provider: 'naverworks', status: 'connected' }], allowedActions: ['mail'] }).reason, /여럿/);
  assert.match(recipePlan(root, { id: 'send', task: 't', connections: [{ id: 'w1', provider: 'naverworks', status: 'needs_login' }], allowedActions: ['mail'] }).reason, /없습니다/);
});

test('의도 판별: 등록된 절차 id만 인정하고, 빠른 조회·상시 실행에는 쓰지 않는다', async () => {
  const base = { kind: 'task', kindEvidence: '', externalActions: [], delegated: false, delegatedEvidence: '', standing: 'none', standingEvidence: '', durationMinutes: 0, deadline: '', intervalMinutes: 0,
    scheduleTime: '', scheduleDate: '', scheduleTimes: 0, scheduleEvidence: '', outputDir: '', outputDirEvidence: '', quick: false, quickAgent: '', quickEdit: false, quickEditFile: '', followUpRun: '' };
  const recipes = [{ id: 'care-mail-prepare', when: '상담사 메일 준비' }];
  const run = async (answer, list = recipes) => { let prompt = ''; const j = async (kind, p) => { prompt = String(p); return answer; }; const r = await judgeCommand('상담사 메일 준비해줘', { judge: j, recipes: list }); return { r, prompt }; };
  const hit = await run({ ...base, recipe: 'care-mail-prepare' });
  if (hit.r.source === 'ai') {
    assert.equal(hit.r.recipe, 'care-mail-prepare');
    assert.match(hit.prompt, /care-mail-prepare/);
    assert.equal((await run({ ...base, recipe: 'made-up' })).r.recipe, '', '목록에 없는 id는 버린다');
    assert.equal((await run({ ...base, recipe: 'care-mail-prepare' }, [])).r.recipe, '');
    assert.equal((await run({ ...base, quick: true, quickAgent: 'biz-1', recipe: 'care-mail-prepare' })).r.recipe, '');
  } else assert.ok(!hit.r.recipe, '판별을 못 하면 절차를 쓰지 않는다');
});
