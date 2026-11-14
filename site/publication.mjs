import { createHash, createHmac } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { LIMITS, RequestError } from '../server/validation.mjs';

const fail = (status, code, message) => { throw new RequestError(status, code, message); };
const escapeMarkdown = text => text.replace(/[\x00-\x1f\x7f]/g, ' ')
  .replace(/[\\`*_\[\]#|>~<&]/g, '\\$&')
  .replace(/^(\s*)([-+=]|\d+[.)])(?=\s|$)/, (_, indent, marker) =>
    indent + marker.slice(0, -1) + '\\' + marker.at(-1));
const formatText = text => text.split(/\r\n|[\r\n]/).map(escapeMarkdown).join('<br>');
function longestBackticks(text) {
  let max = 0;
  for (const [run] of text.matchAll(/`+/g)) max = Math.max(max, run.length);
  return max;
}

function formatInline(inline, depth = 0) {
  if (inline?.type === 'text' && typeof inline.text === 'string') {
    const { text, styles = {} } = inline;
    if (!text.trim()) return formatText(text);
    const leading = text.match(/^\s*/)[0], trailing = text.match(/\s*$/)[0];
    const core = text.trim();
    let value = formatText(core);
    if (styles.code) {
      const fence = '`'.repeat(longestBackticks(core) + 1);
      value = fence + ' ' + core.replace(/[\r\n]/g, ' ') + ' ' + fence;
    }
    if (styles.bold) value = '**' + value + '**';
    if (styles.italic) value = '*' + value + '*';
    if (styles.strike) value = '~~' + value + '~~';
    if (styles.underline) value = '<u>' + value + '</u>';
    return formatText(leading) + value + formatText(trailing);
  }
  if (inline?.type === 'link' && Array.isArray(inline.content) && depth === 0) {
    const label = inline.content.map(item => formatInline(item, depth + 1)).join('');
    let url;
    try { url = new URL(inline.href); } catch { return label; }
    if (!['https:', 'http:', 'mailto:'].includes(url.protocol) || url.username || url.password) return label;
    return '[' + label + '](<' + url.href.replace(/[<>\\]/g, char => encodeURIComponent(char)) + '>)';
  }
  fail(422, 'UNSUPPORTED_PUBLICATION_CONTENT', '지원하지 않는 인라인 서식이 있어 Markdown으로 발행할 수 없어요.');
}

function formatTable(table) {
  const cols = table.columnWidths.length;
  const coveredThrough = Array(cols).fill(-1);
  const rows = table.rows.map((row, index) => {
    let column = 0;
    const cells = Array(cols).fill('');
    for (const cell of row.cells) {
      while (column < cols && coveredThrough[column] >= index) column++;
      const { colspan = 1, rowspan = 1 } = cell.props ?? {};
      if (column + colspan > cols || coveredThrough.slice(column, column + colspan).some(end => end >= index)) {
        fail(422, 'UNSUPPORTED_PUBLICATION_CONTENT', '표의 병합 셀 구조를 Markdown으로 변환할 수 없어요.');
      }
      const content = Array.isArray(cell) ? cell : cell.content;
      cells[column] = content.map(item => formatInline(item)).join('').replace(/(?<!\\)\|/g, '\\|');
      for (let i = column; i < column + colspan; i++) coveredThrough[i] = index + rowspan - 1;
      column += colspan;
    }
    return cells;
  });
  const header = table.headerRows ? rows.shift() : Array(cols).fill('');
  return [header, Array(cols).fill('---'), ...rows].map(row => '| ' + row.join(' | ') + ' |').join('\n');
}

function formatMultilineParagraph(content) {
  if (!content.every(item => item?.type === 'text' && typeof item.text === 'string'
    && !Object.values(item.styles ?? {}).some(Boolean))) return null;

  const lines = content.map(item => item.text).join('').split(/\r\n|[\r\n]/);
  if (lines.length === 1) return null;

  const output = [];
  let previous = '';
  for (const line of lines) {
    if (!line.trim()) {
      output.push('');
      previous = '';
      continue;
    }
    const numbered = /^ {0,3}(\d{1,9}[.)])[ \t]+(\S.*)$/.exec(line);
    const kind = numbered ? 'numbered' : 'text';
    if (previous && previous !== kind) output.push('');
    if (kind === 'text' && previous === 'text') output[output.length - 1] += '  ';
    const plain = line.trim();
    output.push(numbered
      ? numbered[1] + ' ' + escapeMarkdown(numbered[2].trimEnd())
      : (/^(-{2,}|={2,})$/.test(plain) ? '\\' : '') + escapeMarkdown(plain));
    previous = kind;
  }
  return output.join('\n');
}

