import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSchedules, nextDailyTime, scheduleRequest, videoPostPolicy } from '../lib/schedules.mjs';

test('한국 시각 매일 예약은 오전/오후·분을 읽고 모호하거나 잘못된 시각은 실행하지 않는다', () => {
  assert.deepEqual(scheduleRequest('매일 오전 11시에 여행 숏츠를 카페에 2~3개씩 올려줘'), { time: '11:00' });
  assert.deepEqual(scheduleRequest('매일 오후 12시 30분에 보고해 줘'), { time: '12:30' });
  assert.deepEqual(scheduleRequest('매일 오전 12시에 보고해 줘'), { time: '00:00' });
  assert.deepEqual(scheduleRequest('매일 23:15에 보고해 줘'), { time: '23:15' });
  assert.equal(scheduleRequest('매일 오전 11시에 할 수 있어?'), null);
  assert.equal(scheduleRequest('지금 보고서를 써줘'), null);
  assert.throws(() => scheduleRequest('매일 카페에 글을 올려줘'), /시각/);
  assert.throws(() => scheduleRequest('매일 오후 13시에 올려줘'), /시각/);
  assert.throws(() => scheduleRequest('매일 24:00에 보고해'), /시각/);
  assert.deepEqual(videoPostPolicy('여행 숏츠를 카페에 2~3개씩 게시'), { uniqueYoutube: true, minPosts: 2, maxPosts: 3 });
  assert.deepEqual(videoPostPolicy('유튜브 영상을 하루 1개 카페에 게시'), { uniqueYoutube: true, minPosts: 1, maxPosts: 1 });
  assert.throws(() => videoPostPolicy('카페에 유튜브를 3~2개 게시'), /게시 수/);
  assert.equal(new Date(nextDailyTime('11:00', Date.parse('2026-10-30T01:59:59Z'))).toISOString(), '2026-10-30T02:00:00.000Z');
  assert.equal(new Date(nextDailyTime('00:00', Date.parse('2026-12-31T15:00:00Z'))).toISOString(), '2027-01-01T15:00:00.000Z');
});

test('영상 글과 영상이 아닌 글을 섞은 예약은 개수 앞 문구로 영상 수와 그 밖의 글 수를 나눈다', () => {
  assert.deepEqual(videoPostPolicy('매일 오전 9시에 반려동물 유튜브 숏츠 2개와 애견 동반 핫플 1개를 카페에 올려줘'), { uniqueYoutube: true, minPosts: 2, maxPosts: 2, infoPosts: 1 });
  assert.deepEqual(videoPostPolicy('매일 9시에 카페에 애견 카페 소개 1개, 유튜브 숏츠 2~3개 올려줘'), { uniqueYoutube: true, minPosts: 2, maxPosts: 3, infoPosts: 1 });
  assert.deepEqual(videoPostPolicy('카페 글 10개 중 유튜브 숏츠 7개, 핫플레이스 3개로 게시'), { uniqueYoutube: true, minPosts: 7, maxPosts: 7, infoPosts: 3 });
  // 개수 앞에 영상 단어가 없으면 예전처럼 영상 글 수로 본다
  assert.deepEqual(videoPostPolicy('매일 오전 9시에 카페에 3개씩 고양이 유튜브 숏츠 소개 글을 올려줘'), { uniqueYoutube: true, minPosts: 3, maxPosts: 3 });
  assert.throws(() => videoPostPolicy('유튜브 숏츠 2개와 핫플 30개를 카페에 게시'), /영상이 아닌 글 수/);
});

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'office-schedules-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  let stamp = Date.parse('2026-10-30T01:59:00Z'); const history = [], started = [];
  const options = { root, now: () => stamp, runs: () => history,
    start: (request) => { started.push(request); const id = `run-${started.length}`; const run = { id, rootId: id, schedule: request.schedule, status: 'running', task: `2026-10-30/${id}` }; history.push(run); return run; } };
  return { root, options, history, started, set: (value) => { stamp = Date.parse(value); } };
}

