// Presentation preferences never enter the document or its audit history.
export const SKINS = [['desk','책상'],['chalk','칠판'],['cafe','카페'],['concrete','콘크리트']];
export function readPreference(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
export function writePreference(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}
export function orderedDocuments(documents, ids) {
  const rank = new Map((Array.isArray(ids) ? ids : []).map((id,i)=>[id,i]));
  return [...documents].sort((a,b)=>(rank.get(a.id)??Infinity)-(rank.get(b.id)??Infinity));
}
export function moveId(ids, source, target) {
  if(source===target || !ids.includes(source) || !ids.includes(target)) return [...ids];
  const next=ids.filter(id=>id!==source);next.splice(ids.indexOf(target),0,source);return next;
}
export {fontSize} from '../../shared/font-size.mjs';
