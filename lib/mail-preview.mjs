// 메일 문안 미리보기: 받는 사람마다 한 통씩 나가는 메일을 한 HTML 파일로 묶어, 발송 전에 넘겨 보며 확인하게 한다.
// 본문은 발송 때와 같은 서식(lib/mail-format.mjs)으로 그린다. 글자는 바꾸지 않는다. 스크립트 없이 열리는 파일이다.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mailHtml } from './mail-format.mjs';

const esc = (text) => String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// 문안 JSON({messages:[{recipients, subject, body}], skipped:[사유]})을 미리보기 항목으로 바꾼다
export function mailPreviewItems(value) {
  const messages = Array.isArray(value?.messages) ? value.messages : [];
  return {
    items: messages.filter((m) => m && typeof m.body === 'string').map((m) => ({
      recipients: Array.isArray(m.recipients) ? m.recipients.filter((r) => typeof r === 'string') : [],
      subject: typeof m.subject === 'string' ? m.subject : '', body: m.body, note: '',
    })),
    skipped: Array.isArray(value?.skipped) ? value.skipped.filter((s) => typeof s === 'string') : [],
  };
}

// 문안 JSON 파일 옆에 두는 미리보기 파일 경로(문안.json → 문안-미리보기.html)
export const mailPreviewPath = (jsonPath) => String(jsonPath).replace(/\.json$/i, '') + '-미리보기.html';

// 파일이 메일 문안 JSON(받는사람이 있는 messages)이면 옆에 미리보기를 쓰고 경로를 돌려준다. 아니거나 실패하면 null(업무 흐름은 막지 않는다)
export function writeMailPreview(jsonPath, title = '') {
  try {
    if (!/\.json$/i.test(jsonPath) || !existsSync(jsonPath)) return null;
    const { items, skipped } = mailPreviewItems(JSON.parse(readFileSync(jsonPath, 'utf8')));
    if (!items.length || !items.every((m) => m.recipients.length)) return null;
    const out = mailPreviewPath(jsonPath);
    writeFileSync(out, mailPreviewHtml({ title: `메일 미리보기${title ? ` · ${String(title).slice(0, 60)}` : ''}`, items, skipped }));
    return out;
  } catch { return null; }
}

// items: [{recipients, subject, body, note}] · note는 "이번에 보냄"·"이미 보냄"처럼 목록에 붙일 짧은 상태(없어도 된다)
export function mailPreviewHtml({ title = '메일 미리보기', items = [], skipped = [], summary = '' } = {}) {
  const list = items.map((m, i) => `<li><a href="#m${i + 1}"><b>${i + 1}. ${esc(m.subject || '(제목 없음)')}</b><span>${esc(m.recipients.join(', ') || '받는사람 없음')}${m.note ? ` · ${esc(m.note)}` : ''}</span></a></li>`).join('');
  const cards = items.map((m, i) => `<section id="m${i + 1}"><header><span class="no">${i + 1} / ${items.length}</span>${m.note ? `<span class="note">${esc(m.note)}</span>` : ''}
<h2>${esc(m.subject || '(제목 없음)')}</h2><p>받는사람 ${esc(m.recipients.join(', ') || '없음')}</p></header>
<div class="body">${mailHtml(m.body) || `<div class="plain">${esc(m.body)}</div>`}</div><a class="top" href="#top">맨 위로</a></section>`).join('\n');
  const skip = skipped.length ? `<section class="skip"><h2>보내지 않는 대상 ${skipped.length}건</h2><ul>${skipped.map((s) => `<li>${esc(s)}</li>`).join('')}</ul></section>` : '';
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>
*{box-sizing:border-box}body{margin:0;background:#f4f2ee;color:#20201e;font-family:"Malgun Gothic","Apple SD Gothic Neo",sans-serif;line-height:1.6}
.wrap{max-width:1120px;margin:0 auto;padding:28px 20px 80px;display:grid;grid-template-columns:320px minmax(0,1fr);gap:24px;align-items:start}
h1{font-size:22px;margin:0 0 4px}.sum{color:#64635e;font-size:14px;margin:0}
.head{grid-column:1/-1}
nav{position:sticky;top:16px;max-height:calc(100vh - 32px);overflow:auto;background:#fff;border:1px solid #e3e0d8;border-radius:12px;padding:8px}
nav ol{list-style:none;margin:0;padding:0}nav a{display:block;padding:8px 10px;border-radius:8px;text-decoration:none;color:inherit;font-size:14px}nav a:hover{background:#f6f3ee}
nav b{display:block;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}nav span{display:block;color:#64635e;font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
section{background:#fff;border:1px solid #e3e0d8;border-radius:12px;padding:22px 26px;margin-bottom:18px;min-width:0}
section header{border-bottom:1px solid #e3e0d8;padding-bottom:12px;margin-bottom:16px}
section h2{font-size:17px;margin:6px 0 2px;word-break:keep-all}section header p{margin:0;color:#64635e;font-size:13.5px;word-break:break-all}
.no{font-size:12.5px;color:#64635e}.note{display:inline-block;margin-left:8px;padding:1px 9px;border-radius:999px;background:#f6f3ee;font-size:12.5px;font-weight:700}
.plain{white-space:pre-wrap;font-size:14px;line-height:1.75}.body{overflow-x:auto}
.top{display:inline-block;margin-top:14px;font-size:12.5px;color:#64635e}.skip ul{margin:0;padding-left:20px;font-size:14px}
@media(max-width:820px){.wrap{grid-template-columns:1fr}nav{position:static;max-height:240px}}
</style></head><body><div class="wrap" id="top"><div class="head"><h1>${esc(title)}</h1><p class="sum">메일 ${items.length}통${skipped.length ? ` · 보내지 않는 대상 ${skipped.length}건` : ''}${summary ? ` · ${esc(summary)}` : ''}</p></div>
<nav><ol>${list}</ol></nav><main>${cards}${skip}</main></div></body></html>
`;
}