test('11시 정시 실행·동일 날짜 재시작 방지·답변 대기 중 겹침 방지·다음 날 재개', async (t) => {
  const f = await fixture(t); let store = createSchedules(f.options);
  const item = store.add({ time: '11:00', prompt: '주제에 맞는 유튜브 숏츠를 카페에 2~3개씩 게시해 줘' });
  store.tick(); assert.equal(f.started.length, 0);
  f.set('2026-10-30T02:00:00Z'); store.tick(); store.tick(); assert.equal(f.started.length, 1);
  assert.equal(f.started[0].continuous, false); assert.equal(f.started[0].schedule.maxPosts, 3);
  store = createSchedules(f.options); store.tick(); assert.equal(f.started.length, 1);
  f.history[0].status = 'done'; f.history[0].needsReply = true;
  f.set('2026-10-31T02:00:00Z'); store.tick(); assert.equal(f.started.length, 1);
  assert.match(store.list()[0].lastSkipped.reason, /답변/);
  f.history[0].needsReply = false;
  f.set('2026-11-01T02:00:00Z'); store.tick(); assert.equal(f.started.length, 2);
  assert.equal(store.list()[0].lastSlot, '2026-11-01');
  store.update(item.id, { enabled: false });
  f.set('2026-11-02T02:00:00Z'); store.tick(); assert.equal(f.started.length, 2);
});

test('앱 종료·절전으로 놓친 예약은 몰아 실행하지 않고 수정·재개·삭제는 미래 실행만 바꾼다', async (t) => {
  const f = await fixture(t); let store = createSchedules(f.options);
  const item = store.add({ time: '11:00', prompt: '시장 소식을 조사해 줘' });
  f.set('2026-11-03T05:00:00Z'); store = createSchedules(f.options); store.tick();
  assert.equal(f.started.length, 0); assert.equal(store.list()[0].nextAt, '2026-11-04T02:00:00.000Z');
  store.update(item.id, { time: '15:00', enabled: false });
  store.update(item.id, { enabled: true });
  assert.equal(store.list()[0].nextAt, '2026-11-03T06:00:00.000Z');
  f.set('2026-11-03T06:02:00Z'); store.tick(); assert.equal(f.started.length, 0);
  assert.equal(store.list()[0].nextAt, '2026-11-04T06:00:00.000Z');
  store.remove(item.id); assert.equal(store.list().length, 0);
  assert.equal(JSON.parse(readFileSync(join(f.root, '.office/schedules.json'))).items.length, 0);
});

test('시작 오류도 날짜별로 기록하고 실패한 예약을 같은 날 무한 재시도하지 않는다', async (t) => {
  const f = await fixture(t); let calls = 0;
  const store = createSchedules({ ...f.options, start: () => { calls++; throw new Error('fixture unavailable'); } });
  store.add({ time: '11:00', prompt: '시장 소식을 조사해 줘' });
  f.set('2026-10-30T02:00:00Z'); store.tick(); store.tick();
  assert.equal(calls, 1); assert.equal(store.list()[0].lastRun.status, 'failed');
  assert.match(store.list()[0].lastRun.summary, /unavailable/);
});

