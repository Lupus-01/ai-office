#!/usr/bin/env node
// 상담사 메일 자료 수집: ERP 화면을 사람처럼 넘기지 않고, 화면이 쓰는 자료를 한 번에 읽어 메일에 쓸 값만 정리한다.
// Aside 브라우저의 ERP 로그인을 쓴다(읽기 전용, 저장·수정·발송 없음). AI를 쓰지 않아 59명도 1~2분이면 끝난다.
//
//   node 보관함/상담사관리/도구/erp-collect.cjs --out <정리.json> [--limit 3] [--names 예명1,예명2] [--erp https://…]
//   node 보관함/상담사관리/도구/erp-collect.cjs --check        ERP 로그인만 확인(시작 전 점검용. 됐으면 종료 코드 0)
//
// ERP 주소는 --erp 또는 같은 폴더의 설정.json({"erp":"https://…"})에서 읽는다. 고객 이름·닉네임·전화번호는 읽은 자리에서 버리고 수만 남긴다.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : ''; };
const fail = (message) => { console.error(message); process.exit(1); };

const configPath = path.join(__dirname, '설정.json');
const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};
// 회사 구성을 받아 쓰는 PC는 처음 가져올 때 입력한 ERP 주소(작업 공간 .office/shared-org.json)를 쓴다
const markerPath = path.join(__dirname, '..', '..', '..', '.office', 'shared-org.json');
let marker = {};
try { if (fs.existsSync(markerPath)) marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')); } catch { marker = {}; }
const origin = String(opt('erp') || config.erp || marker.erp || '').replace(/\/+$/, '');
if (!/^https:\/\/[^/]+$/.test(origin)) fail('ERP 주소가 없습니다. 터미널 AI에게 "홍카페 ERP 주소 등록해줘"라고 하고 주소를 알려 주세요(대표 PC는 도구 폴더의 설정.json에 {"erp":"https://…"}).');
const checkOnly = args.includes('--check');
const out = opt('out');
if (!out && !checkOnly) fail('--out <정리.json> 이 필요합니다.');
const limit = Number(opt('limit')) || 0;
const names = opt('names') ? opt('names').split(',').map((s) => s.trim()).filter(Boolean) : [];

// Aside CLI 위치: PATH에 없으면 기본 설치 위치를 본다
function asideBin() {
  const local = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Aside', 'CLI', 'current', 'aside.exe') : '';
  const home = path.join(process.env.HOME || process.env.USERPROFILE || '', '.aside', 'bin', 'aside');
  for (const p of [local, home]) if (p && fs.existsSync(p)) return p;
  return 'aside';
}
function repl(code) {
  const r = spawnSync(asideBin(), ['repl', '--json', '--file', '-'], { input: code, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 150000 });
  if (r.error) fail(`Aside를 실행하지 못했습니다(${r.error.message}). Aside 앱과 CLI가 설치돼 있는지 확인해 주세요.`);
  const line = String(r.stdout || '').trim().split('\n').pop();
  let parsed; try { parsed = JSON.parse(line); } catch { fail(`Aside 응답을 읽지 못했습니다: ${String(r.stdout || r.stderr).slice(-300)}`); }
  const text = (parsed.run?.content || []).map((c) => c.text || '').join('\n');
  const at = text.indexOf('AIO_RESULT');
  if (at < 0) fail(`ERP 자료를 읽지 못했습니다: ${parsed.run?.error || text.slice(-300)}`);
  const end = text.indexOf('AIO_END', at);
  return JSON.parse(text.slice(at + 10, end < 0 ? undefined : end));
}

// 날짜(한국 시간): 지난주는 ERP 주간 기본값, 월 비교는 이번 달 1일~어제와 지난달 같은 날짜
const kst = new Date(Date.now() + 9 * 3600 * 1000);
const ymd = (d) => d.toISOString().slice(0, 10);
const yesterday = new Date(Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate() - 1));
const baseStart = new Date(Date.UTC(yesterday.getUTCFullYear(), yesterday.getUTCMonth(), 1));
const prevStart = new Date(Date.UTC(baseStart.getUTCFullYear(), baseStart.getUTCMonth() - 1, 1));
const prevLast = new Date(Date.UTC(baseStart.getUTCFullYear(), baseStart.getUTCMonth(), 0)).getUTCDate();
const prevEnd = new Date(Date.UTC(prevStart.getUTCFullYear(), prevStart.getUTCMonth(), Math.min(yesterday.getUTCDate(), prevLast)));
const period = { start: ymd(baseStart), end: ymd(yesterday), compareStart: ymd(prevStart), compareEnd: ymd(prevEnd) };

