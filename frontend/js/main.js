/** Точка входа: вход в урок, связка доски, инструментов и WebSocket-клиента. */

import { Board } from './board.js';
import { ToolManager } from './tools.js';
import { SyncClient } from './sync.js';

const SESSION_KEY = 'wb:session';
const NAME_KEY = 'wb:name';
const DEFAULT_BOARD = { width: 1600, height: 900 };
const PALETTE = ['#111827', '#2563eb', '#dc2626', '#16a34a', '#d97706', '#7c3aed', '#0891b2', '#db2777'];
const TOOL_KEYS = {
  b: 'brush',
  e: 'eraser',
  r: 'rect',
  o: 'circle',
  l: 'line',
  a: 'arrow',
  t: 'text',
  v: 'select',
};
const FATAL_MESSAGES = {
  unauthorized: 'Сессия истекла — войдите снова',
  forbidden: 'Нет доступа к этой комнате',
  invalid_room: 'Некорректный код комнаты',
  replaced: 'Урок открыт в другой вкладке',
  kicked: 'Учитель отключил вас от урока',
  closed: 'Соединение закрыто',
};

const state = {
  token: null,
  roomId: null,
  user: null,
  users: new Map(),
  permissions: { canDraw: true, canClear: false, canDelete: false, canManageUsers: false },
  board: null,
  tools: null,
  sync: null,
  color: PALETTE[1],
  width: 4,
  tool: 'brush',
  ready: false,
  textPoint: null,
  textEditObjectId: null,
  leaving: false,
};

const els = {};
const $ = (selector) => document.querySelector(selector);

let toastTimer = null;