test('1회·N회 예약 문장: 날짜·횟수를 읽고 업무 내용 속 시각은 예약으로 보지 않는다', () => {
  const now = Date.parse('2026-11-03T19:30:00+09:00');
  assert.deepEqual(scheduleRequest('내일 오전 10시에 꼬리별 관측소에 게시글 2개 올려줘', now), { time: '10:00', startDate: '2026-11-04', times: 1 });
  assert.deepEqual(scheduleRequest('모레 오후 3시 반에 정리해 줘', now), { time: '15:30', startDate: '2026-11-05', times: 1 });
  assert.deepEqual(scheduleRequest('11월 5일 오후 2시 30분에 보고해 줘', now), { time: '14:30', startDate: '2026-11-05', times: 1 });
  assert.deepEqual(scheduleRequest('2026-12-01 09:00에 메일 보내줘', now), { time: '09:00', startDate: '2026-12-01', times: 1 });
  assert.deepEqual(scheduleRequest('내일부터 3일간 매일 오전 10시에 글 올려줘', now), { time: '10:00', startDate: '2026-11-04', times: 3 });
  assert.deepEqual(scheduleRequest('내일부터 3일간 오전 10시에 글 올려줘', now), { time: '10:00', startDate: '2026-11-04', times: 3 });
  assert.deepEqual(scheduleRequest('매일 오전 9시에 5회 보고해 줘', now), { time: '09:00', times: 5 });
  assert.equal(scheduleRequest('내일 오전 10시에 있는 회의 자료를 준비해 줘', now), null);
  assert.equal(scheduleRequest('내일 10시 회의 자료 준비해 줘', now), null);
  assert.equal(scheduleRequest('내일 오전 10시에 할 수 있어?', now), null);
  assert.throws(() => scheduleRequest('내일 오후 13시에 올려줘', now), /시각/);
  assert.throws(() => scheduleRequest('11월 31일 9시에 올려줘', now), /날짜/);
  assert.throws(() => scheduleRequest('매일 9시에 400회 올려줘', now), /횟수/);
});

test('1회 예약은 지정 시각에 한 번만 실행하고 끝난다. 지난 시각·끝난 예약 다시 켜기는 거부한다', async (t) => {
  const f = await fixture(t); const store = createSchedules(f.options); // 지금: 10월 30일 10:59(한국)
  assert.throws(() => store.add({ time: '10:00', startDate: '2026-10-30', times: 1, prompt: '지난 시각 업무' }), /이미 지났/);
  assert.throws(() => store.add({ time: '10:00', startDate: '2026-10-29', prompt: '지난 날짜 업무' }), /지났/);
  assert.throws(() => store.add({ time: '10:00', times: 0.5, prompt: '잘못된 횟수' }), /횟수/);
  const item = store.add({ prompt: '내일 오전 10시에 카페에 게시글 2개 올려줘' });
  assert.deepEqual([item.time, item.startDate, item.times, item.untilDate, item.nextAt], ['10:00', '2026-10-31', 1, '2026-10-31', '2026-10-31T01:00:00.000Z']);
  f.set('2026-10-30T02:00:00Z'); store.tick(); assert.equal(f.started.length, 0, '오늘 같은 시각에는 실행하지 않는다');
  f.set('2026-10-31T01:00:00Z'); store.tick(); store.tick();
  assert.equal(f.started.length, 1); assert.match(f.started[0].prompt, /예약으로 이미 처리했으니 지금 바로/);
  let saved = store.list()[0]; assert.deepEqual([saved.enabled, saved.completed], [false, true]);
  f.history[0].status = 'done';
  f.set('2026-11-01T01:00:00Z'); store.tick(); assert.equal(f.started.length, 1, '다음 날 다시 실행하지 않는다');
  assert.equal(store.list()[0].lastRun.status, 'done');
  assert.throws(() => store.update(item.id, { enabled: true }), /끝난 예약/);
  // 날짜를 바꿔 저장하면 다시 켜진다
  saved = store.update(item.id, { startDate: '2026-11-02' });
  assert.deepEqual([saved.enabled, saved.completed, saved.nextAt], [true, false, '2026-11-02T01:00:00.000Z']);
  // 같은 지시·시각이라도 끝난 예약과는 겹치지 않는다
  store.update(item.id, { enabled: false });
  assert.throws(() => store.add({ prompt: '내일 오전 10시에 카페에 게시글 2개 올려줘' }), /이미 있습니다/);
});

