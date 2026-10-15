/**
 * Prefix of `EvalResult.rationale` on a row whose scorer could not score (a
 * judge with no rubric, a failed call, a refused budget). Such a row's `value`
 * is a neutral placeholder, not a measurement: the eval node writes the prefix
 * and the trends endpoint leaves the row out of its means. A plain string
 * column rather than a JSON path, so the filter's handling of NULL is plain SQL.
 */
export const EVAL_SCORER_ERROR_PREFIX = 'scorer error: ';
