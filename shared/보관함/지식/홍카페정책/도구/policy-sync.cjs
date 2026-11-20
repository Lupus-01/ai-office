// 홍카페 정책 지식창고 갱신 도구
// Notion 「정책서 이력 관리」에서 문서마다 현행판(시행일이 가장 늦은 판)만 골라 첨부를 내려받고 글(md)로 바꿔 둔다.
// Notion은 읽기만 한다. Notion 조회는 로그인된 Claude(haiku)의 Notion 연결을 빌려 쓰고, 첨부 내려받기 링크는
// 도구 결과에서 바로 읽으므로 AI가 링크를 옮겨 적지 않는다. 링크(서명된 임시 주소)는 파일·화면에 남기지 않는다.
// 대표 결정(2026-11-16): 이전 버전은 넣지 않는다. 내부 문서도 넣되 '내부용'으로 표시한다.
//
// 사용: node policy-sync.cjs            바뀐 문서만 갱신
//       node policy-sync.cjs --check    무엇이 바뀌는지만 보여 주고 아무것도 쓰지 않음
//       node policy-sync.cjs --force    모든 현행 문서를 다시 받음
//       --dir <폴더>                     지식창고 대신 다른 폴더에 쓰기(시험용)
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, spawnSync, execFileSync } = require('child_process');

const CONVERTER_VERSION = 1; // 변환 규칙을 바꾸면 올린다(원본에서 다시 변환)
const DB_URL = 'https://app.notion.com/p/33c504c917c9802b99bcfd6c1aad0134';
const VIEW_URL = `${DB_URL}?v=33c504c917c980bab723000c77f0b2e8`;
const READ_TOOLS = ['mcp__claude_ai_Notion__notion-query-data-sources', 'mcp__claude_ai_Notion__notion-fetch'];
const BLOCKED_TOOLS = 'Bash,PowerShell,Write,Edit,NotebookEdit,WebFetch,WebSearch,Agent';
const PUBLIC_KINDS = ['이용약관', '개인정보처리방침', '청약철회 등 환불 안내'];
const BATCH = 4; // 내려받기 링크는 5분 뒤 만료되므로 몇 문서씩 나눠 받는다

// ---------- 인자·경로 ----------
const argv = process.argv.slice(2);
const opt = { check: argv.includes('--check'), force: argv.includes('--force'), dir: null };
const di = argv.indexOf('--dir');
if (di >= 0) opt.dir = path.resolve(argv[di + 1] || '');
const KB = opt.dir || path.resolve(__dirname, '..');
const CUR = path.join(KB, '현행');
const ORIG = path.join(KB, '원본');
const STATE = path.join(KB, '상태.json');
const INDEX = path.join(KB, '목록.md');
const LOG = path.join(KB, '변경기록.md');
const LOCK = path.join(KB, '.갱신중');

