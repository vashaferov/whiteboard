/** Точка входа: вход в урок, связка доски, инструментов и WebSocket-клиента. */

import { Board } from './board.js';
import { ToolManager } from './tools.js';
import { SyncClient } from './sync.js';
import { PagesPanel } from './pages.js';
import { authApi, roomsApi } from './api.js';
import { initAuth, showAuth } from './auth.js';
import { initDashboard, showDashboard } from './dashboard.js';

const ROOM_KEY = 'wb:room';
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
  room_not_found: 'Комната не найдена',
  invalid_room: 'Некорректный id комнаты',
  replaced: 'Урок открыт в другой вкладке',
  kicked: 'Доступ к комнате закрыт',
  closed: 'Соединение закрыто',
};

const state = {
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
  workspaces: [],
  workspaceId: null,
  pendingWorkspaceId: null,
  pendingEvents: [],
  stateVersion: 0,
  selectedStudentIds: new Set(),
  moveRequestId: null,
  boardSize: DEFAULT_BOARD,
};

const els = {};
const $ = (selector) => document.querySelector(selector);

let pagesPanel = null;
let toastTimer = null;

function newId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return `o_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

function round(value) {
  return Math.round(value * 100) / 100;
}

// ------------------------------------------------------------------ room state

function loadRoomState() {
  try {
    const raw = sessionStorage.getItem(ROOM_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveRoomState() {
  if (!state.roomId) return;
  sessionStorage.setItem(
    ROOM_KEY,
    JSON.stringify({ roomId: state.roomId, workspaceId: state.workspaceId ?? '' }),
  );
}

function clearRoomState() {
  sessionStorage.removeItem(ROOM_KEY);
}

// --------------------------------------------------------------------- boot

function init() {
  cacheElements();
  buildPalette();
  bindToolbar();
  bindTextEditor();
  bindKeyboard();
  bindWindowEvents();
  initAuth({ onAuthenticated: startApp });
  initDashboard({
    onOpenRoom: (roomId) => {
      window.location.href = `/?room=${encodeURIComponent(roomId)}`;
    },
    onLogout: logout,
    onSessionLost: () => showAuth('Сессия истекла — войдите снова'),
  });
  boot();
}

async function boot() {
  try {
    startApp(await authApi.me());
  } catch {
    showAuth();
  }
}

function startApp(me) {
  state.user = me.user;
  state.permissions = me.permissions;
  state.boardSize = me.board || DEFAULT_BOARD;
  const roomId = new URLSearchParams(window.location.search).get('room');
  if (roomId) {
    openRoom(roomId);
    return;
  }
  showDashboard({ user: me.user, permissions: me.permissions });
}

async function logout() {
  try {
    await authApi.logout();
  } catch {
    /* сессия уже могла истечь */
  }
  state.user = null;
  showAuth();
}

function cacheElements() {
  els.app = $('#app');
  els.board = $('#board');
  els.pagesPanel = $('#pages-panel');
  els.status = $('#status');
  els.roomTitle = $('#room-title');
  els.userList = $('#user-list');
  els.userCount = $('#user-count');
  els.pullActions = $('#pull-actions');
  els.pullSelected = $('#pull-selected');
  els.pullAll = $('#pull-all');
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

function isStaff(role) {
  return role === 'teacher' || role === 'admin';
}

async function openRoom(roomId) {
  try {
    const room = await roomsApi.get(roomId);
    startRoom({
      room,
      user: state.user,
      permissions: state.permissions,
      board: state.boardSize,
    });
  } catch (error) {
    if (error.status === 401) {
      showAuth('Сессия истекла — войдите снова');
      return;
    }
    if (state.user) {
      showDashboard({ user: state.user, permissions: state.permissions });
    }
    toast(error.message || 'Не удалось открыть комнату');
  }
}

function startRoom({ room, user, permissions, board }) {
  state.roomId = room.id;
  state.user = user;
  state.permissions = permissions;
  state.ready = false;
  state.leaving = false;
  state.workspaces = [];
  const saved = loadRoomState();
  state.workspaceId = saved && saved.roomId === room.id ? saved.workspaceId || null : null;
  state.pendingWorkspaceId = null;
  state.pendingEvents = [];
  state.stateVersion = 0;
  state.selectedStudentIds = new Set();
  state.moveRequestId = null;

  $('#auth').hidden = true;
  $('#status-screen').hidden = true;
  $('#dashboard').hidden = true;
  els.app.hidden = false;
  els.roomTitle.textContent = room.name;
  els.usersHint.textContent = '';
  history.replaceState(null, '', `?room=${encodeURIComponent(room.id)}`);

  const size = board || DEFAULT_BOARD;
  state.board = new Board(els.board, {
    width: size.width,
    height: size.height,
    canEditObject: (object) =>
      Boolean(state.user) &&
      (isStaff(state.user.role) || object.author === state.user.id),
    canDeleteObject: (object) => {
      if (!state.user) return false;
      if (isStaff(state.user.role)) return true;
      return object.author === state.user.id;
    },
    onObjectMove: (objectId, x, y) => {
      sendWorkspace({
        type: 'object_update',
        objectId,
        x: round(x),
        y: round(y),
      });
    },
    onObjectTransform: (objectId, data) => {
      sendWorkspace({
        type: 'object_transform',
        objectId,
        ...data,
      });
    },
    onEditText: (object) => openTextEditorForObject(object),
  });

  state.tools = new ToolManager({
    board: state.board,
    onEvent: (message) => sendWorkspace(message),
    onCreateText: (point) => openTextEditor(point),
    getAuthor: () => state.user?.id ?? null,
    onErase: (ids) => {
      for (const id of ids) sendWorkspace({ type: 'object_delete', objectId: id });
    },
  });

  pagesPanel = new PagesPanel({
    container: els.pagesPanel,
    onSelect: (id) => requestWorkspaceSwitch(id),
    onCreate: () => requestWorkspaceCreate(),
    onRename: (workspace) => requestWorkspaceRename(workspace),
    onDelete: (workspace) => requestWorkspaceDelete(workspace),
    onMove: (id, direction) => requestWorkspaceMove(id, direction),
  });
  renderPages();

  setupCursorBroadcast();

  state.sync = new SyncClient({
    roomId: room.id,
    workspaceId: state.workspaceId,
    onEvent: handleServerEvent,
    onStatus: handleConnectionStatus,
    onFatal: handleFatal,
  });

  selectTool(state.tool);
  updateToolbar();
  renderUsers();
  setStatus('pending', 'Подключение…');
  state.sync.connect();
}

function handleFatal(reason) {
  if (reason === 'unauthorized') {
    showAuth('Сессия истекла — войдите снова');
    return;
  }
  if (reason === 'replaced') {
    showAuth('Урок открыт в другой вкладке');
    return;
  }
  leaveRoom(FATAL_MESSAGES[reason] || FATAL_MESSAGES.closed);
}

function leaveRoom(message = '') {
  if (state.leaving) return;
  state.leaving = true;

  state.sync?.close();
  state.tools?.destroy();
  state.board?.destroy();
  state.sync = null;
  state.tools = null;
  state.board = null;
  state.users.clear();
  state.ready = false;
  state.textPoint = null;
  state.textEditObjectId = null;
  state.workspaces = [];
  state.workspaceId = null;
  state.pendingWorkspaceId = null;
  state.pendingEvents = [];
  state.stateVersion = 0;
  state.selectedStudentIds = new Set();
  state.moveRequestId = null;
  state.roomId = null;
  pagesPanel = null;
  els.pagesPanel.replaceChildren();

  clearRoomState();
  els.textEditor.hidden = true;
  els.textEditor.value = '';
  els.app.hidden = true;
  els.clearBtn.hidden = true;
  history.replaceState(null, '', '/');

  if (state.user) {
    showDashboard({ user: state.user, permissions: state.permissions });
  } else {
    showAuth(message);
    return;
  }
  if (message) toast(message);
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
    sendWorkspace({ type: 'clear' });
  });

  els.imageBtn.addEventListener('click', () => els.fileInput.click());
  els.fileInput.addEventListener('change', uploadImage);
  els.leaveBtn.addEventListener('click', () => leaveRoom('Вы вышли из комнаты'));

  els.pullSelected.addEventListener('click', () => {
    if (!state.selectedStudentIds.size) return;
    state.sync?.send({ type: 'workspace_pull', clientIds: [...state.selectedStudentIds] });
    state.selectedStudentIds.clear();
    renderUsers();
  });
  els.pullAll.addEventListener('click', () => {
    state.sync?.send({ type: 'workspace_pull', all: true });
  });
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
      body: form,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = data.detail;
      toast(typeof detail === 'string' ? detail : detail?.message || 'Не удалось загрузить изображение');
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
      author: state.user?.id ?? null,
    });
    state.board.selectObject(objectId);
    selectTool('select');
    sendWorkspace({
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
    sendWorkspace({ type: 'text_update', objectId: editId, content });
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
    author: state.user?.id ?? null,
  };
  state.board.addObject(object);
  sendWorkspace({
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

// ----------------------------------------------------------------- workspaces

function sendWorkspace(message) {
  return state.sync?.send({ ...message, workspaceId: state.workspaceId });
}

function canManageWorkspaces() {
  return Boolean(state.permissions.canManageWorkspaces);
}

function renderPages() {
  pagesPanel?.render(state.workspaces, state.workspaceId, {
    canManage: canManageWorkspaces(),
    busy: Boolean(state.pendingWorkspaceId || state.moveRequestId),
  });
}

function persistSessionWorkspace() {
  if (state.sync) state.sync.workspaceId = state.workspaceId ?? '';
  saveRoomState();
}

// A pending switch can be refused (stale id) or lose its target (page deleted
// before workspace_switch was processed). Recover instead of staying frozen.
function abortPendingWorkspaceSwitch() {
  if (!state.pendingWorkspaceId) return;
  state.pendingWorkspaceId = null;
  state.pendingEvents = [];
  state.board?.setInteractive(true);
  renderPages();
}

function nextPageName() {
  let highest = 0;
  for (const workspace of state.workspaces) {
    const match = /^Страница (\d+)$/.exec(workspace.name || '');
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  const number = highest ? highest + 1 : state.workspaces.length + 1;
  return `Страница ${number}`;
}

function requestWorkspaceSwitch(id) {
  if (!id || state.pendingWorkspaceId || state.moveRequestId || id === state.workspaceId) return;
  commitText();
  state.board.setInteractive(false);
  state.pendingWorkspaceId = id;
  state.pendingEvents = [];
  renderPages();
  state.sync?.send({ type: 'workspace_switch', workspaceId: id });
}

function requestWorkspaceCreate() {
  const name = window.prompt('Название новой страницы', nextPageName());
  if (name === null) return;
  const trimmed = name.trim();
  if (!trimmed) return;
  state.sync?.send({ type: 'workspace_create', name: trimmed });
}

function requestWorkspaceRename(workspace) {
  const name = window.prompt('Название страницы', workspace.name);
  if (name === null) return;
  const trimmed = name.trim();
  if (!trimmed) return;
  state.sync?.send({ type: 'workspace_rename', workspaceId: workspace.id, name: trimmed });
}

function requestWorkspaceDelete(workspace) {
  const confirmed = window.confirm(
    `Удалить страницу «${workspace.name}»? Все объекты на ней будут удалены безвозвратно.`,
  );
  if (!confirmed) return;
  state.sync?.send({ type: 'workspace_delete', workspaceId: workspace.id });
}

function requestWorkspaceMove(id, direction) {
  const ids = state.workspaces.map((workspace) => workspace.id);
  const index = ids.indexOf(id);
  if (index === -1) return;
  const target = direction === 'up' ? index - 1 : index + 1;
  if (target < 0 || target >= ids.length) return;
  [ids[index], ids[target]] = [ids[target], ids[index]];
  state.sync?.send({ type: 'workspace_reorder', workspaceIds: ids });
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
    case 'stroke_point':
    case 'stroke_end':
    case 'shape_add':
    case 'text_add':
    case 'image_add':
    case 'object_update':
    case 'object_transform':
    case 'text_update':
    case 'object_delete':
    case 'clear':
    case 'cursor':
      applyWorkspaceEvent(message);
      break;
    case 'cursor_remove':
      board.removeCursor(message.id);
      break;
    case 'workspace_state':
      handleWorkspaceState(message);
      break;
    case 'workspace_created':
      handleWorkspaceCreated(message);
      break;
    case 'workspace_renamed':
      handleWorkspaceRenamed(message);
      break;
    case 'workspace_reordered':
      handleWorkspaceReordered(message);
      break;
    case 'workspace_deleted':
      handleWorkspaceDeleted(message);
      break;
    case 'workspace_prepare_move':
      handlePrepareMove(message);
      break;
    case 'workspace_moved':
      handleWorkspaceMoved(message);
      break;
    case 'error':
      abortPendingWorkspaceSwitch();
      toast(message.message || 'Ошибка');
      break;
    case 'kicked':
      leaveRoom(message.reason || 'Доступ к комнате закрыт');
      break;
    default:
      break;
  }
}

// Объектные/курсорные события приходят с workspaceId: применяем только для
// текущей страницы, события для переключаемой — буферизуем, остальные — игнорируем.
function applyWorkspaceEvent(message) {
  const workspaceId = message.workspaceId;
  if (workspaceId && workspaceId !== state.workspaceId) {
    if (workspaceId === state.pendingWorkspaceId) {
      state.pendingEvents.push(message);
    }
    return;
  }
  applyObjectEvent(message);
}

function applyObjectEvent(message) {
  const board = state.board;
  switch (message.type) {
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
    default:
      break;
  }
}

function handleWorkspaceState(message) {
  const version = message.stateVersion ?? 0;
  if (version <= state.stateVersion) return;

  state.stateVersion = version;
  state.workspaceId = message.workspaceId;
  state.pendingWorkspaceId = null;
  state.moveRequestId = null;
  state.ready = true;

  state.board.setObjects(message.objects || []);
  state.board.clearCursors();
  state.board.selectObject(null);
  state.board.setInteractive(true);

  const buffered = state.pendingEvents;
  state.pendingEvents = [];
  for (const event of buffered) applyObjectEvent(event);

  renderPages();
  renderUsers();
  persistSessionWorkspace();
}

function handlePrepareMove(message) {
  if (!message.requestId) return;
  state.moveRequestId = message.requestId;
  // Save the text draft and finish a stroke before acking, so both land on the
  // page the student is leaving (the server waits for this ack).
  commitText();
  state.tools?.finishActiveStroke();
  state.sync?.send({ type: 'workspace_move_ack', requestId: message.requestId });
  renderPages();
  // Safety net: the server applies a move no later than its 2 s timeout; if the
  // target vanished meanwhile, no workspace_state arrives and this unfreezes UI.
  window.setTimeout(() => {
    if (state.moveRequestId !== message.requestId) return;
    state.moveRequestId = null;
    renderPages();
  }, 3000);
}

function handleWorkspaceMoved(message) {
  state.moveRequestId = null;
  state.ready = false;
  state.pendingWorkspaceId = message.workspaceId || null;
  state.pendingEvents = [];
  state.board?.setInteractive(false);
  renderPages();
  if (message.name) toast(`Учитель перенёс вас на страницу «${message.name}»`);
}

function handleWorkspaceCreated(message) {
  const workspace = message.workspace;
  if (!workspace || !workspace.id) return;
  const rest = state.workspaces.filter((item) => item.id !== workspace.id);
  state.workspaces = [...rest, workspace].sort((a, b) => a.position - b.position);
  renderPages();
}

function handleWorkspaceRenamed(message) {
  const workspace = state.workspaces.find((item) => item.id === message.workspaceId);
  if (!workspace) return;
  workspace.name = message.name;
  renderPages();
}

function handleWorkspaceReordered(message) {
  const ids = message.workspaceIds || [];
  const byId = new Map(state.workspaces.map((workspace) => [workspace.id, workspace]));
  state.workspaces = ids
    .map((id, position) => {
      const workspace = byId.get(id);
      if (workspace) workspace.position = position;
      return workspace;
    })
    .filter(Boolean);
  renderPages();
}

function handleWorkspaceDeleted(message) {
  if (message.workspaceId === state.pendingWorkspaceId) abortPendingWorkspaceSwitch();
  state.workspaces = state.workspaces.filter((item) => item.id !== message.workspaceId);
  renderPages();
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

  state.workspaces = message.workspaces || [];
  state.workspaceId = message.workspaceId;
  state.pendingWorkspaceId = null;
  state.pendingEvents = [];
  state.stateVersion = 0;
  state.moveRequestId = null;
  state.selectedStudentIds = new Set();
  if (state.sync) state.sync.workspaceId = state.workspaceId ?? '';

  state.board.setBoardSize(message.board.width, message.board.height);
  state.board.setObjects(message.objects);
  state.board.clearCursors();
  state.board.setInteractive(true);
  state.ready = true;

  renderUsers();
  renderPages();
  updateToolbar();
  setStatus('online', 'Подключено');

  els.usersHint.textContent =
    isStaff(message.role)
      ? 'Двойной клик по тексту — редактировать. Рамка — масштаб и поворот. × — отключить ученика.'
      : 'Свои объекты можно двигать, масштабировать и поворачивать. Двойной клик по своему тексту — редактировать.';

  saveRoomState();
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
  const rank = (role) => (isStaff(role) ? 0 : 1);
  const users = Array.from(state.users.values()).sort((left, right) => {
    if (rank(left.role) !== rank(right.role)) return rank(left.role) - rank(right.role);
    if (left.role !== right.role) return left.role === 'admin' ? -1 : 1;
    return left.name.localeCompare(right.name, 'ru');
  });

  const canPull = canPullStudents();
  const students = new Set(
    users.filter((user) => user.role === 'student').map((user) => user.id),
  );
  for (const id of [...state.selectedStudentIds]) {
    if (!students.has(id)) state.selectedStudentIds.delete(id);
  }

  els.userList.replaceChildren();
  els.userCount.textContent = users.length ? `(${users.length})` : '';

  for (const user of users) {
    const item = document.createElement('li');
    item.className = 'user';

    if (canPull && user.role === 'student') {
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.className = 'user__pull-check';
      check.title = `Выбрать ${user.name}`;
      check.checked = state.selectedStudentIds.has(user.id);
      check.addEventListener('change', () => {
        if (check.checked) state.selectedStudentIds.add(user.id);
        else state.selectedStudentIds.delete(user.id);
        updatePullActions();
      });
      item.appendChild(check);
    }

    const dot = document.createElement('span');
    dot.className = 'user__dot';
    dot.style.backgroundColor = user.color;
    item.appendChild(dot);

    const name = document.createElement('span');
    name.className = 'user__name';
    name.textContent = user.name;
    item.appendChild(name);

    if (isStaff(user.role)) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = user.role === 'admin' ? 'администратор' : 'учитель';
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

  updatePullActions();
}

function canPullStudents() {
  return Boolean(state.permissions.canManageUsers) && isStaff(state.user?.role);
}

function updatePullActions() {
  if (!els.pullActions) return;
  const canPull = canPullStudents();
  els.pullActions.hidden = !canPull;
  els.pullSelected.disabled = state.selectedStudentIds.size === 0;
  els.pullAll.disabled = !canPull;
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
    sendWorkspace({ type: 'cursor', x: round(point.x), y: round(point.y) });
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
      sendWorkspace({ type: 'object_delete', objectId: selectedId });
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
