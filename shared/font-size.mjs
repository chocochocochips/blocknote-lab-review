/** Canonical font-size values written by the Phase 2 editor (CSS pixels).
 * Keep normalization identical for controls, HTML import and backup inspection.
 * Inspection must reject, rather than clamp or coerce, untrusted backup values.
 */
export const FONT_SIZE_MIN = 12;
export const FONT_SIZE_MAX = 36;
export const FONT_SIZE_DEFAULT = 17;

export function fontSize(value) {
  return Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, Number(value) || FONT_SIZE_DEFAULT));
}

export function isEditorFontSize(value) {
  if (typeof value !== 'string') return false;
  const number = Number(value);
  return Number.isFinite(number) && number >= FONT_SIZE_MIN && number <= FONT_SIZE_MAX &&
    value === String(number);
}