function programRoot() {
  if (process.env.AI_OFFICE_PROGRAM) return process.env.AI_OFFICE_PROGRAM;
  let dir = __dirname;
  for (let i = 0; i < 12; i++) {
    const marker = path.join(dir, '.ai-office-workspace');
    if (fs.existsSync(marker)) {
      const m = fs.readFileSync(marker, 'utf8').match(/^program:\s*(.+)$/m);
      if (m) return m[1].trim();
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error('프로그램 폴더를 찾지 못했습니다. 작업 공간의 .ai-office-workspace 파일을 확인하세요.');
}
const PROGRAM = programRoot();
const JSZip = require(path.join(PROGRAM, 'node_modules', 'jszip'));
const ExcelJS = require(path.join(PROGRAM, 'node_modules', 'exceljs'));

// ---------- 공통 ----------
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const nowIso = () => new Date().toISOString();
const kst = (d = new Date()) => new Date(d.getTime() + 9 * 3600e3).toISOString().replace('T', ' ').slice(0, 16);
const parseJson = (t) => { try { return JSON.parse(t); } catch { return null; } };
const pageId = (url) => ((String(url || '').match(/[0-9a-f]{32}/i) || [])[0] || '').toLowerCase();
const unmd = (s) => String(s ?? '').replace(/\\([\\_*~`[\]()#+\-.!|])/g, '$1').trim();
const decodeEnt = (s) => String(s)
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&amp;/g, '&');
const safeName = (s) => String(s).replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
const platformShort = (p) => (/글로벌/.test(p) ? '글로벌' : String(p || '').replace(/\s+/g, '')) || '기타';
const scope = (kind) => (PUBLIC_KINDS.includes(kind) ? '공개 문서' : kind === 'FAQ' ? '고객 안내(FAQ)' : '내부용');
function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}
function verCmp(a, b) {
  const x = String(a || '').match(/\d+/g) || [];
  const y = String(b || '').match(/\d+/g) || [];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = Number(x[i] || 0) - Number(y[i] || 0);
    if (d) return d;
  }
  return 0;
}

// ---------- Claude(Notion 연결) 호출 ----------
function claudeBin() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  const names = process.platform === 'win32' ? ['claude.exe', 'claude.cmd'] : ['claude'];
  const dirs = [...String(process.env.PATH || '').split(path.delimiter), path.join(os.homedir(), '.local', 'bin'),
    path.join(process.env.APPDATA || '', 'npm'), '/opt/homebrew/bin', '/usr/local/bin'];
  for (const d of dirs) for (const n of names) { if (d && fs.existsSync(path.join(d, n))) return path.join(d, n); }
  return 'claude';
}
function runClaude(prompt, { timeoutMs = 10 * 60e3 } = {}) {
  return new Promise((resolve) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-sync-'));
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (k.startsWith('OFFICE_') || k === 'CLAUDE_PROJECT_DIR' || k === 'CLAUDECODE') delete env[k];
    const bin = claudeBin();
    const args = ['-p', '--model', 'haiku', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'dontAsk',
      '--allowedTools', READ_TOOLS.join(','), '--disallowedTools', BLOCKED_TOOLS, '--no-session-persistence'];
    const win = process.platform === 'win32';
    const child = win
      ? spawn([bin.includes(' ') ? `"${bin}"` : bin, ...args].join(' '), { shell: true, cwd, env, windowsHide: true })
      : spawn(bin, args, { cwd, env });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { try { child.kill(); } catch { /* 이미 끝남 */ } }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { err += String(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* 임시 폴더 */ }
      const uses = new Map();
      const calls = [];
      let result = null;
      for (const line of out.split('\n')) {
        const ev = parseJson(line.trim());
        if (!ev) continue;
        if (ev.type === 'result') result = ev;
        const content = ev.message?.content;
        if (!Array.isArray(content)) continue;
        for (const c of content) {
          if (c.type === 'tool_use') uses.set(c.id, { name: c.name, input: c.input });
          if (c.type === 'tool_result') {
            const u = uses.get(c.tool_use_id) || {};
            const text = Array.isArray(c.content) ? c.content.map((x) => x.text || '').join('') : String(c.content ?? '');
            calls.push({ name: u.name, input: u.input, text, isError: !!c.is_error });
          }
        }
      }
      resolve({ code, calls, result, err: err.slice(-500) });
    });
    child.stdin.end(prompt);
  });
}

const RULES = '너는 Notion 자료를 읽어 오는 중계 역할만 한다. Notion 도구는 ToolSearch로 불러 쓴다. '
  + '아래에 적힌 읽기 도구만 적힌 대로 부르고, 무엇도 만들거나 고치거나 지우지 않는다. 결과를 요약하지 않는다. 다 끝나면 DONE 한 단어로 답한다.';

async function listAll() {
  const prompt = `${RULES}\n1) mcp__claude_ai_Notion__notion-query-data-sources 를 {"data":{"mode":"view","view_url":"${VIEW_URL}","page_size":100}} 로 부른다. has_more가 true면 같은 값에 start_cursor를 넣어 끝까지 부른다.\n2) 결과의 모든 행 url마다 mcp__claude_ai_Notion__notion-fetch 를 {"id":"<행 url>"} 로 부른다(include_file_urls는 넣지 않는다). 여러 개를 한 번에 불러도 된다.`;
  const run = await runClaude(prompt);
  const rows = [];
  const pages = new Map();
  for (const c of run.calls) {
    const obj = parseJson(c.text);
    if (!obj) continue;
    if (c.name?.endsWith('notion-query-data-sources') && Array.isArray(obj.results)) rows.push(...obj.results);
    if (c.name?.endsWith('notion-fetch') && obj.metadata?.type === 'page') pages.set(pageId(obj.url), obj);
  }
  return { run, rows, pages };
}

async function fetchPages(urls, { withFiles }) {
  const list = urls.map((u) => `- ${u}`).join('\n');
  const prompt = `${RULES}\n아래 페이지마다 mcp__claude_ai_Notion__notion-fetch 를 {"id":"<페이지 url>"${withFiles ? ',"include_file_urls":true' : ''}} 로 한 번씩 부른다. 여러 개를 한 번에 불러도 된다.\n${list}`;
  const run = await runClaude(prompt);
  const pages = new Map();
  for (const c of run.calls) {
    const obj = parseJson(c.text);
    if (obj && c.name?.endsWith('notion-fetch') && obj.metadata?.type === 'page') pages.set(pageId(obj.url), obj);
  }
  return { run, pages };
}

// ---------- Notion 페이지 해석 ----------
function readPage(obj) {
  const text = String(obj.text || '');
  const props = parseJson((text.match(/<properties>\s*([\s\S]*?)\s*<\/properties>/) || [])[1] || '') || {};
  const content = (text.match(/<content>([\s\S]*?)<\/content>/) || [])[1] || '';
  const files = [];
  for (const m of content.matchAll(/notion-file-block:\/\/[^"'\s<>]+/g)) {
    const ref = m[0].replace(/&amp;/g, '&');
    const id = (ref.match(/^notion-file-block:\/\/([^?]+)/) || [])[1] || ref;
    let name = '';
    try { name = decodeURIComponent((ref.match(/[?&]name=([^&]+)/) || [])[1] || ''); } catch { name = ''; }
    const ext = (name.match(/\.([A-Za-z0-9]{1,6})$/) || [])[1]?.toLowerCase() || 'bin';
    if (!files.some((f) => f.id === id)) files.push({ ref, id, ext, origName: name });
  }
  // 첨부·임베드 블록(파일은 따로 받는다)과 빈 블록은 본문에서 뺀다
  const body = content
    .replace(/<(file|embed|pdf|image|video|audio)\b[^>]*\/>/g, '')
    .replace(/<(file|embed|pdf|image|video|audio)\b[^>]*>[\s\S]*?<\/\1>/g, '')
    .replace(/<empty-block\s*\/>/g, '').trim();
  return { props, files, body, edited: obj.page_last_edited_at || '', refs: obj.references || null };
}

function signedUrl(refs, ref) {
  if (!refs) return null;
  if (Array.isArray(refs)) {
    const hit = refs.find((r) => r && (r.reference === ref || r.ref === ref));
    return hit?.url || null;
  }
  const v = refs[ref];
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') return v.url || v.signed_url || null;
  // 키가 살짝 다르게 들어온 경우: 파일 id로 찾는다
  const id = (ref.match(/^notion-file-block:\/\/([^?]+)/) || [])[1];
  for (const [k, val] of Object.entries(refs)) {
    if (id && k.includes(id)) return typeof val === 'string' ? val : val?.url || null;
  }
  return null;
}

// ---------- 작은 XML 해석기(워드용) ----------
function parseXml(xml) {
  const root = { name: '#root', attrs: {}, children: [] };
  const stack = [root];
  const re = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|([^<]+)/g;
  let m;
  while ((m = re.exec(xml))) {
    const top = stack[stack.length - 1];
    if (m[6] !== undefined) { top.children.push({ text: decodeEnt(m[6]) }); continue; }
    if (m[5] !== undefined) { top.children.push({ text: m[5] }); continue; }
    if (!m[2]) continue;
    if (m[1]) {
      for (let i = stack.length - 1; i > 0; i--) if (stack[i].name === m[2]) { stack.length = i; break; }
      continue;
    }
    const attrs = {};
    for (const a of m[3].matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = decodeEnt(a[2] ?? a[3] ?? '');
    const node = { name: m[2], attrs, children: [] };
    top.children.push(node);
    if (!m[4]) stack.push(node);
  }
  return root;
}
const kids = (n, name) => (n?.children || []).filter((c) => c.name === name);
const kid = (n, name) => (n?.children || []).find((c) => c.name === name);
function findFirst(n, name) {
  if (!n || !n.children) return null;
  for (const c of n.children) {
    if (c.name === name) return c;
    const f = findFirst(c, name);
    if (f) return f;
  }
  return null;
}

// ---------- 워드(.docx) ----------
const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';
const GANADA = '가나다라마바사아자차카타파하';
const CHOSUNG = 'ㄱㄴㄷㄹㅁㅂㅅㅇㅈㅊㅋㅌㅍㅎ';
function roman(n) {
  const t = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let s = '';
  for (const [v, r] of t) while (n >= v) { s += r; n -= v; }
  return s;
}
function fmtNum(n, fmt) {
  switch (fmt) {
    case 'decimalZero': return n < 10 ? `0${n}` : String(n);
    case 'upperLetter': return String.fromCharCode(64 + ((n - 1) % 26) + 1);
    case 'lowerLetter': return String.fromCharCode(96 + ((n - 1) % 26) + 1);
    case 'upperRoman': return roman(n);
    case 'lowerRoman': return roman(n).toLowerCase();
    case 'ganada': return GANADA[(n - 1) % GANADA.length];
    case 'chosung': return CHOSUNG[(n - 1) % CHOSUNG.length];
    case 'decimalEnclosedCircle': case 'decimalEnclosedCircleChinese': case 'decimalEnclosedFullstop':
      return n <= 20 ? CIRCLED[n - 1] : `(${n})`;
    case 'decimalEnclosedParen': return `(${n})`;
    case 'none': return '';
    default: return String(n);
  }
}

function docxStyles(xml) {
  const map = {};
  if (!xml) return map;
  const tree = parseXml(xml);
  const styles = findFirst(tree, 'w:styles');
  for (const s of kids(styles, 'w:style')) {
    const id = s.attrs['w:styleId'];
    const pPr = kid(s, 'w:pPr');
    const numPr = kid(pPr, 'w:numPr');
    map[id] = {
      name: kid(s, 'w:name')?.attrs['w:val'] || '',
      basedOn: kid(s, 'w:basedOn')?.attrs['w:val'] || null,
      numId: kid(numPr, 'w:numId')?.attrs['w:val'] ?? null,
      ilvl: kid(numPr, 'w:ilvl')?.attrs['w:val'] ?? null,
      outline: kid(pPr, 'w:outlineLvl')?.attrs['w:val'] ?? null,
    };
  }
  return map;
}
function styleProp(map, id, key) {
  for (let i = 0; id && map[id] && i < 10; i++) {
    if (map[id][key] !== null && map[id][key] !== undefined) return map[id][key];
    id = map[id].basedOn;
  }
  return null;
}
function docxNumbering(xml) {
  const abs = {};
  const nums = {};
  if (!xml) return { abs, nums };
  const tree = parseXml(xml);
  const root = findFirst(tree, 'w:numbering');
  for (const a of kids(root, 'w:abstractNum')) {
    const lv = {};
    for (const l of kids(a, 'w:lvl')) {
      lv[l.attrs['w:ilvl']] = {
        start: Number(kid(l, 'w:start')?.attrs['w:val'] ?? 1),
        fmt: kid(l, 'w:numFmt')?.attrs['w:val'] || 'decimal',
        text: kid(l, 'w:lvlText')?.attrs['w:val'] ?? '',
      };
    }
    abs[a.attrs['w:abstractNumId']] = lv;
  }
  for (const n of kids(root, 'w:num')) {
    const over = {};
    for (const o of kids(n, 'w:lvlOverride')) {
      const s = kid(o, 'w:startOverride');
      if (s) over[o.attrs['w:ilvl']] = Number(s.attrs['w:val']);
    }
    nums[n.attrs['w:numId']] = { abs: kid(n, 'w:abstractNumId')?.attrs['w:val'], over };
  }
  return { abs, nums };
}

function runText(node) {
  let s = '';
  for (const c of node.children || []) {
    if (c.text !== undefined) continue; // 태그 사이 공백은 버린다
    switch (c.name) {
      case 'w:t': s += (c.children || []).map((x) => x.text || '').join(''); break;
      case 'w:tab': s += '\t'; break;
      case 'w:br': case 'w:cr': s += '\n'; break;
      case 'w:pPr': case 'w:rPr': case 'w:instrText': case 'w:delText': case 'mc:Fallback': case 'w:del': break;
      default: s += runText(c);
    }
  }
  return s;
}

async function docxToMd(buf) {
  const zip = await JSZip.loadAsync(buf);
  const docXml = await zip.file('word/document.xml')?.async('string');
  if (!docXml) throw new Error('워드 본문(word/document.xml)이 없습니다');
  const styles = docxStyles(await zip.file('word/styles.xml')?.async('string'));
  const numbering = docxNumbering(await zip.file('word/numbering.xml')?.async('string'));
  const counters = {}; // numId -> [레벨별 현재 번호]
  const pictures = (docXml.match(/<w:drawing\b|<w:pict\b/g) || []).length;

  function label(numId, ilvl) {
    const inst = numbering.nums[numId];
    if (!inst) return null;
    const lv = numbering.abs[inst.abs] || {};
    const L = Number(ilvl || 0);
    const def = lv[L];
    if (!def) return null;
    const c = counters[numId] || (counters[numId] = []);
    for (let i = 0; i <= L; i++) if (c[i] === undefined) c[i] = (inst.over[i] ?? lv[i]?.start ?? 1) - 1;
    c[L] += 1;
    c.length = L + 1;
    if (def.fmt === 'bullet') return { bullet: true, level: L };
    const text = def.text.replace(/%(\d)/g, (_, k) => {
      const idx = Number(k) - 1;
      const d = lv[idx];
      return d ? fmtNum(c[idx] ?? d.start, d.fmt) : '';
    });
    return { bullet: false, level: L, text };
  }

  function paraInfo(p) {
    const pPr = kid(p, 'w:pPr');
    const styleId = kid(pPr, 'w:pStyle')?.attrs['w:val'] || null;
    const numPr = kid(pPr, 'w:numPr');
    let numId = kid(numPr, 'w:numId')?.attrs['w:val'] ?? null;
    let ilvl = kid(numPr, 'w:ilvl')?.attrs['w:val'] ?? null;
    if (numId === null) { numId = styleProp(styles, styleId, 'numId'); if (ilvl === null) ilvl = styleProp(styles, styleId, 'ilvl'); }
    const sname = (styles[styleId]?.name || '').toLowerCase();
    let heading = 0;
    const hm = sname.match(/^heading\s*(\d)$/) || sname.match(/^제목\s*(\d)$/);
    if (hm) heading = Number(hm[1]);
    else if (sname === 'title') heading = 1;
    else {
      const ol = kid(pPr, 'w:outlineLvl')?.attrs['w:val'] ?? styleProp(styles, styleId, 'outline');
      if (ol !== null && Number(ol) < 9) heading = Number(ol) + 1;
    }
    const text = runText(p).replace(/\u00a0/g, ' ');
    const num = numId && numId !== '0' && text.trim() ? label(numId, ilvl) : null;
    return { heading: Math.min(heading, 6), num, text };
  }

  const esc = (s) => s.replace(/\|/g, '\\|');
  function paraLine(p) {
    const { heading, num, text } = paraInfo(p);
    const t = text.replace(/\t/g, ' ').replace(/[ ]{2,}/g, ' ').trim();
    if (!t) return '';
    const lead = num ? (num.bullet ? `${'  '.repeat(Math.min(num.level, 3))}- ` : `${num.text} `) : '';
    if (heading) return `${'#'.repeat(heading)} ${lead}${t.replace(/\n/g, ' ')}`;
    return `${lead}${t}`;
  }
  function cellText(tc) {
    const parts = [];
    for (const c of tc.children || []) {
      if (c.name === 'w:p') { const l = paraLine(c); if (l) parts.push(l); }
      else if (c.name === 'w:tbl') parts.push(...kids(c, 'w:tr').map((tr) => kids(tr, 'w:tc').map(cellText).join(' / ')));
      else if (c.name === 'w:sdt') { const sc = kid(c, 'w:sdtContent'); if (sc) parts.push(cellText(sc)); }
    }
    return parts.join('\n').replace(/^#+\s*/gm, '');
  }
  function tableMd(tbl) {
    const rows = kids(tbl, 'w:tr').map((tr) => {
      const cells = [];
      for (const c of tr.children || []) {
        if (c.name === 'w:tc') cells.push(c);
        else if (c.name === 'w:sdt') cells.push(...kids(kid(c, 'w:sdtContent'), 'w:tc'));
      }
      return cells.map((tc) => esc(cellText(tc)).replace(/\n/g, '<br>'));
    }).filter((r) => r.some((x) => x.trim()));
    if (!rows.length) return '';
    const width = Math.max(...rows.map((r) => r.length));
    if (width === 1) return rows.map((r) => `> ${r[0].replace(/<br>/g, '\n> ')}`).join('\n>\n');
    const pad = (r) => [...r, ...Array(width - r.length).fill('')];
    const lines = [`| ${pad(rows[0]).join(' | ')} |`, `|${' --- |'.repeat(width)}`];
    for (const r of rows.slice(1)) lines.push(`| ${pad(r).join(' | ')} |`);
    return lines.join('\n');
  }
  const out = [];
  function walk(node) {
    for (const c of node.children || []) {
      if (c.name === 'w:p') out.push(paraLine(c));
      else if (c.name === 'w:tbl') out.push('', tableMd(c), '');
      else if (c.name === 'w:sdt') walk(kid(c, 'w:sdtContent') || { children: [] });
      else if (c.name === 'w:customXml' || c.name === 'w:sdtContent') walk(c);
    }
  }
  walk(findFirst(parseXml(docXml), 'w:body') || { children: [] });
  const md = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { md, notes: pictures ? [`워드 안 그림 ${pictures}개는 글로 옮기지 못했습니다`] : [], pictPages: [] };
}

// ---------- 엑셀(.xlsx) ----------
function xlCell(cell) {
  const v = cell.value;
  if (v === null || v === undefined) return '';
  if (v instanceof Date) {
    const iso = v.toISOString();
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.slice(0, 16).replace('T', ' ');
  }
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join('');
    if ('result' in v) return v.result === undefined || v.result === null ? '' : (v.result instanceof Date ? v.result.toISOString().slice(0, 10) : String(v.result));
    if ('text' in v) return typeof v.text === 'string' ? v.text : Array.isArray(v.text?.richText) ? v.text.richText.map((r) => r.text).join('') : String(v.text);
    if ('error' in v) return String(v.error);
    return String(cell.text ?? '');
  }
  return String(v);
}
async function xlsxToMd(buf) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const parts = [];
  const notes = [];
  wb.eachSheet((ws) => {
    const grid = [];
    for (let r = 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const line = [];
      for (let c = 1; c <= ws.columnCount; c++) {
        const cell = row.getCell(c);
        const slave = cell.isMerged && cell.master && cell.master.address !== cell.address;
        line.push(slave ? '' : xlCell(cell).replace(/\r/g, '').trim());
      }
      grid.push(line);
    }
    const rows = grid.filter((r) => r.some((x) => x));
    const used = rows.length ? rows[0].map((_, i) => rows.some((r) => r[i])) : [];
    const clean = rows.map((r) => r.filter((_, i) => used[i]).map((x) => x.replace(/\|/g, '\\|').replace(/\n/g, '<br>')));
    const imgs = typeof ws.getImages === 'function' ? ws.getImages().length : 0;
    const hidden = ws.state && ws.state !== 'visible' ? ' (숨김 시트)' : '';
    parts.push(`## 시트: ${ws.name}${hidden}`);
    if (imgs) { parts.push(`[이 시트의 그림 ${imgs}개는 글로 옮기지 못했습니다]`); notes.push(`시트 「${ws.name}」 그림 ${imgs}개`); }
    if (!clean.length) { parts.push('(빈 시트)', ''); return; }
    const width = Math.max(...clean.map((r) => r.length));
    const pad = (r) => [...r, ...Array(width - r.length).fill('')];
    parts.push(`| ${pad(clean[0]).join(' | ')} |`, `|${' --- |'.repeat(width)}`);
    for (const r of clean.slice(1)) parts.push(`| ${pad(r).join(' | ')} |`);
    parts.push('');
  });
  const names = [];
  wb.eachSheet((ws) => names.push(ws.name));
  return { md: parts.join('\n').trim(), notes, pictPages: [], title: `시트: ${names.slice(0, 4).join(', ')}${names.length > 4 ? ' 외' : ''}` };
}