// 1) 목록·실적·메일 주소: 화면이 붙이는 요청 머리말을 한 번 받아 같은 자료를 읽는다
const listCode = `
const AIO = ${JSON.stringify({ origin, period })};
const aioTab = await openTab(AIO.origin + '/erp/counselor-performance');
await sleep(5000);
if (!/counselor-performance/.test(aioTab.url())) { console.log('AIO_RESULT' + JSON.stringify({ error: 'login' }) + 'AIO_END'); }
else {
  await aioTab.evaluate(() => {
    window.__aioHeaders = null; const of = window.fetch;
    window.fetch = function (...a) { try { const u = typeof a[0] === 'string' ? a[0] : a[0].url; if (/counselor-performance\\?/.test(u) && !window.__aioHeaders) { const h = {}; const src = a[1]?.headers || (a[0] instanceof Request ? a[0].headers : null); if (src) { if (src instanceof Headers) src.forEach((v, k) => { h[k] = v; }); else Object.assign(h, src); } window.__aioHeaders = h; } } catch {} return of.apply(this, a); };
  });
  await aioTab.getByText('직접지정', { exact: false }).first().click(); await sleep(1000);
  const aioDates = aioTab.locator('input[type="date"]'); const aioVals = [AIO.period.start, AIO.period.end, AIO.period.compareStart, AIO.period.compareEnd];
  for (let i = 0; i < 4; i++) await aioDates.nth(i).fill(aioVals[i]);
  await aioTab.getByRole('button', { name: '조회' }).first().click();
  for (let i = 0; i < 30 && !(await aioTab.evaluate(() => !!window.__aioHeaders)); i++) await sleep(500);
  const aioData = await aioTab.evaluate(async (AIO) => {
    const headers = window.__aioHeaders; if (!headers) return { error: 'headers' };
    const get = async (u) => { const r = await fetch(u, { headers }); if (!r.ok) throw new Error(u.split('?')[0] + ' ' + r.status); return r.json(); };
    const pick = (c) => c && ({ sales: c.salesAmount, phone: c.phoneConsultationCount, chat: c.chatConsultationCount, missed: c.missedConsultationCount, reviews: c.reviewCount, unanswered: c.unansweredReviewCount, access: c.accessDurationSeconds });
    try {
      const p = AIO.period;
      const custom = await get('/api/admin/counselor-performance?preset=CUSTOM&startDate=' + p.start + '&endDate=' + p.end + '&compareStartDate=' + p.compareStart + '&compareEndDate=' + p.compareEnd);
      const weekly = await get('/api/admin/counselor-performance?preset=WEEKLY');
      const mails = await get('/api/admin/counselor-performance/counselor-emails?preset=WEEKLY&managerRealName=' + encodeURIComponent(weekly.managerRealName || ''));
      const mailOf = {}; for (const m of mails.counselors || []) { const code = m.counselorCode || m.code; const mail = m.email || m.counselorEmail || m.mail || Object.values(m).find((v) => typeof v === 'string' && /^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(v)); if (code && mail) mailOf[code] = mail; }
      const monthOf = {}; for (const c of custom.counselors || []) monthOf[c.base.counselorCode] = { base: pick(c.base), compare: pick(c.compare) };
      return { headers, manager: weekly.managerRealName, weeklyPeriod: { base: weekly.basePeriod, compare: weekly.comparePeriod }, total: (weekly.counselors || []).length,
        counselors: (weekly.counselors || []).map((c) => ({ code: c.base.counselorCode, nickname: c.base.counselorNickname, level: c.base.level, levelName: c.base.levelName, levelGroup: c.base.levelGroup, category: c.base.category, email: mailOf[c.base.counselorCode] || '', week: { base: pick(c.base), compare: pick(c.compare) }, month: monthOf[c.base.counselorCode] || null })) };
    } catch (e) { return { error: String(e.message || e) }; }
  }, AIO);
  console.log('AIO_RESULT' + JSON.stringify(aioData) + 'AIO_END');
}
await closeTab(aioTab);
`;