function newId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return `o_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

function round(value) {
  return Math.round(value * 100) / 100;
}

// ------------------------------------------------------------------ session

function loadSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveSession(session) {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

function clearSession() {
  sessionStorage.removeItem(SESSION_KEY);
}

// --------------------------------------------------------------------- boot

function init() {
  cacheElements();
  buildPalette();
  bindLogin();
  bindToolbar();
  bindTextEditor();
  bindKeyboard();
  bindWindowEvents();
  prefillLogin();

  const session = loadSession();
  const queryRoom = new URLSearchParams(window.location.search).get('room');
  if (session?.token && session.roomId && (!queryRoom || queryRoom === session.roomId)) {
    startSession(session);
  } else {
    showLogin();
  }
}

function cacheElements() {
  els.login = $('#login');
  els.loginForm = $('#login-form');
  els.loginError = $('#login-error');
  els.loginSubmit = $('#login-submit');
  els.codeField = $('#code-field');
  els.nameInput = els.loginForm.elements.name;
  els.roomInput = els.loginForm.elements.room;
  els.roleSelect = els.loginForm.elements.role;
  els.codeInput = els.loginForm.elements.code;

  els.app = $('#app');
  els.board = $('#board');
  els.status = $('#status');
  els.roomLabel = $('#room-label');
  els.userList = $('#user-list');
  els.userCount = $('#user-count');
  els.usersHint = $('#users-hint');
  els.toolButtons = Array.from(document.querySelectorAll('[data-tool]'));
  els.colors = $('#colors');
  els.widthRange = $('#width-range');
  els.widthValue = $('#width-value');
  els.clearBtn = $('#clear-btn');
  els.imageBtn = $('#image-btn');
  els.leaveBtn = $('#leave-btn');
  els.fileInput = $('#file-input');
  els.textEditor = $('#text-editor');
  els.toast = $('#toast');
}

function prefillLogin() {
  const session = loadSession();
  const queryRoom = new URLSearchParams(window.location.search).get('room');
  els.nameInput.value = localStorage.getItem(NAME_KEY) || '';
  if (queryRoom) els.roomInput.value = queryRoom;
  else if (session?.roomId) els.roomInput.value = session.roomId;
}

function showLogin(message = '') {
  els.login.hidden = false;
  els.app.hidden = true;
  els.loginError.textContent = message;
  if (!els.roomInput.value) prefillLogin();
  els.nameInput.focus();
}

// --------------------------------------------------------------------- login

function bindLogin() {
  els.roleSelect.addEventListener('change', () => {
    const isTeacher = els.roleSelect.value === 'teacher';
    els.codeField.hidden = !isTeacher;
    els.codeInput.required = isTeacher;
  });

  els.loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = els.nameInput.value.trim();
    const roomId = els.roomInput.value.trim();
    const role = els.roleSelect.value;
    const code = els.codeInput.value;

    if (!name || !roomId) {
      els.loginError.textContent = 'Укажите имя и код комнаты';
      return;
    }

    els.loginError.textContent = '';
    els.loginSubmit.disabled = true;
    try {
      const response = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          roomId,
          role,
          code: role === 'teacher' ? code : undefined,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        els.loginError.textContent = data.detail || 'Не удалось войти в урок';
        return;
      }
      localStorage.setItem(NAME_KEY, name);
      saveSession(data);
      startSession(data);
    } catch {
      els.loginError.textContent = 'Сервер недоступен. Попробуйте ещё раз.';
    } finally {
      els.loginSubmit.disabled = false;
    }
  });
}

function startSession(session) {
  state.token = session.token;
  state.roomId = session.roomId;
  state.user = session.user || null;
  state.permissions = session.permissions || state.permissions;
  state.ready = false;
  state.leaving = false;

  els.login.hidden = true;
  els.app.hidden = false;
  els.roomLabel.textContent = session.roomId;
  els.usersHint.textContent = '';
  history.replaceState(null, '', `?room=${encodeURIComponent(session.roomId)}`);

  state.board = new Board(els.board, {
    width: (session.board || DEFAULT_BOARD).width,
    height: (session.board || DEFAULT_BOARD).height,
    canEditObject: (object) =>
      Boolean(state.user) &&
      (state.user.role === 'teacher' || object.author === state.user.id),
    onObjectMove: (objectId, x, y) => {
      state.sync?.send({
        type: 'object_update',
        objectId,
        x: round(x),
        y: round(y),
      });
    },
    onObjectTransform: (objectId, data) => {
      state.sync?.send({
        type: 'object_transform',
        objectId,
        ...data,
      });
    },
    onEditText: (object) => openTextEditorForObject(object),
  });

  state.tools = new ToolManager({
    board: state.board,
    onEvent: (message) => state.sync?.send(message),
    onCreateText: (point) => openTextEditor(point),
  });

  setupCursorBroadcast();

  state.sync = new SyncClient({
    roomId: session.roomId,
    token: session.token,
    onEvent: handleServerEvent,
    onStatus: handleConnectionStatus,
    onFatal: (reason) => leaveLesson(FATAL_MESSAGES[reason] || FATAL_MESSAGES.closed),
  });

  selectTool(state.tool);
  updateToolbar();
  renderUsers();
  setStatus('pending', 'Подключение…');
  state.sync.connect();
}

function leaveLesson(message = '') {
  if (state.leaving) return;
  state.leaving = true;

  state.sync?.close();
  state.tools?.destroy();
  state.board?.destroy();
  state.sync = null;
  state.tools = null;
  state.board = null;
  state.user = null;
  state.users.clear();
  state.ready = false;
  state.textPoint = null;
  state.textEditObjectId = null;

  clearSession();
  els.textEditor.hidden = true;
  els.textEditor.value = '';
  els.app.hidden = true;
  els.clearBtn.hidden = true;
  showLogin(message);
  history.replaceState(null, '', window.location.pathname);
}

// ------------------------------------------------------------------- toolbar

function bindToolbar() {
  for (const button of els.toolButtons) {
    button.addEventListener('click', () => selectTool(button.dataset.tool));
  }

  els.widthRange.addEventListener('input', () => {
    state.width = Number(els.widthRange.value) || 4;
    els.widthValue.textContent = `${state.width} px`;
    state.tools?.setStyle({ width: state.width });
  });

  els.clearBtn.addEventListener('click', () => {
    if (!state.permissions.canClear || !state.board) return;
    if (!window.confirm('Очистить доску для всех участников?')) return;
    state.board.clearObjects();
    state.sync?.send({ type: 'clear' });
  });

  els.imageBtn.addEventListener('click', () => els.fileInput.click());
  els.fileInput.addEventListener('change', uploadImage);
  els.leaveBtn.addEventListener('click', () => leaveLesson('Вы вышли из урока'));
}

function buildPalette() {
  for (const color of PALETTE) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'swatch';
    button.dataset.color = color;
    button.title = color;
    button.style.setProperty('--swatch-color', color);
    button.addEventListener('click', () => {
      state.color = color;
      updatePalette();
      state.tools?.setStyle({ color });
    });
    els.colors.appendChild(button);
  }
  updatePalette();
  els.widthValue.textContent = `${state.width} px`;
}

function updatePalette() {
  for (const swatch of els.colors.children) {
    swatch.classList.toggle('is-active', swatch.dataset.color === state.color);
  }
}

function selectTool(tool) {
  if (!tool) return;
  state.tool = tool;
  for (const button of els.toolButtons) {
    button.classList.toggle('is-active', button.dataset.tool === tool);
  }
  state.tools?.setTool(tool);
}

function updateToolbar() {
  els.clearBtn.hidden = !state.permissions.canClear;
  els.imageBtn.disabled = false;
}

// -------------------------------------------------------------------- image

async function uploadImage(event) {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file || !state.board) return;

  els.imageBtn.disabled = true;
  try {
    const form = new FormData();
    form.append('file', file);
    const response = await fetch('/api/upload', {
      method: 'POST',
      headers: { Authorization: `Bearer ${state.token}` },
      body: form,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      toast(data.detail || 'Не удалось загрузить изображение');
      return;
    }

    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = reject;
      image.src = data.url;
    });

    const boardWidth = state.board.width;
    const boardHeight = state.board.height;
    const maxWidth = Math.min(480, boardWidth * 0.6);
    const scale = Math.min(1, maxWidth / image.naturalWidth);
    const width = Math.max(40, image.naturalWidth * scale);
    const height = Math.max(40, image.naturalHeight * scale);
    const x = Math.max(0, (boardWidth - width) / 2);
    const y = Math.max(0, (boardHeight - height) / 2);
    const objectId = newId();

    state.board.addObject({
      id: objectId,
      type: 'image',
      url: data.url,
      x,
      y,
      width,
      height,
    });
    state.sync?.send({
      type: 'image_add',
      objectId,
      url: data.url,
      x: round(x),
      y: round(y),
      width: round(width),
      height: round(height),
    });
  } catch {
    toast('Не удалось открыть изображение');
  } finally {
    els.imageBtn.disabled = false;
  }
}

// --------------------------------------------------------------------- text

function bindTextEditor() {
  els.textEditor.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      commitText();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeTextEditor();
    }
  });
  els.textEditor.addEventListener('input', () => {
    els.textEditor.style.height = 'auto';
    els.textEditor.style.height = `${els.textEditor.scrollHeight}px`;
  });
  document.addEventListener(
    'pointerdown',
    (event) => {
      if (!els.textEditor.hidden && event.target !== els.textEditor) commitText();
    },
    true,
  );
}

function openTextEditor(point) {
  if (!state.board || !state.tools) return;
  const style = state.tools.getTextStyle();
  state.textEditObjectId = null;
  state.textPoint = point;
  showTextEditorAt(point.x, point.y, style.fontSize, style.color, '');
}

function openTextEditorForObject(object) {
  if (!state.board || !state.user || !object) return;
  const canEdit =
    state.user.role === 'teacher' || object.author === state.user.id;
  if (!canEdit) {
    toast('Редактировать можно только свои тексты');
    return;
  }
  state.textEditObjectId = object.id;
  state.textPoint = null;
  showTextEditorAt(
    object.x,
    object.y,
    object.fontSize || 24,
    object.color || state.color,
    object.content || '',
  );
}

function showTextEditorAt(x, y, fontSize, color, value) {
  const local = state.board.toScreen({ x, y });
  const container = els.board.getBoundingClientRect();
  const scale = state.board.scale;

  els.textEditor.hidden = false;
  els.textEditor.value = value;
  els.textEditor.style.left = `${container.left + local.x}px`;
  els.textEditor.style.top = `${container.top + local.y}px`;
  els.textEditor.style.width = `${Math.max(180, Math.min(420, 320 * scale))}px`;
  els.textEditor.style.fontSize = `${fontSize * scale}px`;
  els.textEditor.style.color = color;
  els.textEditor.style.height = 'auto';
  requestAnimationFrame(() => {
    els.textEditor.focus({ preventScroll: true });
    els.textEditor.setSelectionRange(value.length, value.length);
    els.textEditor.style.height = `${els.textEditor.scrollHeight}px`;
  });
}

function commitText() {
  if (els.textEditor.hidden || !state.board) return;
  const content = els.textEditor.value.trim();
  const point = state.textPoint;
  const editId = state.textEditObjectId;
  closeTextEditor();
  if (!content) return;

  if (editId) {
    const current = state.board.getObjectData(editId);
    if (!current || current.content === content) return;
    state.board.applyObjectTransform({ ...current, content });
    state.sync?.send({ type: 'text_update', objectId: editId, content });
    return;
  }

  if (!point) return;
  const style = state.tools.getTextStyle();
  const objectId = newId();
  const object = {
    id: objectId,
    type: 'text',
    content,
    x: round(point.x),
    y: round(point.y),
    color: style.color,
    fontSize: style.fontSize,
    rotation: 0,
  };
  state.board.addObject(object);
  state.sync?.send({
    type: 'text_add',
    objectId,
    content,
    x: object.x,
    y: object.y,
    color: style.color,
    fontSize: style.fontSize,
  });
}

function closeTextEditor() {
  els.textEditor.hidden = true;
  els.textEditor.value = '';
  state.textPoint = null;
  state.textEditObjectId = null;
}

// ------------------------------------------------------------------- events

function handleServerEvent(message) {
  const board = state.board;
  if (!board) return;

  switch (message.type) {
    case 'init':
      handleInit(message);
      break;
    case 'user_joined':
      state.users.set(message.user.id, message.user);
      renderUsers();
      break;
    case 'user_left':
      state.users.delete(message.id);
      board.removeCursor(message.id);
      renderUsers();
      break;
    case 'stroke_start':
      board.addObject(message.object);
      break;
    case 'stroke_point':
      board.appendStrokePoint(message.objectId, message.point);
      break;
    case 'stroke_end':
      board.endStroke(message.objectId, message.object);
      break;
    case 'shape_add':
    case 'text_add':
    case 'image_add':
      board.addObject(message.object);
      break;
    case 'object_update':
      board.updateObjectPosition(message.objectId, message.x, message.y);
      break;
    case 'object_transform':
    case 'text_update':
      board.applyObjectTransform(message.object);
      break;
    case 'object_delete':
      board.removeObject(message.objectId);
      break;
    case 'clear':
      board.clearObjects();
      toast('Учитель очистил доску');
      break;
    case 'cursor':
      board.upsertCursor(message.id, {
        x: message.x,
        y: message.y,
        name: message.name,
        color: message.color,
      });
      break;
    case 'error':
      toast(message.message || 'Ошибка');
      break;
    case 'kicked':
      toast(message.reason || 'Учитель отключил вас');
      break;
    default:
      break;
  }
}

function handleInit(message) {
  const me = message.users.find((user) => user.id === message.clientId);
  state.user = {
    id: message.clientId,
    name: me?.name || state.user?.name || '',
    role: message.role,
    color: me?.color || '',
  };
  state.permissions = message.permissions;
  state.users = new Map(message.users.map((user) => [user.id, user]));

  state.board.setBoardSize(message.board.width, message.board.height);
  state.board.setObjects(message.objects);
  state.board.clearCursors();
  state.ready = true;

  renderUsers();
  updateToolbar();
  setStatus('online', 'Подключено');

  els.usersHint.textContent =
    message.role === 'teacher'
      ? 'Двойной клик по тексту — редактировать. Рамка — масштаб и поворот. × — отключить ученика.'
      : 'Свои объекты можно двигать, масштабировать и поворачивать. Двойной клик по своему тексту — редактировать.';

  const session = loadSession();
  if (session) {
    session.user = state.user;
    session.permissions = state.permissions;
    saveSession(session);
  }
}

function handleConnectionStatus(status) {
  if (status === 'open') {
    setStatus('pending', 'Синхронизация…');
  } else if (status === 'connecting') {
    setStatus('pending', 'Подключение…');
  } else if (status === 'closed') {
    setStatus('offline', 'Переподключение…');
  }
}

function setStatus(kind, text) {
  els.status.textContent = text;
  els.status.dataset.state = kind;
}

// -------------------------------------------------------------------- users

function renderUsers() {
  const users = Array.from(state.users.values()).sort((left, right) => {
    if (left.role !== right.role) return left.role === 'teacher' ? -1 : 1;
    return left.name.localeCompare(right.name, 'ru');
  });

  els.userList.replaceChildren();
  els.userCount.textContent = users.length ? `(${users.length})` : '';

  for (const user of users) {
    const item = document.createElement('li');
    item.className = 'user';

    const dot = document.createElement('span');
    dot.className = 'user__dot';
    dot.style.backgroundColor = user.color;
    item.appendChild(dot);

    const name = document.createElement('span');
    name.className = 'user__name';
    name.textContent = user.name;
    item.appendChild(name);

    if (user.role === 'teacher') {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = 'учитель';
      item.appendChild(badge);
    }

    if (state.user && user.id === state.user.id) {
      const badge = document.createElement('span');
      badge.className = 'badge badge--self';
      badge.textContent = 'вы';
      item.appendChild(badge);
    } else if (state.permissions.canManageUsers) {
      const kick = document.createElement('button');
      kick.type = 'button';
      kick.className = 'user__kick';
      kick.title = `Отключить ${user.name}`;
      kick.textContent = '×';
      kick.addEventListener('click', () => {
        if (!window.confirm(`Отключить участника «${user.name}»?`)) return;
        state.sync?.send({ type: 'kick', clientId: user.id });
      });
      item.appendChild(kick);
    }

    els.userList.appendChild(item);
  }
}

// ------------------------------------------------------------------ cursors

function setupCursorBroadcast() {
  let lastSent = 0;
  state.board.stage.on('pointermove', () => {
    const now = performance.now();
    if (now - lastSent < 50) return;
    lastSent = now;
    const point = state.board?.getPointer();
    if (!point) return;
    state.sync?.send({ type: 'cursor', x: round(point.x), y: round(point.y) });
  });
}

// --------------------------------------------------------------- keyboard

function bindKeyboard() {
  document.addEventListener('keydown', (event) => {
    const target = event.target;
    if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;

    const tool = TOOL_KEYS[event.key.toLowerCase()];
    if (tool) {
      selectTool(tool);
      return;
    }

    if (event.key === 'F2') {
      const selectedId = state.board?.getSelectedId();
      const object = selectedId ? state.board?.getObjectData(selectedId) : null;
      if (object?.type === 'text') {
        event.preventDefault();
        openTextEditorForObject(object);
      }
      return;
    }

    if (event.key === 'Delete' || event.key === 'Backspace') {
      const selectedId = state.board?.getSelectedId();
      if (!selectedId) return;
      event.preventDefault();
      if (!state.permissions.canDelete) {
        toast('Удалять объекты может только учитель');
        return;
      }
      state.board.removeObject(selectedId);
      state.sync?.send({ type: 'object_delete', objectId: selectedId });
      return;
    }

    if (event.key === 'Escape') {
      state.board?.selectObject(null);
    }
  });
}

function bindWindowEvents() {
  window.addEventListener('beforeunload', () => state.sync?.close());
}

// -------------------------------------------------------------------- toast

function toast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  requestAnimationFrame(() => els.toast.classList.add('is-visible'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.classList.remove('is-visible');
    setTimeout(() => {
      els.toast.hidden = true;
    }, 200);
  }, 3000);
}

init();
