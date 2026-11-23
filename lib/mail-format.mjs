// 메일 본문(검토된 글자 원문)을 읽기 좋은 서식으로 꾸민다. 글자는 바꾸지 않는다.
// 공백을 뺀 글자 순서가 원문과 같아야 발송 전후의 원문 대조(본문 1회 입력, 보낸 메일 확인)가 그대로 동작한다.
// 서식 단서가 없는 본문은 null을 돌려주고, 그때는 예전처럼 글자만 넣는다.
//
// 단서(줄 단위)
//   "■ 제목"            구획 제목: 굵게, 왼쪽 강조선, 옅은 배경(■는 강조색)
//   "· 라벨  값"        요약 줄(라벨과 값 사이 공백 2칸 이상): 이어진 줄을 테두리 있는 2칸 표로, 값은 굵게, 값의 괄호(기준 기간)는 옅게
//   "1. 할 일"          번호 줄: 굵게. 바로 아래 이어지는 줄(설명)과 함께 강조선이 있는 상자 하나로 묶는다
//   "- 내용" / "· 내용"  목록 줄: 들여쓰기
const HEADING = /^■\s*\S/;
const SUMMARY = /^(·\s*\S.*?)\s{2,}(\S.*)$/;
const NUMBERED = /^\d{1,2}[.)]\s+\S/;
const BULLET = /^[-·]\s+\S/;

const INK = '#20201e', MUTED = '#64635e', ACCENT = '#bf2436', TINT = '#f6f3ee', LINE = '#e3e0d8';
const escapeHtml = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const hasMailFormat = (body) => String(body || '').split(/\r?\n/).some((line) => HEADING.test(line.trim()) || SUMMARY.test(line.trim()));

// 값 안의 괄호(기준 기간 등)는 옅게, 나머지는 굵게 보인다. 글자와 순서는 그대로다
const valueHtml = (value) => value.split(/(\([^()]*\))/).map((part) => (/^\([^()]*\)$/.test(part)
  ? `<span style="font-weight:400;font-size:13px;color:${MUTED}">${escapeHtml(part)}</span>` : escapeHtml(part))).join('');

export function mailHtml(body) {
  if (!hasMailFormat(body)) return null;
  const lines = String(body).split(/\r?\n/).map((line) => line.trim());
  const plain = (line) => line && !HEADING.test(line) && !SUMMARY.test(line) && !NUMBERED.test(line) && !BULLET.test(line);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) { out.push('<div style="line-height:1.2"><br></div>'); continue; }
    if (HEADING.test(line)) {
      const mark = line[0], rest = line.slice(1);
      out.push(`<div style="margin:22px 0 10px;padding:9px 14px;border-left:4px solid ${ACCENT};background:${TINT};font-size:16px;font-weight:700;color:${INK}"><span style="color:${ACCENT}">${escapeHtml(mark)}</span>${escapeHtml(rest)}</div>`);
      continue;
    }
    if (SUMMARY.test(line)) {
      const rows = [];
      for (; i < lines.length && SUMMARY.test(lines[i]); i++) {
        const [, label, value] = lines[i].match(SUMMARY);
        const edge = rows.length ? `border-top:1px solid ${LINE};` : '';
        rows.push(`<tr><td style="${edge}padding:9px 14px;width:38%;background:${TINT};color:${MUTED};font-size:14px;vertical-align:top">${escapeHtml(label)}</td>`
          + `<td style="${edge}padding:9px 14px;font-size:15px;font-weight:700;color:${INK};vertical-align:top">${valueHtml(value)}</td></tr>`);
      }
      i--;
      out.push(`<table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:separate;border-spacing:0;border:1px solid ${LINE};margin:4px 0 12px"><tbody>${rows.join('')}</tbody></table>`);
      continue;
    }
    if (NUMBERED.test(line)) {
      const notes = [];
      while (i + 1 < lines.length && plain(lines[i + 1])) notes.push(`<div style="margin-top:4px;font-size:14px;color:${MUTED}">${escapeHtml(lines[++i])}</div>`);
      out.push(`<div style="margin:10px 0;padding:12px 16px;border:1px solid ${LINE};border-left:4px solid ${ACCENT}"><div style="font-size:15px;font-weight:700;color:${INK}">${escapeHtml(line)}</div>${notes.join('')}</div>`);
      continue;
    }
    if (BULLET.test(line)) { out.push(`<div style="padding-left:12px">${escapeHtml(line)}</div>`); continue; }
    out.push(`<div>${escapeHtml(line)}</div>`);
  }
  return `<div style="max-width:640px;font-family:'Malgun Gothic','Apple SD Gothic Neo',sans-serif;font-size:15px;line-height:1.75;color:${INK}">${out.join('')}</div>`;
}

// 서식의 보이는 글자(검사·테스트용): 태그를 빼고 글자 참조를 되돌린다
export const mailHtmlText = (html) => String(html || '').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