// ---------- PDF ----------
let PDFTOTEXT = null;
function pdftotextBin() {
  if (PDFTOTEXT) return PDFTOTEXT;
  const cands = ['pdftotext', 'C:\\Program Files\\Git\\mingw64\\bin\\pdftotext.exe', 'C:\\Program Files\\poppler\\Library\\bin\\pdftotext.exe', '/usr/bin/pdftotext', '/opt/homebrew/bin/pdftotext'];
  // 버전 표시(-v)가 0이 아닌 종료 코드를 내는 판도 있으므로 "실행 파일이 없음"만 실패로 본다
  for (const c of cands) {
    const r = spawnSync(c, ['-v'], { stdio: 'ignore', windowsHide: true });
    if (!r.error) { PDFTOTEXT = c; return c; }
  }
  throw new Error('pdftotext(Poppler)를 찾지 못했습니다');
}
function pdfToMd(file) {
  const text = execFileSync(pdftotextBin(), ['-layout', '-enc', 'UTF-8', file, '-'], { maxBuffer: 256 * 1024 * 1024 }).toString('utf8');
  const pages = text.split('\f');
  if (pages.length && !pages[pages.length - 1].trim()) pages.pop();
  const pict = [];
  const parts = pages.map((p, i) => {
    const body = p.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
    if (body.replace(/\s/g, '').length < 30) { pict.push(i + 1); return `## ${i + 1}쪽\n\n[이 쪽은 글자가 거의 없는 화면(그림)입니다. 원본 PDF ${i + 1}쪽을 직접 보세요]`; }
    return `## ${i + 1}쪽\n\n${body}`;
  });
  const notes = pict.length ? [`PDF 그림 위주 쪽 ${pict.length}개(${pict.join(', ')}쪽)`] : [];
  return { md: parts.join('\n\n'), notes, pictPages: pict };
}

