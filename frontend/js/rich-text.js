/**
 * Мост между contenteditable-редактором и моделью runs.
 * Внутри редактора стили задаются inline-стилями span, а перевод строки — \n
 * (white-space: pre-wrap), поэтому DOM остаётся плоским и предсказуемым.
 */

import { FONT_STACKS, fontStack } from './board.js';
import {
  materializeRuns,
  mergeRuns,
  normalizeFontFamily,
  normalizeFontSize,
  sameTextStyle,
  textBaseStyle,
} from './text-runs.js';

const BLOCK_TAGS = new Set([
  'DIV',
  'P',
  'LI',
  'UL',
  'OL',
  'BLOCKQUOTE',
  'PRE',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
]);

function rgbToHex(value) {
  const match = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(value || '');
  if (!match) return null;
  const parts = [match[1], match[2], match[3]].map((part) =>
    Number(part).toString(16).padStart(2, '0'),
  );
  return `#${parts.join('')}`;
}

function isBold(weight) {
  if (weight === 'bold' || weight === 'bolder') return true;
  const numeric = Number(weight);
  return Number.isFinite(numeric) && numeric >= 600;
}

function normalizedStack(value) {
  return String(value || '')
    .replace(/["']/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function fontFamilyKey(value) {
  const normalized = normalizedStack(value);
  if (!normalized) return null;
  for (const [key, stack] of Object.entries(FONT_STACKS)) {
    const candidate = normalizedStack(stack);
    if (normalized === candidate || normalized.startsWith(candidate)) return key;
  }
  return null;
}

function hasUnderline(element, root) {
  let node = element;
  while (node) {
    const style = window.getComputedStyle(node);
    const decoration = style.textDecorationLine || style.textDecoration || '';
    if (decoration.includes('underline')) return true;
    if (node === root) break;
    node = node.parentElement;
  }
  return false;
}

function styleFor(element, root, base, scale) {
  const target = element instanceof HTMLElement ? element : root;
  const computed = window.getComputedStyle(target);
  const holder = target.closest?.('[data-font]');
  const family =
    holder && holder.dataset.font
      ? normalizeFontFamily(holder.dataset.font)
      : normalizeFontFamily(fontFamilyKey(computed.fontFamily) ?? base.fontFamily);
  const fontSize = normalizeFontSize(Number.parseFloat(computed.fontSize) / scale);
  return {
    color: rgbToHex(computed.color) ?? base.color,
    fontSize,
    fontFamily: family,
    bold: isBold(computed.fontWeight),
    italic: computed.fontStyle === 'italic' || computed.fontStyle === 'oblique',
    underline: hasUnderline(target, root),
  };
}

function plainTextOfFragment(fragment) {
  let text = '';
  const walk = (node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.nodeValue.replace(/\u200b/g, '');
      return;
    }
    if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
      for (const child of node.childNodes) walk(child);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    if (node.tagName === 'BR') {
      text += '\n';
      return;
    }
    const block = BLOCK_TAGS.has(node.tagName);
    if (block && text && !text.endsWith('\n')) text += '\n';
    for (const child of node.childNodes) walk(child);
  };
  walk(fragment);
  return text;
}

/** Читает contenteditable как { content, runs }. */
export function parseEditor(root, base = textBaseStyle({}), scale = 1) {
  const rows = [];
  let content = '';
  const append = (text, style) => {
    if (!text) return;
    const last = rows[rows.length - 1];
    if (last && sameTextStyle(last, style)) last.text += text;
    else rows.push({ text, ...style });
    content += text;
  };
  const walk = (node, style) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const parent = node.parentElement || root;
      append(node.nodeValue.replace(/\u200b/g, ''), styleFor(parent, root, base, scale));
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    if (node.tagName === 'BR') {
      append('\n', style);
      return;
    }
    const block = BLOCK_TAGS.has(node.tagName);
    if (block && content && !content.endsWith('\n')) append('\n', style);
    for (const child of node.childNodes) walk(child, style);
  };
  for (const child of root.childNodes) walk(child, styleFor(root, root, base, scale));
  return { content, runs: mergeRuns(rows) };
}

