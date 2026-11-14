/** Text-only paragraph replacement must never flatten rich or nested content. */
export function isEditableParagraph(block) {
  if (!block || block.type !== 'paragraph' || !Array.isArray(block.children) || block.children.length ||
      !Array.isArray(block.content) || block.content.length > 1) return false;
  if (!block.content.length) return true;
  const inline = block.content[0];
  return inline?.type === 'text' && typeof inline.text === 'string' && inline.styles &&
    !Array.isArray(inline.styles) && typeof inline.styles === 'object' && !Object.keys(inline.styles).length &&
    Object.keys(inline).every(k => ['type','text','styles'].includes(k));
}
export const paragraphText = block => isEditableParagraph(block) ? block.content[0]?.text ?? '' : null;
export function stableJson(value) {
  if (Array.isArray(value)) return '['+value.map(stableJson).join(',')+']';
  if (value && typeof value === 'object') return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+stableJson(value[k])).join(',')+'}';
  return JSON.stringify(value);
}
/** Bounded, deterministic change range; common prefix/suffix retained exactly.
 * A single changed span is intentional: no quadratic LCS on long paragraphs. */
export function paragraphDiff(before, after) {
  const a=Array.from(before),b=Array.from(after);let start=0,end=0;
  while(start<a.length && start<b.length && a[start]===b[start])start++;
  while(end<a.length-start && end<b.length-start && a[a.length-1-end]===b[b.length-1-end])end++;
  return {prefix:a.slice(0,start).join(''),removed:a.slice(start,a.length-end).join(''),
    added:b.slice(start,b.length-end).join(''),suffix:end?a.slice(a.length-end).join(''):''};
}
