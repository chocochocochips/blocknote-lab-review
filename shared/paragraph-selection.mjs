import {shortModelName} from './postit-contract.mjs';
/**
 * B-04: General paragraph selection state & context helper functions.
 * Pure ES module with zero external dependencies (runs in both Node and browser).
 */
import { isEditableParagraph, paragraphText } from './block-edit.mjs';

/**
 * Filter selected block IDs against current document blocks so deleted or missing
 * blocks are automatically removed without selecting an arbitrary fallback block.
 */
export function pruneSelectedBlocks(blocks, selectedIds) {
  if (!Array.isArray(blocks) || !Array.isArray(selectedIds) || !selectedIds.length) return [];
  const validIds = new Set(blocks.filter(b => b && typeof b.id === 'string').map(b => b.id));
  const seen = new Set();
  const next = [];
  for (const id of selectedIds) {
    if (typeof id === 'string' && validIds.has(id) && !seen.has(id)) {
      seen.add(id);
      next.push(id);
    }
  }
  return next;
}

/**
 * Toggle a block ID in the ordered selection list (preserving document order).
 */
export function toggleSelectedBlock(blocks, selectedIds, blockId) {
  const current = pruneSelectedBlocks(blocks, selectedIds);
  if ( typeof blockId !== 'string' || !Array.isArray(blocks) || !blocks.some(b => b?.id === blockId)) {
    return current;
  }
  const nextSet = new Set(current);
  if (nextSet.has(blockId)) nextSet.delete(blockId);
  else nextSet.add(blockId);
  return blocks.filter(b => nextSet.has(b.id)).map(b => b.id);
}

/**
 * Extract plain text of any top-level block for copying or AI opinion reference.
 */
export function extractBlockText(block) {
  if (!block || typeof block !== 'object') return '';
  if (isEditableParagraph(block)) return paragraphText(block);
  if (block.type === 'table' && Array.isArray(block.content?.rows)) {
    return block.content.rows.map(row => row.cells
      .map(cell => inlineText(Array.isArray(cell) ? cell : cell.content)).join(' | ')).join('\n');
  }
  return inlineText(block.content);
}

function inlineText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .map(inline => {
      if (!inline || typeof inline !== 'object') return '';
      if (typeof inline.text === 'string') return inline.text;
      if (Array.isArray(inline.content)) {
        return inline.content.map(c => (typeof c?.text === 'string' ? c.text : '')).join('');
      }
      return '';
    })
    .join('');
}

/**
 * Resolve the currently selected block objects in document order.
 */
export function resolveSelectedBlockItems(blocks, selectedIds) {
  const validIds = new Set(pruneSelectedBlocks(blocks, selectedIds));
  if (!validIds.size) return [];
  return blocks
    .filter(b => validIds.has(b.id))
    .map(b => ({
      id: b.id,
      type: b.type,
      text: extractBlockText(b),
      editable: isEditableParagraph(b),
    }));
}

/**
 * Format selected blocks for clipboard copy (Ctrl+C or copy button).
 */
export function formatSelectionClipboard(blocks, selectedIds) {
  const items = resolveSelectedBlockItems(blocks, selectedIds);
  if (!items.length) return '';
  return items.map(item => item.text.trim()).filter(Boolean).join('\n\n');
}

/**
 * Build the explicit question reference scope for B-03/B-04.
 * Invariant:
 * - Never pretends the first paragraph is selected when selectedIds is empty.
 * - Clearly distinguishes whole-document scope ('document') vs selected-paragraph scope ('selection')
 *   vs Post-it re-review scope ('postit').
 */
export function resolveQuestionScope({ blocks = [], selectedIds = [], reaskContext = null, revision = 1 } = {}) {
  if (reaskContext && reaskContext.reaskedFromId) {
    return {
      scopeType: 'postit',
      label: `참고 범위 · 기록 모델 (${shortModelName(reaskContext.model)})`,
      targetIds: [],
      scopeText: reaskContext.scopeText || reaskContext.confirmedContent || '',
      reaskedFromId: reaskContext.reaskedFromId,
      reaskedItemRevision: reaskContext.itemRevision,
      baseRevision: revision,
    };
  }
  const items = resolveSelectedBlockItems(blocks, selectedIds);
  if (!items.length) {
    return {
      scopeType: 'document',
      label: '참고 범위 · 문서 전체',
      targetIds: [],
      scopeText: '',
      reaskedFromId: null,
      baseRevision: revision,
    };
  }
  return {
    scopeType: 'selection',
    label: `참고 범위 · 선택 문단 ${items.length}개`,
    targetIds: items.map(i => i.id),
    scopeText: items.map(i => i.text).join('\n\n'),
    reaskedFromId: null,
    baseRevision: revision,
  };
}