function formatBlocks(blocks) {
  let ordinal = 0;
  return blocks.map(block => {
    ordinal = block.type === 'numberedListItem' ? ordinal + 1 : 0;
    const multiline = block.type === 'paragraph' && Array.isArray(block.content)
      ? formatMultilineParagraph(block.content) : null;
    const content = multiline ?? (Array.isArray(block.content) && block.type !== 'codeBlock'
      ? block.content.map(item => formatInline(item)).join('') : '');
    const children = formatBlocks(block.children);
    let line, continuation = '';
    switch (block.type) {
      case 'paragraph': line = content; break;
      case 'divider': line = '---'; break;
      case 'table': line = formatTable(block.content); break;
      case 'heading': line = '#'.repeat(block.props.level + 1) + ' ' + content; break;
      case 'quote': line = '> ' + content; break;
      case 'bulletListItem':
      case 'toggleListItem': line = '- ' + content; continuation = '  '; break;
      case 'numberedListItem': {
        const marker = ordinal + '. ';
        line = marker + content;
        continuation = ' '.repeat(marker.length);
        break;
      }
      case 'checkListItem': line = '- [' + (block.props.checked ? 'x' : ' ') + '] ' + content; continuation = '  '; break;
      case 'codeBlock': {
        if (block.content.some(item => item?.type !== 'text' || typeof item.text !== 'string')) {
          fail(422, 'UNSUPPORTED_PUBLICATION_CONTENT', '코드 블록에 지원하지 않는 내용이 있어요.');
        }
        const code = block.content.map(item => item.text).join('');
        const fence = '`'.repeat(Math.max(3, longestBackticks(code) + 1));
        const lang = typeof block.props.language === 'string' && /^[a-z\d_+-]+$/i.test(block.props.language) ? block.props.language : '';
        line = fence + lang + '\n' + code + '\n' + fence;
        break;
      }
      default: fail(422, 'UNSUPPORTED_PUBLICATION_CONTENT', '지원하지 않는 문단이 있어 Markdown으로 발행할 수 없어요.');
    }
    if (!children) return line;
    if (!continuation) return line + '\n\n' + children;
    return line + '\n\n' + children.split('\n').map(row => row && continuation + row).join('\n');
  }).filter(Boolean).join('\n\n');
}

export function documentMarkdown(title, blocks) {
  return '# ' + escapeMarkdown(title) + '\n\n' + formatBlocks(blocks).trimEnd() + '\n';
}

// Approval is tied to the exact saved document, user, and publication mode.
export function publicationSnapshot(workspace, id, userId, signingKey) {
  const meta = workspace.metadata(id);
  if (meta.archived) fail(409, 'DOCUMENT_ARCHIVED', '보관된 문서를 먼저 복원하세요.');
  const doc = workspace.get(id).storage.readDocument();
  const markdown = documentMarkdown(meta.title, doc.blocks);
  if (Buffer.byteLength(markdown) > LIMITS.documentBytes) {
    fail(413, 'PUBLICATION_TOO_LARGE', 'Markdown이 발행 크기 한도를 초과했어요.');
  }
  const testMode = !signingKey;
  const digest = (testMode ? createHash('sha256') : createHmac('sha256', signingKey))
    .update(JSON.stringify(['blocknote-publication-v1', testMode, userId, id, doc.revision, meta.metadataVersion, markdown])).digest('hex');
  return { revision: doc.revision, title: meta.title, markdown, digest, testMode };
}

// The storage adapter receives the public payload only after approval and a freshness check.
export async function approvePublication({ body, preview, destination, key }) {
  if (body?.confirmed !== true || typeof body.digest !== 'string') {
    fail(409, 'PUBLICATION_CONFIRM_REQUIRED', 'Markdown 미리보기를 확인하고 승인하세요.');
  }
  const check = async () => {
    const snapshot = await preview();
    if (body.testMode !== snapshot.testMode || body.digest !== snapshot.digest) {
      fail(409, 'PUBLICATION_PREVIEW_CHANGED', '문서나 발행 설정이 바뀌었어요. 미리보기를 다시 열어 주세요.');
    }
    return snapshot;
  };
  const snapshot = await check();
  if (snapshot.testMode) return { testMode: true, revision: snapshot.revision };
  const { publicUrl, unchanged } = await destination.publish({
    key, markdown: snapshot.markdown, verifyCurrent: check,
  });
  return { testMode: false, publicUrl, unchanged, revision: snapshot.revision };
}

export const publicationKey = (userId, id) =>
  createHash('sha256').update(JSON.stringify([userId, id])).digest('hex');
