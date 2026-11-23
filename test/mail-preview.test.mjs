// 메일 미리보기: 문안 JSON을 발송 때와 같은 서식의 한 파일로 묶는다(글자는 바꾸지 않는다)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mailPreviewHtml, mailPreviewItems } from '../lib/mail-preview.mjs';

const formatted = '안녕하세요.\n\n■ 한눈에 보기\n· 상담  48건 (최근 30일)\n· 후기  12건\n\n1. 접속 시간을 맞춰 보세요\n저녁 시간대에 상담이 많이 들어옵니다.';

test('문안 JSON에서 메일과 보내지 않는 대상을 뽑는다', () => {
  const { items, skipped } = mailPreviewItems({ messages: [{ recipients: ['a@example.invalid'], subject: '제목', body: '본문' }, { subject: 3 }, null], skipped: ['주소 없음: 가상별', 7] });
  assert.equal(items.length, 1);
  assert.deepEqual(items[0].recipients, ['a@example.invalid']);
  assert.deepEqual(skipped, ['주소 없음: 가상별']);
  assert.deepEqual(mailPreviewItems(null), { items: [], skipped: [] });
});

test('메일마다 받는사람·제목·서식 입힌 본문과 목록 링크가 들어간다', () => {
  const html = mailPreviewHtml({ title: '11월 리포트', items: [
    { recipients: ['a@example.invalid'], subject: '[홍카페] 가상별 상담사님, 11월 활동 리포트입니다', body: formatted, note: '이번에 보냄' },
    { recipients: ['b@example.invalid'], subject: '두 번째', body: '서식 없는 본문\n둘째 줄', note: '다음 차례' },
  ], skipped: ['주소를 찾지 못함: 가상달'], summary: '이번에 1통' });
  assert.match(html, /메일 2통 · 보내지 않는 대상 1건 · 이번에 1통/);
  assert.match(html, /href="#m1"/);
  assert.match(html, /id="m2"/);
  assert.match(html, /받는사람 a@example\.invalid/);
  assert.match(html, /border-left:4px solid/, '서식 단서가 있는 본문은 발송 때와 같은 서식으로 그린다');
  assert.match(html, /<div class="plain">서식 없는 본문\n둘째 줄<\/div>/, '서식 단서가 없으면 글자 그대로 보인다');
  assert.match(html, /이번에 보냄/);
  assert.match(html, /주소를 찾지 못함: 가상달/);
  assert.doesNotMatch(html, /<script/i, '스크립트 없이 열리는 파일이다');
});

test('본문과 제목의 꺾쇠·따옴표는 글자로만 보인다', () => {
  const html = mailPreviewHtml({ items: [{ recipients: ['x@example.invalid'], subject: '<b>제목</b>', body: '<img src=x onerror=alert(1)>', note: '' }] });
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /&lt;b&gt;제목&lt;\/b&gt;/);
});