/** Рисует content/runs внутри contenteditable. */
export function renderEditor(root, content, runs, base = textBaseStyle({}), scale = 1) {
  const list = materializeRuns(content, runs, base);
  const fragment = document.createDocumentFragment();
  for (const run of list) {
    const span = document.createElement('span');
    span.dataset.font = run.fontFamily;
    span.style.fontFamily = fontStack(run.fontFamily);
    span.style.fontSize = `${run.fontSize * scale}px`;
    span.style.fontWeight = run.bold ? '700' : '400';
    span.style.fontStyle = run.italic ? 'italic' : 'normal';
    span.style.textDecoration = run.underline ? 'underline' : 'none';
    span.style.color = run.color;
    const parts = run.text.split('\n');
    parts.forEach((part, index) => {
      if (part) span.appendChild(document.createTextNode(part));
      if (index < parts.length - 1) span.appendChild(document.createElement('br'));
    });
    fragment.appendChild(span);
  }
  root.replaceChildren(fragment);
}

function offsetOf(root, container, offset) {
  const range = document.createRange();
  range.selectNodeContents(root);
  range.setEnd(container, offset);
  return plainTextOfFragment(range.cloneContents()).length;
}

/** Позиция каретки/выделения в символах content. */
export function editorSelectionOffsets(root) {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const start = offsetOf(root, range.startContainer, range.startOffset);
  const end = offsetOf(root, range.endContainer, range.endOffset);
  return start <= end ? { start, end } : { start: end, end: start };
}

function pointAtOffset(root, target) {
  let position = 0;
  let lastText = null;
  let result = null;
  const walk = (node) => {
    if (result) return;
    if (node.nodeType === Node.TEXT_NODE) {
      lastText = node;
      if (target <= position + node.nodeValue.length) {
        result = { node, offset: Math.max(0, target - position) };
        return;
      }
      position += node.nodeValue.length;
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    if (node.tagName === 'BR') {
      if (target <= position) {
        result = { node, where: 'before' };
        return;
      }
      if (target <= position + 1) {
        result = { node, where: 'after' };
        return;
      }
      position += 1;
      return;
    }
    for (const child of node.childNodes) walk(child);
  };
  walk(root);
  if (result) return result;
  if (lastText) return { node: lastText, offset: lastText.nodeValue.length };
  return { node: root, offset: root.childNodes.length };
}

function applyPoint(range, point, method) {
  if (point.where === 'before') range[`set${method}Before`](point.node);
  else if (point.where === 'after') range[`set${method}After`](point.node);
  else {
    const max =
      point.node.nodeType === Node.TEXT_NODE
        ? point.node.nodeValue.length
        : point.node.childNodes.length;
    range[`set${method}`](point.node, Math.min(point.offset, max));
  }
}

/** Ставит каретку/выделение по абсолютным смещениям. */
export function setEditorSelection(root, start, end = start) {
  const from = Math.max(0, Math.min(start, end));
  const to = Math.max(start, end);
  const range = document.createRange();
  applyPoint(range, pointAtOffset(root, from), 'Start');
  applyPoint(range, pointAtOffset(root, to), 'End');
  root.focus({ preventScroll: true });
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

/** Вставляет простой текст в позицию каретки, сохраняя стиль окружения. */
export function insertEditorText(root, value) {
  const text = String(value ?? '').replace(/\r\n?/g, '\n');
  if (!text) return;
  root.focus({ preventScroll: true });
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || !root.contains(selection.anchorNode)) {
    setEditorSelection(root, (root.textContent ?? '').length);
  }
  if (text === '\n') {
    document.execCommand('insertLineBreak');
  } else {
    document.execCommand('insertText', false, text);
  }
  root.dispatchEvent(new Event('input', { bubbles: true }));
}
