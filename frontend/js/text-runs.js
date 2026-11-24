/**
 * Стилизованные фрагменты текста (runs).
 * Объект хранит `content` и необязательный `runs`; если runs пуст,
 * весь текст рисуется базовым стилем объекта.
 */

export const TEXT_STYLE_KEYS = ['color', 'fontSize', 'fontFamily', 'bold', 'italic', 'underline'];
export const TEXT_FONT_FAMILIES = new Set(['sans', 'serif', 'mono', 'hand', 'narrow']);

const DEFAULT_COLOR = '#111827';
const DEFAULT_FONT_SIZE = 24;
const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 200;

export function normalizeFontSize(value) {
  const parsed = Math.round(Number(value));
  if (!Number.isFinite(parsed)) return DEFAULT_FONT_SIZE;
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, parsed));
}

export function normalizeFontFamily(value) {
  return TEXT_FONT_FAMILIES.has(value) ? value : 'sans';
}

export function normalizeColor(value) {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value)
    ? value.toLowerCase()
    : null;
}

export function textBaseStyle(object = {}) {
  return {
    color: normalizeColor(object.color) ?? DEFAULT_COLOR,
    fontSize: normalizeFontSize(object.fontSize),
    fontFamily: normalizeFontFamily(object.fontFamily),
    bold: Boolean(object.bold),
    italic: Boolean(object.italic),
    underline: Boolean(object.underline),
  };
}

export function normalizeTextStyle(style = {}, base = {}) {
  const fallback = { ...textBaseStyle({}), ...base };
  return {
    color: normalizeColor(style.color) ?? normalizeColor(fallback.color) ?? DEFAULT_COLOR,
    fontSize: normalizeFontSize(style.fontSize ?? fallback.fontSize),
    fontFamily: normalizeFontFamily(style.fontFamily ?? fallback.fontFamily),
    bold: style.bold === undefined ? Boolean(fallback.bold) : Boolean(style.bold),
    italic: style.italic === undefined ? Boolean(fallback.italic) : Boolean(style.italic),
    underline: style.underline === undefined ? Boolean(fallback.underline) : Boolean(style.underline),
  };
}

export function sameTextStyle(left = {}, right = {}) {
  return TEXT_STYLE_KEYS.every((key) => left[key] === right[key]);
}

export function runStyle(run = {}) {
  const style = {};
  for (const key of TEXT_STYLE_KEYS) style[key] = run[key];
  return style;
}

export function mergeRuns(runs) {
  const merged = [];
  for (const run of runs) {
    if (!run?.text) continue;
    const last = merged[merged.length - 1];
    if (last && sameTextStyle(last, run)) last.text += run.text;
    else merged.push({ ...run });
  }
  return merged;
}

/** Полное покрытие content фрагментами; при рассинхроне — один базовый фрагмент. */
export function materializeRuns(content, runs, base = {}) {
  const text = String(content ?? '');
  if (!text) return [];
  const source = Array.isArray(runs) ? runs : [];
  if (source.length) {
    const joined = source.map((run) => String(run?.text ?? '')).join('');
    if (joined === text) {
      return mergeRuns(
        source.map((run) => ({
          text: String(run.text),
          ...normalizeTextStyle(run, base),
        })),
      );
    }
  }
  return mergeRuns([{ text, ...normalizeTextStyle(base, base) }]);
}

export function styleAtOffset(content, runs, base, offset) {
  const list = materializeRuns(content, runs, base);
  const target = Math.max(0, Number(offset) || 0);
  let position = 0;
  for (const run of list) {
    const end = position + run.text.length;
    if (target < end) return runStyle(run);
    position = end;
  }
  return list.length ? runStyle(list[list.length - 1]) : normalizeTextStyle(base, base);
}

export function applyStyleToRange(content, runs, base, start, end, patch) {
  const list = materializeRuns(content, runs, base);
  if (!list.length) return [];
  const length = list.reduce((sum, run) => sum + run.text.length, 0);
  const from = Math.max(0, Math.min(length, Number(start) || 0));
  const to = Math.max(from, Math.min(length, Number(end) || 0));
  if (from === to) return list;

  const result = [];
  let position = 0;
  for (const run of list) {
    const runStart = position;
    const runEnd = position + run.text.length;
    position = runEnd;
    if (runEnd <= from || runStart >= to) {
      result.push(run);
      continue;
    }
    const localStart = Math.max(0, from - runStart);
    const localEnd = Math.min(run.text.length, to - runStart);
    if (localStart > 0) result.push({ ...run, text: run.text.slice(0, localStart) });
    result.push({
      ...run,
      text: run.text.slice(localStart, localEnd),
      ...normalizeTextStyle({ ...run, ...patch }, base),
    });
    if (localEnd < run.text.length) result.push({ ...run, text: run.text.slice(localEnd) });
  }
  return mergeRuns(result);
}

export function applyPatchToRuns(content, runs, base, patch) {
  return mergeRuns(
    materializeRuns(content, runs, base).map((run) => ({
      ...run,
      ...normalizeTextStyle({ ...run, ...patch }, base),
    })),
  );
}

export function commonTextStyle(content, runs, base) {
  const list = materializeRuns(content, runs, base);
  if (!list.length) return normalizeTextStyle(base, base);
  const first = list[0];
  return {
    color: first.color,
    fontSize: first.fontSize,
    fontFamily: first.fontFamily,
    bold: list.every((run) => run.bold),
    italic: list.every((run) => run.italic),
    underline: list.every((run) => run.underline),
  };
}

export function uniformTextStyle(runs) {
  if (!runs?.length) return null;
  const first = runs[0];
  return runs.every((run) => sameTextStyle(run, first)) ? runStyle(first) : null;
}

/** Обрезает пробелы по краям, сохраняя стили оставшихся фрагментов. */
export function trimRuns(content, runs, base) {
  const list = materializeRuns(content, runs, base);
  const text = list.map((run) => run.text).join('');
  const trimmed = text.trim();
  if (!trimmed) return { content: '', runs: [] };
  const start = text.length - text.trimStart().length;
  const end = text.trimEnd().length;
  const sliced = [];
  let position = 0;
  for (const run of list) {
    const runStart = position;
    const runEnd = position + run.text.length;
    position = runEnd;
    const from = Math.max(start, runStart);
    const to = Math.min(end, runEnd);
    if (from < to) sliced.push({ ...run, text: run.text.slice(from - runStart, to - runStart) });
  }
  return { content: trimmed, runs: mergeRuns(sliced) };
}

export function runsEqual(left, right) {
  const first = left ?? [];
  const second = right ?? [];
  if (first.length !== second.length) return false;
  return first.every(
    (run, index) => run.text === second[index].text && sameTextStyle(run, second[index]),
  );
}