test('N회 예약은 시작일부터 N일 동안 실행하고 놓친 날도 한 회로 센다', async (t) => {
  const f = await fixture(t); let store = createSchedules(f.options);
  store.add({ prompt: '내일부터 3일간 매일 오전 11시에 소식을 정리해 줘' });
  assert.deepEqual([store.list()[0].startDate, store.list()[0].untilDate], ['2026-10-31', '2026-11-02']);
  f.set('2026-10-31T02:00:00Z'); store.tick(); assert.equal(f.started.length, 1);
  f.history[0].status = 'done';
  // 11월 1일은 앱이 꺼져 있었다 → 다시 켤 때 건너뛰고, 마지막 날(11월 2일)만 실행한다
  f.set('2026-11-01T05:00:00Z'); store = createSchedules(f.options); store.tick();
  assert.equal(f.started.length, 1); assert.equal(store.list()[0].nextAt, '2026-11-02T02:00:00.000Z');
  f.set('2026-11-02T02:00:00Z'); store.tick(); assert.equal(f.started.length, 2);
  assert.equal(store.list()[0].completed, true);
  f.set('2026-11-03T02:00:00Z'); store.tick(); assert.equal(f.started.length, 2);
  // 1회 예약 시각에 앱이 꺼져 있었으면 다음 날로 미루지 않고 끝낸다
  const once = store.add({ time: '12:00', times: 1, prompt: '정오에 한 번 보고해 줘' });
  f.set('2026-11-03T05:00:00Z'); store = createSchedules(f.options); store.tick();
  const missed = store.list().find((item) => item.id === once.id);
  assert.deepEqual([missed.completed, f.started.length], [true, 2]); assert.match(missed.lastSkipped.reason, /건너뛰었/);
});

test('일시중지 후 다시 켜기는 회차를 새로 세지 않고 남은 회차만 이어 간다', async (t) => {
  const f = await fixture(t); const store = createSchedules(f.options);
  const item = store.add({ time: '11:00', times: 2, prompt: '두 번 보고해 줘' });
  assert.equal(item.untilDate, '2026-10-31');
  store.update(item.id, { enabled: false });
  f.set('2026-10-30T02:00:00Z'); store.tick(); assert.equal(f.started.length, 0);
  // 다시 켜도 회차를 새로 세지 않는다: 일시중지 중 지난 10월 30일은 지나갔고 마지막 날(10월 31일)만 남는다
  f.set('2026-10-30T03:00:00Z'); const back = store.update(item.id, { enabled: true });
  assert.deepEqual([back.nextAt, back.untilDate], ['2026-10-31T02:00:00.000Z', '2026-10-31']);
});

test('요일 반복 예약 문장: "매주 금요일 오후 1시에"·여러 요일·범위를 읽고 요일이 아닌 말은 예약으로 보지 않는다', () => {
  const now = Date.parse('2026-11-16T14:00:00+09:00'); // 월요일
  assert.deepEqual(scheduleRequest('매주 금요일 오후 1시에 상담사 데이터를 갱신해줘', now), { time: '13:00', weekdays: [5] });
  assert.deepEqual(scheduleRequest('매주 월·수·금 오전 9시에 보고해 줘', now), { time: '09:00', weekdays: [1, 3, 5] });
  assert.deepEqual(scheduleRequest('매주 월요일과 목요일 18:30에 정리해 줘', now), { time: '18:30', weekdays: [1, 4] });
  assert.deepEqual(scheduleRequest('매주 월~금 오전 8시에 요약해 줘', now), { time: '08:00', weekdays: [1, 2, 3, 4, 5] });
  assert.deepEqual(scheduleRequest('매주 일요일마다 오후 9시에 정리해 줘', now), { time: '21:00', weekdays: [0] });
  assert.deepEqual(scheduleRequest('11월 20일부터 매주 금요일 오후 1시에 보고해', now), { time: '13:00', weekdays: [5], startDate: '2026-11-20' });
  assert.equal(scheduleRequest('매주 목표 점검 자료를 만들어 줘', now), null);
  assert.throws(() => scheduleRequest('매주 금요일에 카페 글 올려줘', now), /시각/);
  assert.throws(() => scheduleRequest('매주 금요일 오후 1시에 5회 반복 실행해 줘', now), /횟수/);
  // 요일 뒤 "에"·"아침·저녁", "부터 … 까지" 범위
  assert.deepEqual(scheduleRequest('매주 금요일 아침 9시에 주간 보고서 정리해줘', now), { time: '09:00', weekdays: [5] });
  assert.deepEqual(scheduleRequest('매주 금요일에 오후 1시 보고서 정리해줘', now), { time: '13:00', weekdays: [5] });
  assert.deepEqual(scheduleRequest('매주 금요일마다 저녁 7시에 정리해 줘', now), { time: '19:00', weekdays: [5] });
  assert.deepEqual(scheduleRequest('매주 월요일부터 금요일까지 9시에 뉴스 정리해줘', now), { time: '09:00', weekdays: [1, 2, 3, 4, 5] });
  assert.throws(() => scheduleRequest('매주 일요일 밤 12시에 백업해 줘', now), /자정/);
  // 요일이 업무 내용일 뿐이면 예약이 아니고 오류도 내지 않는다(판별 AI가 실패해 규칙으로 판별할 때 바로 실행되던 업무)
  assert.equal(scheduleRequest('매주 금요일 보고서 양식으로 시장 동향을 정리해줘', now), null);
  assert.equal(scheduleRequest('매주 금요일 오후 1시에 있는 팀 회의 안건을 정리해줘', now), null);
  assert.equal(scheduleRequest('매주 금요일 일정 정리해줘', now), null);
  assert.deepEqual(scheduleRequest('매주 월요일 회의록을 정리해서 내일 오전 10시에 보내줘', now), { time: '10:00', startDate: '2026-11-17', times: 1 });
  // 매일·1회 예약도 "아침·저녁" 시각을 읽는다
  assert.deepEqual(scheduleRequest('매일 아침 9시에 뉴스 정리해줘', now), { time: '09:00' });
  assert.deepEqual(scheduleRequest('내일 저녁 7시에 카페에 글 올려줘', now), { time: '19:00', startDate: '2026-11-17', times: 1 });
});