// 2) 상담사별 분석 자료(접속·통화·고객·후기): 한 번에 20명씩, 동시에 5명
const detailCode = (headers, codes) => `
const AIO = ${JSON.stringify({ origin, headers, codes })};
const aioTab = await openTab(AIO.origin + '/erp/counselor-performance');
await sleep(3000);
const aioData = await aioTab.evaluate(async (AIO) => {
  const get = async (u) => { try { const r = await fetch(u, { headers: AIO.headers }); return r.ok ? await r.json() : null; } catch { return null; } };
  const win = (s) => s && ({ label: s.peakWindowLabel || s.peakLabel || '', count: s.peakWindowCount ?? s.peakCount ?? null, basis: s.basisLabel || '', days: s.periodDays ?? null });
  const one = async (code) => {
    const [access, call, sales, reviews] = await Promise.all([get('/api/analysis/' + code), get('/api/analysis/call/' + code), get('/api/analysis/sales/' + code), get('/api/analysis/reviews/current/' + code)]);
    const vip = call?.vipRadar || []; const byRisk = {}; const riskDays = [];
    for (const v of vip) { const k = String(v.riskStatus || ''); byRisk[k] = (byRisk[k] || 0) + 1; if (/위험|RISK|DANGER|HIGH/i.test(k) && typeof v.daysSinceLast === 'number') riskDays.push(v.daysSinceLast); }
    return { code,
      accessPeak14: win(access?.activitySummary?.recent14d), accessPeak30: win(access?.activitySummary?.recent30d), accessBasis: access?.meta?.basisLabel || '',
      callPeak14: win(call?.activitySummary?.recent14d), callPeak30: win(call?.activitySummary?.recent30d),
      consult30: call?.durationStats ? { count: call.durationStats.totalCount, avgSeconds: call.durationStats.avgDuration } : null,
      vipTotal: vip.length, regulars30: call?.regularClientCount ?? null, revisitRate: call?.revisitRate ?? null, vipByStatus: byRisk, riskDaysMin: riskDays.length ? Math.min(...riskDays) : null, riskDaysMax: riskDays.length ? Math.max(...riskDays) : null,
      customerBasis: call?.meta?.basisLabel || '', customerAsOf: call?.meta?.lastDataAt || call?.meta?.timestampLabel || '',
      salesAsOf: sales?.meta?.lastDataAt || sales?.meta?.timestampLabel || '',
      reviews: reviews ? { days: reviews.focusMeta?.periodDays ?? null, count: reviews.focusMeta?.reviewCount ?? reviews.totalCount ?? null, total: reviews.totalCount ?? null, avgScore: reviews.avgScore ?? null, positive: (reviews.positiveKeywords || []).slice(0, 5).map((k) => k.keyword), negative: (reviews.negativeKeywords || []).slice(0, 5).map((k) => k.keyword), asOf: reviews.meta?.lastDataAt || '' } : null };
  };
  const out = []; const queue = [...AIO.codes];
  await Promise.all(Array.from({ length: 5 }, async () => { while (queue.length) out.push(await one(queue.shift())); }));
  return out;
}, AIO);
console.log('AIO_RESULT' + JSON.stringify(aioData) + 'AIO_END');
await closeTab(aioTab);
`;

// --check: 업무를 시작하기 전에 ERP 로그인만 10초 안팎으로 확인한다(자료는 읽지 않는다)
if (checkOnly) {
  const state = repl(`
const aioTab = await openTab(${JSON.stringify(origin + '/erp/counselor-performance')});
await sleep(4000);
const aioOk = /counselor-performance/.test(aioTab.url()) && !(await aioTab.locator('input[type="password"]').count().catch(() => 0));
console.log('AIO_RESULT' + JSON.stringify({ ok: aioOk }) + 'AIO_END');
await closeTab(aioTab);
`);
  if (!state.ok) fail('ERP 로그인이 필요합니다. Aside 브라우저에서 ERP에 로그인한 뒤 "로그인했어"라고 답해 주세요.');
  console.log('ERP 로그인 확인됨');
  process.exit(0);
}

const started = Date.now();
const list = repl(listCode);
if (list.error === 'login') fail('ERP 로그인이 필요합니다. Aside 브라우저에서 ERP에 로그인한 뒤 다시 실행해 주세요.');
if (list.error) fail(`ERP 자료를 읽지 못했습니다: ${list.error}`);

const consults = (v) => (v?.phone || 0) + (v?.chat || 0);
// 등급 숫자(level)는 그린·퍼플을 이어 센 값이라 단계 이름("6단계")에서 단계를 읽는다
const stage = (c) => Number((String(c.levelName || '').match(/(\d)단계/) || [])[1] ?? -1);
let targets = list.counselors.filter((c) => stage(c) >= 1 && stage(c) <= 6);
const excluded = { 등급밖: list.counselors.length - targets.length };
if (names.length) targets = targets.filter((c) => names.includes(c.nickname));
if (limit) targets = targets.slice(0, limit);

