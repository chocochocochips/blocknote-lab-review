/** Shared validation for user-authored model questions. Length is UTF-16 code units. */
export const GOAL_MAX_LENGTH = 240;
export function validGoal(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= GOAL_MAX_LENGTH &&
    !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
}
