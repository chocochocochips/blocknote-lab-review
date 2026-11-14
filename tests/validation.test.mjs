/** B-01 contract tests. Prepared only; do not run before F-01. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LIMITS, validateWriteRequest, validateBlocks, validateStoredDocumentSize,
  validatePlainText, validateAfterId,
} from '../server/validation.mjs';

const block = (id, children = [], type = 'paragraph', props = {}) => ({
  id, type, props, content: [{ type: 'text', text: '안녕하세요', styles: {} }], children,
});
const expectCode = (fn, code, status = 422) => assert.throws(fn, err => {
  assert.equal(err.code, code);
  assert.equal(err.status, status);
  return true;
});

test('루트/자식 포함 블록 ID는 전역 유일해야 한다', () => {
  expectCode(() => validateBlocks([block('same', [block('same')])]), 'DUPLICATE_BLOCK_ID');
  assert.equal(validateBlocks([block('a', [block('b')]), block('c')]).count, 3);
});

test('루트 깊이 0, 최대 깊이 8, 깊이 9는 거절', () => {
  const make = maxDepth => {
    let node = block(`node-${maxDepth}`);
    for (let d = maxDepth - 1; d >= 0; d--) node = block(`node-${d}`, [node]);
    return [node];
  };
  assert.equal(validateBlocks(make(8)).count, 9);
  expectCode(() => validateBlocks(make(9)), 'INVALID_BLOCKS');
});

test('전체 블록 수는 루트 수와 무관하게 최대 1000', () => {
  assert.equal(validateBlocks([block('root', Array.from({ length: 999 }, (_, i) => block(`c-${i}`)))]).count, 1000);
  expectCode(() => validateBlocks([block('root', Array.from({ length: 1000 }, (_, i) => block(`c-${i}`)))]), 'INVALID_BLOCKS');
});

test('props, content, children, heading.level의 구조를 검사', () => {
  expectCode(() => validateBlocks([{ ...block('a'), props: [] }]), 'INVALID_BLOCKS');
  expectCode(() => validateBlocks([{ ...block('a'), content: 'plain' }]), 'INVALID_CONTENT');
  expectCode(() => validateBlocks([{ ...block('a'), children: null }]), 'INVALID_BLOCKS');
  expectCode(() => validateBlocks([block('a', [], 'heading', { level: 4 })]), 'INVALID_BLOCKS');
  expectCode(() => validateBlocks([block('a', [], 'table')]), 'INVALID_TABLE');
});

test('편집기가 생성한 구분선은 content 없이 저장할 수 있다', () => {
  const divider = { id: 'divider', type: 'divider', props: {}, children: [] };
  assert.equal(validateBlocks([block('before'), divider, block('after')]).count, 3);
  expectCode(() => validateBlocks([{ ...divider, content: block('text').content }]), 'INVALID_CONTENT');
});

test('붙여넣은 표의 셀, 머리글 및 너비를 검증한다', () => {
  const table = { ...block('table', [], 'table'), content: {
    type: 'tableContent', columnWidths: [null], headerRows: 1,
    rows: [{ cells: [{ type: 'tableCell', props: { colspan: 1, rowspan: 1 }, content: block('cell').content }] }],
  } };
  assert.equal(validateBlocks([table]).count, 1);
  table.content.rows[0].cells[0].props.colspan = 2;
  expectCode(() => validateBlocks([table]), 'INVALID_TABLE');
});

test('서식 있는 text 인라인은 보존하고 미지원 인라인 형태를 추측해 거부하지 않음', () => {
  const rich = block('rich');
  rich.content = [
    { type: 'text', text: '중요', styles: { bold: true } },
    { type: 'link', href: 'https://example.test', content: [{ type: 'text', text: '링크', styles: {} }] },
  ];
  assert.equal(validateBlocks([rich]).count, 1);
});

test('revision과 actor는 요청 메타데이터이고 actor는 신원 검증 수단이 아니다', () => {
  assert.equal(validateWriteRequest({ revision: 1 }, 'agent'), 'agent');
  assert.equal(validateWriteRequest({ revision: 2, actor: '검토자-1' }, 'agent'), '검토자-1');
  expectCode(() => validateWriteRequest({ revision: 0 }, 'agent'), 'INVALID_REVISION', 400);
  expectCode(() => validateWriteRequest({ revision: 1.5 }, 'agent'), 'INVALID_REVISION', 400);
  expectCode(() => validateWriteRequest({ revision: Number.MAX_SAFE_INTEGER + 1 }, 'agent'), 'INVALID_REVISION', 400);
  expectCode(() => validateWriteRequest({ revision: 1, actor: '!' }, 'agent'), 'INVALID_ACTOR');
});

test('단일 텍스트와 afterId 유효성', () => {
  validatePlainText('x'.repeat(LIMITS.contentLength));
  expectCode(() => validatePlainText('x'.repeat(LIMITS.contentLength + 1)), 'INVALID_CONTENT');
  validateAfterId(null);
  expectCode(() => validateAfterId(12), 'INVALID_BLOCK_ID');
});

test('최종 문서의 UTF-8 저장 크기는 pretty JSON 기준 1MB 제한', () => {
  const doc = { id: 'board-lab', revision: 1, updatedAt: '2026-10-31T00:00:00.000Z', blocks: [block('root')] };
  assert.ok(validateStoredDocumentSize(doc) < LIMITS.documentBytes);
  doc.blocks[0].content[0].text = '가'.repeat(350_000); // 1,050,000 UTF-8 bytes
  expectCode(() => validateStoredDocumentSize(doc), 'DOCUMENT_TOO_LARGE');
});