// ---------- HTML·Notion 본문 ----------
const BR = '\u0001BR\u0001';
// Notion 본문의 굵게·코드 같은 짧은 태그를 마크다운으로 바꾼다
const inlineMd = (s) => String(s)
  .replace(/<\/?(b|strong)>/gi, '**').replace(/<\/?code>/gi, '`')
  .replace(/<\/?(i|em|u|s|del|span|mark|sup|sub)\b[^>]*>/gi, '')
  .replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '$2($1)');
function htmlTables(html) {
  let prev;
  do {
    prev = html;
    html = html.replace(/<table\b[^>]*>((?:(?!<table\b)[\s\S])*?)<\/table>/gi, (_, inner) => {
      const rows = [...inner.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((tr) =>
        [...tr[1].matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((td) => inlineMd(decodeEnt(td[1]
          .replace(/<br\s*\/?>/gi, BR).replace(/<\/(p|div|li)>/gi, BR).replace(/<[^>]+>/g, '')))
          .replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|').replace(new RegExp(`(${BR})+$`), '').trim()))
        .filter((r) => r.some((x) => x.replace(new RegExp(BR, 'g'), '').trim()));
      if (!rows.length) return '\n';
      const width = Math.max(...rows.map((r) => r.length));
      const pad = (r) => [...r, ...Array(width - r.length).fill('')];
      const lines = [`| ${pad(rows[0]).join(' | ')} |`, `|${' --- |'.repeat(width)}`, ...rows.slice(1).map((r) => `| ${pad(r).join(' | ')} |`)];
      return `\n\n${lines.join('\n')}\n\n`;
    });
  } while (html !== prev);
  return html;
}
function htmlToMd(html) {
  let images = 0;
  let s = String(html)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|head|svg|noscript)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<img\b[^>]*>/gi, (tag) => { images++; const alt = (tag.match(/alt\s*=\s*"([^"]*)"/i) || [])[1]; return `[그림${alt ? `: ${decodeEnt(alt)}` : ''}]`; });
  s = htmlTables(s);
  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n, t) => `\n\n${'#'.repeat(Number(n))} ${t.replace(/<[^>]+>/g, '').trim()}\n\n`)
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|ul|ol|li|section|article|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  s = decodeEnt(s).replace(new RegExp(BR, 'g'), '<br>');
  s = s.split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { md: s, notes: images ? [`HTML 안 그림 ${images}개는 글로 옮기지 못했습니다`] : [], pictPages: [] };
}
function htmlDecode(buf) {
  const head = buf.slice(0, 4096).toString('latin1');
  const cs = ((head.match(/charset\s*=\s*["']?([\w-]+)/i) || [])[1] || 'utf-8').toLowerCase();
  try { return new TextDecoder(cs).decode(buf); } catch { return buf.toString('utf8'); }
}
function notionBodyToMd(body) {
  let s = htmlTables(String(body));
  s = s.replace(/<\/?(callout|details|summary|columns|column|toggle)[^>]*>/gi, '\n').replace(/<br\s*\/?>/gi, '\n');
  s = inlineMd(s).replace(new RegExp(BR, 'g'), '<br>');
  return s.replace(/\n{3,}/g, '\n\n').trim();
}

async function convert(file, ext) {
  const buf = fs.readFileSync(file);
  if (ext === 'docx') return docxToMd(buf);
  if (ext === 'xlsx') return xlsxToMd(buf);
  if (ext === 'pdf') return pdfToMd(file);
  if (ext === 'html' || ext === 'htm') return htmlToMd(htmlDecode(buf));
  if (ext === 'md' || ext === 'txt' || ext === 'csv') return { md: buf.toString('utf8'), notes: [], pictPages: [] };
  throw new Error(`${ext} 파일은 글로 바꾸지 못합니다`);
}

// ---------- 개인정보 가림(공개 약관 외 문서) ----------
const PERSONAL_MAIL = /(gmail|naver|daum|hanmail|kakao|nate|hotmail|outlook|icloud|yahoo|live|me)\.(com|net|co\.kr|kr|co\.jp|jp)$/i;
function mask(md) {
  let n = 0;
  const rep = (re, fn) => { md = md.replace(re, (...a) => { const r = fn(...a); if (r !== a[0]) n++; return r; }); };
  rep(/(?<!\d)\d{6}[- ]?[1-4]\d{6}(?!\d)/g, () => '[주민등록번호 가림]');
  rep(/(?<![\d-])01[016789][-. ]?\d{3,4}[-. ]?\d{4}(?![\d-])/g, () => '[휴대전화 가림]');
  rep(/[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, (m, dom) => (PERSONAL_MAIL.test(dom) ? '[개인 메일 가림]' : m));
  rep(/(?<![\d-])[1-9]\d{1,5}(?:-\d{2,8}){2,4}(?![\d-])/g, (m) => {
    const digits = m.replace(/-/g, '').length;
    if (digits < 10 || digits > 16 || /^\d{3}-\d{2}-\d{5}$/.test(m)) return m; // 사업자등록번호 형식은 둔다
    return '[계좌번호 가림]';
  });
  return { md, n };
}

// ---------- 문서 고르기 ----------
function groupRows(rows) {
  const groups = new Map();
  for (const r of rows) {
    const name = unmd(r['정책서명']);
    const key = `${r['플랫폼'] || ''}|${name}`;
    const row = { id: pageId(r.url), url: `https://app.notion.com/p/${pageId(r.url)}`, 플랫폼: r['플랫폼'] || '', 구분: r['구분'] || '', 정책서명: name,
      버전: unmd(r['버전']), 시행일: r['date:시행일:start'] || '', 비고: unmd(r['비고']), key };
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const current = [];
  const older = [];
  for (const list of groups.values()) {
    list.sort((a, b) => (b.시행일 || '').localeCompare(a.시행일 || '') || verCmp(b.버전, a.버전));
    current.push(list[0]);
    older.push(...list.slice(1));
  }
  return { current, older };
}

function docBase(row) {
  const p = platformShort(row.플랫폼);
  const name = safeName(row.정책서명).startsWith(p) ? row.정책서명 : `${p}_${row.정책서명}`;
  return safeName(`${name}_${row.버전 || '버전없음'}`);
}
function header(row, extra) {
  return [
    '---',
    `문서: ${row.정책서명}`,
    `플랫폼: ${row.플랫폼}`,
    `구분: ${row.구분}`,
    `버전: ${row.버전 || '(없음)'}`,
    `시행일: ${row.시행일 || '(없음)'}`,
    row.비고 ? `비고: ${row.비고}` : null,
    `공개 범위: ${scope(row.구분)}`,
    `Notion: ${row.url}`,
    ...extra,
    `받은 시각: ${kst()} (KST)`,
    '---',
    '',
  ].filter((x) => x !== null).join('\n');
}
function firstTitle(md) {
  for (const line of md.split('\n')) {
    const t = line.replace(/^#+\s*|^[-|>]\s*/g, '').replace(/\|/g, ' ').trim();
    if (t && !/^-+$/.test(t) && !/^시트:/.test(t) && !/^\d+쪽$/.test(t)) return t.slice(0, 60);
  }
  return '';
}

// ---------- 본 작업 ----------
async function main() {
  if (!opt.check) {
    fs.mkdirSync(KB, { recursive: true });
    if (fs.existsSync(LOCK) && Date.now() - fs.statSync(LOCK).mtimeMs < 30 * 60e3) {
      console.log('이미 다른 갱신이 진행 중입니다(30분 안에 시작한 갱신). 잠시 뒤 다시 실행하세요.');
      process.exit(3);
    }
    fs.writeFileSync(LOCK, `${process.pid} ${nowIso()}\n`);
  }
  const unlock = () => { try { fs.rmSync(LOCK, { force: true }); } catch { /* 없음 */ } };
  process.on('exit', () => { if (!opt.check) unlock(); });

  const state = parseJson(fs.existsSync(STATE) ? fs.readFileSync(STATE, 'utf8') : '') || { version: 1, docs: {} };
  const summary = { added: [], changed: [], reconverted: [], same: [], removed: [], failed: [], notes: [], masked: 0, pict: [] };

  // 1) 목록과 페이지 읽기
  const listing = await listAll();
  if (!listing.rows.length) {
    console.log('Notion 데이터베이스를 읽지 못했습니다. Claude의 Notion 연결(claude.ai 커넥터) 상태를 확인하세요.');
    if (listing.run.result?.result) console.log(`Claude 응답: ${String(listing.run.result.result).slice(0, 300)}`);
    if (listing.run.err) console.log(`오류: ${listing.run.err}`);
    process.exit(2);
  }
  const { current, older } = groupRows(listing.rows);
  const pages = listing.pages;
  for (let attempt = 0; attempt < 2; attempt++) {
    const missing = current.filter((r) => !pages.has(r.id));
    if (!missing.length) break;
    const more = await fetchPages(missing.map((r) => r.url), { withFiles: false });
    for (const [k, v] of more.pages) pages.set(k, v);
  }

  // 2) 문서마다 할 일 정하기
  const plans = [];
  for (const row of current) {
    const obj = pages.get(row.id);
    if (!obj) { summary.failed.push(`${row.정책서명} ${row.버전}: Notion 페이지를 읽지 못함`); continue; }
    const page = readPage(obj);
    const prev = state.docs[row.id];
    const ids = page.files.map((f) => f.id).join(',');
    const prevIds = prev ? (prev.files || []).map((f) => f.id).join(',') : null;
    const filesOnDisk = prev && (prev.files || []).every((f) => fs.existsSync(path.join(KB, f.orig)) && fs.existsSync(path.join(KB, f.md)));
    const meta = JSON.stringify([row.정책서명, row.플랫폼, row.구분, row.버전, row.시행일, row.비고]);
    const bodyMd = notionBodyToMd(page.body);
    const bodyHash = bodyMd ? sha(bodyMd) : '';
    let action = 'same';
    if (opt.force || !prev || prevIds !== ids || !filesOnDisk) action = prev ? 'download-changed' : 'download-new';
    else if (prev.meta !== meta || prev.bodyHash !== bodyHash || prev.converter !== CONVERTER_VERSION) action = 'reconvert';
    plans.push({ row, page, prev, action, meta, bodyMd, bodyHash });
  }
  const currentIds = new Set(current.map((r) => r.id));
  const removed = Object.entries(state.docs).filter(([id]) => !currentIds.has(id));

  if (opt.check) {
    const by = (a) => plans.filter((p) => p.action.startsWith(a)).map((p) => `${p.row.정책서명} ${p.row.버전}`);
    console.log(`현행 문서 ${current.length}개(이전 버전 ${older.length}개 제외)`);
    console.log(`새로 받을 문서: ${by('download-new').join(', ') || '없음'}`);
    console.log(`첨부가 바뀌어 다시 받을 문서: ${by('download-changed').join(', ') || '없음'}`);
    console.log(`다시 변환할 문서: ${by('reconvert').join(', ') || '없음'}`);
    console.log(`빠질 문서: ${removed.map(([, d]) => `${d.정책서명} ${d.버전}`).join(', ') || '없음'}`);
    console.log(`그대로: ${by('same').length}개`);
    if (summary.failed.length) console.log(`읽지 못함: ${summary.failed.join(' / ')}`);
    return;
  }
  fs.mkdirSync(CUR, { recursive: true });
  fs.mkdirSync(ORIG, { recursive: true });

  // 3) 첨부 내려받기(몇 문서씩, 링크를 받은 즉시)
  const toDownload = plans.filter((p) => p.action.startsWith('download') && p.page.files.length);
  const downloaded = new Map(); // row.id -> [{file, buf}]
  for (let i = 0; i < toDownload.length; i += BATCH) {
    let batch = toDownload.slice(i, i + BATCH);
    for (let attempt = 0; attempt < 2 && batch.length; attempt++) {
      const got = await fetchPages(batch.map((p) => p.row.url), { withFiles: true });
      const retry = [];
      for (const p of batch) {
        const obj = got.pages.get(p.row.id);
        if (!obj) { retry.push(p); continue; }
        const fresh = readPage(obj);
        const results = [];
        let ok = true;
        for (const f of p.page.files) {
          const url = signedUrl(fresh.refs, f.ref) || signedUrl(fresh.refs, fresh.files.find((x) => x.id === f.id)?.ref || '');
          if (!url) { ok = false; break; }
          try {
            const res = await fetch(url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            results.push({ file: f, buf: Buffer.from(await res.arrayBuffer()) });
          } catch (e) { ok = false; p.error = `내려받기 실패(${e.message})`; break; }
        }
        if (ok) downloaded.set(p.row.id, results); else retry.push(p);
      }
      batch = retry;
    }
    for (const p of batch) summary.failed.push(`${p.row.정책서명} ${p.row.버전}: ${p.error || '내려받기 링크를 받지 못함'}`);
  }

  // 4) 저장·변환
  const removeFiles = (doc) => {
    // 직원이 그림 쪽을 글로 보완한 파일(<이름>.보완.md)도 원본이 바뀌면 함께 지운다
    for (const f of doc?.files || []) for (const rel of [f.orig, f.md, f.md.replace(/\.md$/, '.보완.md')]) { try { fs.rmSync(path.join(KB, rel), { force: true }); } catch { /* 없음 */ } }
    if (doc?.bodyFile) { try { fs.rmSync(path.join(KB, doc.bodyFile), { force: true }); } catch { /* 없음 */ } }
  };
  for (const p of plans) {
    const { row, page, prev } = p;
    const label = `${row.정책서명} ${row.버전}`;
    if (p.action === 'same') { summary.same.push(label); continue; }
    if (p.action.startsWith('download') && page.files.length && !downloaded.has(row.id)) continue; // 실패로 이미 기록함
    try {
      const base = docBase(row);
      const files = [];
      const items = p.action.startsWith('download')
        ? (downloaded.get(row.id) || []).map((d, i) => ({ f: d.file, i, buf: d.buf }))
        : (prev.files || []).map((f, i) => ({ f: { id: f.id, ext: f.ext }, i, buf: fs.readFileSync(path.join(KB, f.orig)) }));
      const many = items.length > 1;
      const staged = [];
      for (const { f, i, buf } of items) {
        const name = many ? `${base}_첨부${i + 1}` : base;
        const origRel = path.join('원본', `${name}.${f.ext}`);
        const mdRel = path.join('현행', `${name}.md`);
        const tmp = path.join(os.tmpdir(), `policy-sync-${process.pid}-${i}.${f.ext}`);
        fs.writeFileSync(tmp, buf);
        let conv;
        try { conv = await convert(tmp, f.ext); } finally { try { fs.rmSync(tmp, { force: true }); } catch { /* 임시 */ } }
        let md = conv.md;
        let masked = 0;
        if (!PUBLIC_KINDS.includes(row.구분)) { const m = mask(md); md = m.md; masked = m.n; }
        const title = conv.title || firstTitle(md);
        const extra = [`원본 파일: ${origRel.replace(/\\/g, '/')}`, many ? `첨부: ${i + 1}/${items.length}${title ? ` (${title})` : ''}` : null,
          masked ? `가린 개인정보: ${masked}건` : null, conv.notes.length ? `글로 옮기지 못한 부분: ${conv.notes.join('; ')}` : null].filter(Boolean);
        staged.push({ origRel, mdRel, buf, text: `${header(row, extra)}${md}\n` });
        files.push({ id: f.id, ext: f.ext, orig: origRel.replace(/\\/g, '/'), md: mdRel.replace(/\\/g, '/'), sha256: sha(buf), title, masked, pictPages: conv.pictPages, notes: conv.notes });
        summary.masked += masked;
        if (conv.pictPages.length) summary.pict.push(`${mdRel.replace(/\\/g, '/')}: ${conv.pictPages.join(', ')}쪽`);
      }
      // 본문(첨부 밖 글)
      let bodyFile = null;
      let bodyText = null;
      if (p.bodyMd && p.bodyMd.replace(/\s/g, '').length >= 20) {
        let md = p.bodyMd;
        let masked = 0;
        if (!PUBLIC_KINDS.includes(row.구분)) { const m = mask(md); md = m.md; masked = m.n; summary.masked += masked; }
        bodyFile = path.join('현행', `${base}${items.length ? '_본문' : ''}.md`).replace(/\\/g, '/');
        bodyText = `${header(row, ['원본: Notion 페이지 본문', masked ? `가린 개인정보: ${masked}건` : null].filter(Boolean))}${md}\n`;
      }
      // 이전 판 파일을 지우고 새로 쓴다(이전 버전은 보관하지 않는다는 대표 결정)
      removeFiles(prev);
      for (const s of staged) { writeAtomic(path.join(KB, s.origRel), s.buf); writeAtomic(path.join(KB, s.mdRel), s.text); }
      if (bodyFile) writeAtomic(path.join(KB, bodyFile), bodyText);
      state.docs[row.id] = { ...row, 공개범위: scope(row.구분), meta: p.meta, bodyHash: p.bodyHash, bodyFile, files, edited: page.edited, converter: CONVERTER_VERSION,
        empty: !files.length && !bodyFile, updated: nowIso() };
      (p.action === 'download-new' ? summary.added : p.action === 'download-changed' ? summary.changed : summary.reconverted).push(label);
    } catch (e) {
      summary.failed.push(`${label}: 변환 실패(${e.message})`);
    }
  }
  for (const [id, doc] of removed) { removeFiles(doc); delete state.docs[id]; summary.removed.push(`${doc.정책서명} ${doc.버전}`); }

  // 5) Notion 데이터 점검(고치지 않고 목록에 표시)
  const checks = [];
  const nameOf = new Map();
  for (const p of plans) {
    const r = p.row;
    if (/faq/i.test(r.정책서명) && r.구분 !== 'FAQ') checks.push(`${r.정책서명} ${r.버전}: 이름은 FAQ인데 구분이 '${r.구분}'입니다`);
    if (!r.시행일) checks.push(`${r.정책서명} ${r.버전}: 시행일이 없습니다`);
    if (!p.page.files.length && !(p.bodyMd && p.bodyMd.replace(/\s/g, '').length >= 20)) checks.push(`${r.정책서명} ${r.버전}: 빈 페이지입니다(첨부·본문 없음)`);
    for (const f of p.page.files) {
      if (!f.origName) continue;
      if (nameOf.has(f.origName) && nameOf.get(f.origName) !== r.id) {
        const other = plans.find((x) => x.row.id === nameOf.get(f.origName))?.row;
        checks.push(`${r.정책서명} ${r.버전}: 같은 이름의 첨부가 「${other?.정책서명} ${other?.버전}」에도 붙어 있습니다(중복 첨부일 수 있음)`);
      } else nameOf.set(f.origName, r.id);
    }
  }

  // 6) 상태·목록·변경기록
  state.version = 1;
  state.updated = nowIso();
  state.checks = checks;
  state.older = older.map((r) => ({ 정책서명: r.정책서명, 플랫폼: r.플랫폼, 버전: r.버전, 시행일: r.시행일 }));
  writeAtomic(STATE, `${JSON.stringify(state, null, 2)}\n`);

  const docs = Object.values(state.docs).sort((a, b) => a.플랫폼.localeCompare(b.플랫폼) || a.구분.localeCompare(b.구분) || a.정책서명.localeCompare(b.정책서명));
  const lines = [
    '# 홍카페 정책 지식창고 목록',
    '',
    `- 마지막 갱신: ${kst()} (KST), 원본: Notion 「정책서 이력 관리」 ${DB_URL}`,
    `- 현행 문서 ${docs.length}개. 문서마다 시행일이 가장 늦은 판만 둔다(이전 버전 ${older.length}개는 넣지 않음, 2026-11-16 대표 결정).`,
    '- 답할 때는 아래 파일을 근거로 쓰고 문서명·버전·시행일을 함께 적는다. 공개 범위가 \'내부용\'인 문서는 카페 글·상담사 공지 등 밖으로 나가는 글에 옮기지 않는다.',
    '- 한 문서에 내용이 겹치면 시행일이 늦은 문서가 우선이다(예: 개별 약관이 통합본보다 늦으면 개별 약관 기준).',
    '',
    '| 플랫폼 | 구분 | 문서 | 버전 | 시행일 | 공개 범위 | 파일 | 참고 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const d of docs) {
    const fileList = [...(d.files || []).map((f) => `${f.md}${f.title ? ` (${f.title.replace(/\|/g, ' ')})` : ''}`), d.bodyFile].filter(Boolean).join('<br>') || '(빈 페이지)';
    const note = [...(d.files || []).flatMap((f) => f.notes || []), ...(d.files || []).filter((f) => f.masked).map((f) => `개인정보 ${f.masked}건 가림`)].join('; ');
    lines.push(`| ${d.플랫폼} | ${d.구분} | [${d.정책서명}](${d.url}) | ${d.버전} | ${d.시행일 || ''} | ${d.공개범위} | ${fileList} | ${note} |`);
  }
  lines.push('', '## Notion 데이터 확인 필요(지식창고는 고치지 않고 그대로 받음)', '', ...(checks.length ? checks.map((c) => `- ${c}`) : ['- 없음']));
  lines.push('', '## 넣지 않은 이전 버전', '', ...(older.length ? older.map((r) => `- ${r.플랫폼} ${r.정책서명} ${r.버전} (${r.시행일 || '시행일 없음'})`) : ['- 없음']), '');
  writeAtomic(INDEX, lines.join('\n'));

  const changedAny = summary.added.length + summary.changed.length + summary.reconverted.length + summary.removed.length + summary.failed.length;
  if (changedAny) {
    const log = [
      `## ${kst()} 갱신`,
      summary.added.length ? `- 추가: ${summary.added.join(', ')}` : null,
      summary.changed.length ? `- 첨부 바뀜: ${summary.changed.join(', ')}` : null,
      summary.reconverted.length ? `- 다시 변환(정보·본문·변환 규칙 변경): ${summary.reconverted.join(', ')}` : null,
      summary.removed.length ? `- 빠짐(새 판으로 교체 또는 Notion에서 사라짐): ${summary.removed.join(', ')}` : null,
      summary.failed.length ? `- 실패: ${summary.failed.join(' / ')}` : null,
      '',
    ].filter((x) => x !== null).join('\n');
    const prevLog = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : '# 홍카페 정책 지식창고 변경기록\n\n';
    writeAtomic(LOG, `${prevLog.trimEnd()}\n\n${log}`);
  }

  console.log(`현행 문서 ${docs.length}개(이전 버전 ${older.length}개 제외)`);
  console.log(`추가 ${summary.added.length} · 첨부 바뀜 ${summary.changed.length} · 다시 변환 ${summary.reconverted.length} · 빠짐 ${summary.removed.length} · 그대로 ${summary.same.length} · 실패 ${summary.failed.length}`);
  for (const [k, v] of [['추가', summary.added], ['첨부 바뀜', summary.changed], ['다시 변환', summary.reconverted], ['빠짐', summary.removed]]) if (v.length) console.log(`${k}: ${v.join(', ')}`);
  if (summary.failed.length) console.log(`실패: ${summary.failed.join(' / ')}`);
  if (summary.masked) console.log(`가린 개인정보: ${summary.masked}건(공개 약관 외 문서의 휴대전화·개인 메일·계좌·주민번호 형식)`);
  if (summary.pict.length) console.log(`그림 위주 PDF 쪽(원본을 직접 보고 보완 필요): ${summary.pict.join(' / ')}`);
  if (checks.length) console.log(`Notion 데이터 확인 필요 ${checks.length}건: 목록.md 참고`);
  console.log(`목록: ${INDEX}`);
  if (summary.failed.length) process.exitCode = 1;
}

main().catch((e) => { console.error(`갱신 중 오류: ${e.message}`); process.exit(1); });