test('요일 반복 예약은 그 요일에만 실행하고 다음 같은 요일로 넘어간다. 횟수와 함께 쓰면 거부한다', async (t) => {
  const f = await fixture(t); const store = createSchedules(f.options); // 지금: 2026-10-30(금) 10:59(한국)
  const friday = store.add({ prompt: '매주 금요일 오후 1시에 상담사 데이터를 갱신해줘' });
  assert.deepEqual([friday.time, friday.weekdays, friday.times, friday.untilDate, friday.nextAt], ['13:00', [5], null, null, '2026-10-30T04:00:00.000Z']);
  const monday = store.add({ time: '09:00', weekdays: [1], prompt: '주간 보고' });
  assert.equal(monday.nextAt, '2026-11-02T00:00:00.000Z');
  assert.throws(() => store.add({ time: '09:00', weekdays: [1], times: 3, prompt: '횟수와 요일' }), /횟수/);
  assert.throws(() => store.add({ time: '09:00', weekdays: [7], prompt: '없는 요일' }), /요일/);
  assert.throws(() => store.add({ prompt: '매주 금요일 오후 1시에 상담사 데이터를 갱신해줘' }), /이미 있습니다/);
  f.set('2026-10-30T04:00:00Z'); store.tick(); assert.equal(f.started.length, 1);
  assert.equal(store.list().find((x) => x.id === friday.id).nextAt, '2026-11-06T04:00:00.000Z');
  f.history[0].status = 'done';
  f.set('2026-10-31T04:00:00Z'); store.tick(); assert.equal(f.started.length, 1); // 토요일은 실행하지 않는다
  // 일시중지·재개는 요일을 그대로 두고, 요일을 바꾸면 다음 시각을 새로 정한다
  store.update(friday.id, { enabled: false }); store.update(friday.id, { enabled: true });
  assert.deepEqual(store.list().find((x) => x.id === friday.id).weekdays, [5]);
  const moved = store.update(friday.id, { weekdays: [2] });
  assert.equal(moved.nextAt, '2026-11-03T04:00:00.000Z');
  const daily = store.update(friday.id, { weekdays: null });
  assert.equal(daily.weekdays, null); assert.equal(daily.nextAt, '2026-11-01T04:00:00.000Z');
});
