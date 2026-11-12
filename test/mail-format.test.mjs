import test from 'node:test';
import assert from 'node:assert/strict';
import { hasMailFormat, mailHtml, mailHtmlText } from '../lib/mail-format.mjs';

const squash = (text) => String(text).replace(/\s+/g, '');
const BODY = [
  '가상별 상담사님, 안녕하세요.',
  '담당 매니저입니다.',
  '',
  '■ 한눈에 보기',
  '· 상담  5건 (최근 30일)',
  '· 평균 상담 시간  26분 28초',
  '',
  '■ 이번 달 함께 해 보면 좋은 것',
  '1. 접속 시간을 정해 주세요',
  '접속해 계셔야 상담이 연결됩니다.',
  '2) 단골 고객께 후기를 부탁해 보세요',
  '- 상담 뒤 안부 인사 <예시> & "한 줄"',
  '',
  '감사합니다.',
].join('\n');

test('서식 단서가 없는 본문은 꾸미지 않는다', () => {
  for (const plain of ['안녕하세요.\n제휴를 제안드립니다.\n\n감사합니다.', '1. 첫째\n2. 둘째', '- 목록만 있는 글', '· 가운뎃점 한 칸 값', '', null]) {
    assert.equal(hasMailFormat(plain), false, String(plain));
    assert.equal(mailHtml(plain), null);
  }
  assert.equal(hasMailFormat('■ 제목'), true);
  assert.equal(hasMailFormat('· 상담  5건'), true, '라벨과 값 사이 공백 2칸');
});

test('글자는 그대로 두고 구획 제목·요약 표·번호 줄만 꾸민다', () => {
  const html = mailHtml(BODY);
  assert.equal(squash(mailHtmlText(html)), squash(BODY), '공백을 뺀 글자 순서가 원문과 같다(원문 대조용)');
  assert.match(html, /<div style="[^"]*border-left:4px solid[^"]*font-weight:700[^"]*">■ 한눈에 보기<\/div>/);
  assert.equal(html.split('<table').length - 1, 1, '이어진 요약 줄은 표 하나로 묶는다');
  assert.equal(html.split('<tr>').length - 1, 2);
  assert.match(html, /<td style="[^"]*white-space:nowrap[^"]*">· 상담<\/td><td style="[^"]*font-weight:700[^"]*">5건 \(최근 30일\)<\/td>/);
  assert.match(html, /<div style="margin-top:10px;font-weight:700[^"]*">1\. 접속 시간을 정해 주세요<\/div><div style="padding-left:18px[^"]*">접속해 계셔야 상담이 연결됩니다\.<\/div>/);
  assert.match(html, /font-weight:700[^"]*">2\) 단골 고객께 후기를 부탁해 보세요<\/div>/);
  assert.match(html, /- 상담 뒤 안부 인사 &lt;예시&gt; &amp; &quot;한 줄&quot;/, '꺾쇠·따옴표는 글자로 남긴다');
  assert.doesNotMatch(html, /<script|javascript:|onerror|<img|<a /i);
  assert.match(html, /<div>감사합니다\.<\/div><\/div>$/, '번호 줄 뒤 빈 줄 다음은 보통 줄');
});

test('본문에 든 태그 모양 글자는 태그가 되지 않는다', () => {
  const html = mailHtml('■ 안내\n<script>alert(1)</script>\n<img src=x onerror=alert(1)>');
  assert.doesNotMatch(html, /<script|<img/i);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});