const needDetail = targets.filter((c) => consults(c.week.base) > 0 || consults(c.month?.base) > 0);
const detail = {};
for (let i = 0; i < needDetail.length; i += 20) for (const d of repl(detailCode(list.headers, needDetail.slice(i, i + 20).map((c) => c.code)))) detail[d.code] = d;

const hours = (s) => (typeof s === 'number' ? Math.round(s / 360) / 10 : null);
const diff = (a, b) => (typeof a === 'number' && typeof b === 'number' ? a - b : null);
const result = {
  기준: { 조회시각: new Date().toISOString(), 담당자: list.manager, 지난주: `${list.weeklyPeriod.base.startDate} ~ ${list.weeklyPeriod.base.endDate}`, 전주: `${list.weeklyPeriod.compare.startDate} ~ ${list.weeklyPeriod.compare.endDate}`, 이번달같은기간: `${period.start} ~ ${period.end}`, 지난달같은기간: `${period.compareStart} ~ ${period.compareEnd}`, 담당상담사수: list.total, 대상: '현재 등급 1~6단계' },
  설명: { 금액: '원', 지난주: '기준 기간(지난주) 값과 전주 대비 증감. 접속시간·접속증감시간은 시간 단위', 같은기간비교: '이번 달 1일~조회 전날과 지난달 같은 날짜의 매출·상담건수. 메일의 "지난달 같은 기간과 비교"는 이 값만 쓴다', 'accessPeak14·callPeak14': '최근 14일 접속이 많은 시간대·상담이 많이 들어오는 시간대(label)', consult30: '최근 30일 상담 건수와 평균 상담시간(초)', vipTotal: '고객 관리 탭의 단골 고객 수(최근 90일 상담 5회 이상 또는 누적 5시간 이상)', vipByStatus: '그 가운데 위험·주의·안전 고객 수', 'riskDaysMin·riskDaysMax': '위험 고객의 마지막 상담 경과일 범위', regulars30: '최근 30일 통화실적 기준 단골 수(메일에는 vipTotal을 쓴다)', reviews: '최근 30일 후기 건수(count)·평균 별점·칭찬(positive)/아쉬움(negative) 키워드. 키워드는 화면처럼 낱말이 잘려 있다', 분석null: '상담이 없어 분석 자료를 읽지 않은 상담사(활동 안내형 메일 대상)' },
  상담사: targets.map((c) => {
    const d = detail[c.code] || null; const w = c.week, m = c.month;
    const { code: _code, ...분석 } = d || {};
    return { 예명: c.nickname, 메일주소: c.email, 등급: `${c.levelGroup === "purple" ? "퍼플 " : c.levelGroup === "green" ? "그린 " : ""}${c.levelName || ""}`, 분야: c.category,
      지난주: { 매출: w.base?.sales ?? null, 매출증감: diff(w.base?.sales, w.compare?.sales), 상담건수: consults(w.base), 상담건수증감: consults(w.base) - consults(w.compare), 부재중: w.base?.missed ?? null, 미답후기: w.base?.unanswered ?? null, 접속시간: hours(w.base?.access), 접속증감시간: hours(diff(w.base?.access, w.compare?.access)) },
      같은기간비교: m ? { 이번달매출: m.base?.sales ?? null, 지난달매출: m.compare?.sales ?? null, 매출증감: diff(m.base?.sales, m.compare?.sales), 이번달상담: consults(m.base), 지난달상담: consults(m.compare), 상담증감: consults(m.base) - consults(m.compare), 미답후기: m.base?.unanswered ?? null } : null,
      분석: d ? 분석 : null };
  }),
  보내지않는대상: targets.filter((c) => !c.email).map((c) => `메일 주소 없음: ${c.nickname}`),
  제외: excluded,
};
fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(result, null, 1)}\n`);
console.log(`상담사 메일 자료 수집 완료: 대상 ${targets.length}명(분석 자료 ${needDetail.length}명), 메일 주소 없음 ${result.보내지않는대상.length}명, ${Math.round((Date.now() - started) / 1000)}초`);
console.log(`기간: 지난주 ${result.기준.지난주} / 이번 달 ${result.기준.이번달같은기간} · 지난달 ${result.기준.지난달같은기간}`);
console.log(`저장: ${out}`);
