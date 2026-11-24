/** Точка входа: вход в урок, связка доски, инструментов и WebSocket-клиента. */

import { Board, fontStack } from './board.js';
import { ToolManager } from './tools.js';
import { SyncClient } from './sync.js';
import { PagesPanel } from './pages.js';
import { exportWorkspacePdf } from './export.js';
import { authApi, roomsApi } from './api.js';
import { initAuth, showAuth } from './auth.js';
import { initDashboard, showDashboard } from './dashboard.js';
import { initRoomChrome } from './room-chrome.js';

const ROOM_KEY = 'wb:room';
const USERS_PANEL_KEY = 'wb:usersPanelWidth';
const PAGES_COLLAPSED_KEY = 'wb:pagesCollapsed';
const USERS_COLLAPSED_KEY = 'wb:usersCollapsed';
const USERS_PANEL_MIN = 200;
const USERS_PANEL_MAX = 560;
const USERS_PANEL_DEFAULT = 248;
const DEFAULT_BOARD = { width: 1600, height: 900 };
const ZOOM_STEP = 1.25;
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
  p: 'process',
  d: 'decision',
  s: 'terminator',
  f: 'frame',
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
  tool: 'select',
  invisible: false,
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
  wasPresentation: false,
  toolBeforePresentation: null,
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
  buildFramePanel();
  initRoomChrome();
  bindUsersResizer();
  bindSidebarToggles();
  bindToolbar();
  bindBoardSize();
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
  els.boardStage = $('#board-stage');
  els.pagesPanel = $('#pages-panel');
  els.status = $('#status');
  els.roomTitle = $('#room-title');
  els.roomRole = $('#room-role');
  els.roomContext = $('#room-context');
  els.styleDot = $('#style-dot');
  els.styleWidth = $('#style-width');
  els.roomMoreBtn = $('#room-more-btn');
  els.framePanel = $('#frame-panel');
  els.boardSizeBtn = $('#board-size-btn');
  els.boardSizePanel = $('#board-size-panel');
  els.canvasInfinite = $('#canvas-infinite');
  els.boardWidth = $('#board-width');
  els.boardHeight = $('#board-height');
  els.boardSizeApply = $('#board-size-apply');
  els.boardColor = $('#board-color');
  els.boardColorReset = $('#board-color-reset');
  els.frameColors = $('#frame-colors');
  els.framePatternButtons = {
    none: $('#frame-pattern-none'),
    lines: $('#frame-pattern-lines'),
    grid: $('#frame-pattern-grid'),
  };
  els.userList = $('#user-list');
  els.userCount = $('#user-count');
  els.usersPanel = $('#users-panel');
  els.usersResizer = $('#users-resizer');
  els.usersToggle = $('#users-toggle');
  els.invisibleToggle = $('#invisible-toggle');
  els.pullActions = $('#pull-actions');
  els.pullSelected = $('#pull-selected');
  els.pullAll = $('#pull-all');
  els.usersHint = $('#users-hint');
  els.toolButtons = Array.from(document.querySelectorAll('[data-tool]'));
  els.colors = $('#colors');
  els.fontControl = $('#font-select')?.closest('.font-control');
  els.fontSelect = $('#font-select');
  els.fontSize = $('#font-size');
  els.textBold = $('#text-bold');
  els.textItalic = $('#text-italic');
  els.textUnderline = $('#text-underline');
  els.widthRange = $('#width-range');
  els.widthValue = $('#width-value');
  els.clearBtn = $('#clear-btn');
  els.imageBtn = $('#image-btn');
  els.pdfBtn = $('#pdf-btn');
  els.undoBtn = $('#undo-btn');
  els.lockBtn = $('#lock-btn');
  els.leaveBtn = $('#leave-btn');
  els.fileInput = $('#file-input');
  els.presentationInput = $('#presentation-input');
  els.slideControls = $('#slide-controls');
  els.slidePrev = $('#slide-prev');
  els.slideNext = $('#slide-next');
  els.slideCounter = $('#slide-counter');
  els.slideLiveText = $('#slide-live-text');
  els.zoomOut = $('#zoom-out');
  els.zoomReset = $('#zoom-reset');
  els.zoomIn = $('#zoom-in');
  els.widthControl = els.widthRange.closest('.width-control');
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
  state.wasPresentation = false;
  state.toolBeforePresentation = null;

  $('#auth').hidden = true;
  $('#status-screen').hidden = true;
  $('#dashboard').hidden = true;
  els.app.hidden = false;
  els.roomTitle.textContent = room.name;
  updateRoomRole();
  updateStyleButton();
  updateRoomContext();
  els.usersHint.textContent = '';
  history.replaceState(null, '', `?room=${encodeURIComponent(room.id)}`);

  const size = board || DEFAULT_BOARD;
  state.board = new Board(els.boardStage, {
    width: size.width,
    height: size.height,
    canEditObject: (object) =>
      Boolean(state.user) &&
      !lockedFor(object) &&
      (isStaff(state.user.role) || object.author === state.user.id),
    canDeleteObject,
    onObjectMove: (objectId, x, y) => {
      sendWorkspace({
        type: 'object_update',
        objectId,
        x: round(x),
        y: round(y),
      });
    },
    onObjectsMove: (updates) => {
      sendWorkspace({ type: 'objects_move', updates });
    },
    onObjectTransform: (objectId, data) => {
      sendWorkspace({
        type: 'object_transform',
        objectId,
        ...data,
      });
    },
    onEditText: (object) => openTextEditorForObject(object),
    onFrameMove: (id, x, y) =>
      sendWorkspace({ type: 'frame_move', objectId: id, x: round(x), y: round(y) }),
    onSelectObject: () => {
      updateFramePanel();
      updateLockButton();
      updateFontControl();
    },
    onViewChange: (percent) => updateZoomControls(percent),
    onGestureStart: () => state.tools?.cancelOrFinishStroke(),
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
    onCreatePresentation: () => els.presentationInput.click(),
    onRename: (workspace) => requestWorkspaceRename(workspace),
    onDelete: (workspace) => requestWorkspaceDelete(workspace),
    onMove: (id, direction) => requestWorkspaceMove(id, direction),
    onToggleCollapse: () => {
      setPagesCollapsed(!els.pagesPanel.classList.contains('is-collapsed'));
      renderPages();
    },
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
  state.wasPresentation = false;
  state.toolBeforePresentation = null;
  state.roomId = null;
  pagesPanel = null;
  els.pagesPanel.replaceChildren();

  clearRoomState();
  els.textEditor.hidden = true;
  els.textEditor.value = '';
  els.framePanel.hidden = true;
  els.boardSizePanel.hidden = true;
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
    updateStyleButton();
    state.tools?.setStyle({ width: state.width });
  });

  els.fontSelect?.addEventListener('change', () => {
    const fontFamily = els.fontSelect.value;
    state.tools?.setFontFamily(fontFamily);
    applyTextStyle({ fontFamily });
    updateFontControl();
  });

  els.fontSize?.addEventListener('change', () => {
    const fontSize = clampFontSize(els.fontSize.value);
    els.fontSize.value = String(fontSize);
    state.tools?.setFontSize(fontSize);
    applyTextStyle({ fontSize });
    updateFontControl();
  });

  for (const [name, button] of Object.entries(textFormatButtons())) {
    button?.addEventListener('click', () => toggleTextFormat(name));
  }

  els.clearBtn.addEventListener('click', () => {
    if (!state.permissions.canClear || !state.board) return;
    if (!window.confirm('Очистить доску для всех участников?')) return;
    state.board.clearObjects();
    sendWorkspace({ type: 'clear' });
  });

  els.imageBtn.addEventListener('click', () => els.fileInput.click());
  els.fileInput.addEventListener('change', uploadImage);
  els.presentationInput.addEventListener('change', uploadPresentation);
  els.slidePrev.addEventListener('click', () => requestSlide(-1));
  els.slideNext.addEventListener('click', () => requestSlide(1));
  els.pdfBtn.addEventListener('click', exportPdf);
  els.zoomOut.addEventListener('click', () => zoomBy(-1));
  els.zoomIn.addEventListener('click', () => zoomBy(1));
  els.zoomReset.addEventListener('click', () => state.board?.resetView());
  els.undoBtn.addEventListener('click', requestUndo);
  els.leaveBtn.addEventListener('click', () => leaveRoom('Вы вышли из комнаты'));
  els.lockBtn.addEventListener('click', () => {
    const id = state.board?.getSelectedId();
    const object = id ? state.board.getObjectData(id) : null;
    if (!object || !isStaff(state.user?.role)) return;
    sendWorkspace({ type: 'object_lock', objectId: id, locked: !object.locked });
  });

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

function canEditObject(object) {
  return (
    Boolean(state.user) &&
    (isStaff(state.user.role) || (!lockedFor(object) && object.author === state.user.id))
  );
}

function canDeleteObject(object) {
  if (!state.user || lockedFor(object)) return false;
  if (object.type === 'frame' && state.board) {
    for (const entry of state.board.objects.values()) {
      if (entry.data.frameId !== object.id) continue;
      if (lockedFor(entry.data)) return false;
      if (!isStaff(state.user.role) && entry.data.author !== state.user.id) return false;
    }
  }
  if (isStaff(state.user.role)) return true;
  return object.author === state.user.id;
}

function textFormatButtons() {
  return { bold: els.textBold, italic: els.textItalic, underline: els.textUnderline };
}

function clampFontSize(value) {
  const parsed = Math.round(Number(value));
  if (!Number.isFinite(parsed)) return 24;
  return Math.min(200, Math.max(8, parsed));
}

function applyTextStyle(patch) {
  if (isPresentation()) return false;
  const id = state.board?.getSelectedId();
  const object = id ? state.board.getObjectData(id) : null;
  if (!object || object.type !== 'text' || !canEditObject(object)) return false;
  state.board.setTextStyle(id, patch);
  sendWorkspace({ type: 'text_style', objectId: id, ...patch });
  return true;
}

function toggleTextFormat(name) {
  const id = state.board?.getSelectedId();
  const object = id ? state.board.getObjectData(id) : null;
  const current = object?.type === 'text' ? object[name] : state.tools?.[name];
  const value = !current;
  state.tools?.setTextFormat({ [name]: value });
  applyTextStyle({ [name]: value });
  updateFontControl();
}

function updateFontControl() {
  if (!els.fontControl) return;
  const presentation = isPresentation();
  const id = state.board?.getSelectedId();
  const object = id ? state.board.getObjectData(id) : null;
  const selected = object?.type === 'text' && !presentation ? object : null;
  const visible = Boolean(selected) || (!presentation && state.tool === 'text');
  els.fontControl.hidden = !visible;
  if (!visible) return;
  const style = selected ?? state.tools?.getTextStyle() ?? {};
  els.fontSelect.value = style.fontFamily || 'sans';
  els.fontSize.value = String(clampFontSize(style.fontSize ?? 24));
  const locked = Boolean(selected) && !canEditObject(selected);
  els.fontSelect.disabled = locked;
  els.fontSize.disabled = locked;
  for (const [name, button] of Object.entries(textFormatButtons())) {
    if (!button) continue;
    const active = Boolean(style[name]);
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
    button.disabled = locked;
  }
}

function lockedFor(object) {
  if (!object) return false;
  if (object.locked) return true;
  if (!object.frameId) return false;
  return Boolean(state.board?.getObjectData(object.frameId)?.locked);
}

function updateInvisibilityToggle() {
  if (!els.invisibleToggle) return;
  const admin = state.user?.role === 'admin';
  els.invisibleToggle.hidden = !admin;
  if (!admin) return;
  const hidden = Boolean(state.invisible);
  els.invisibleToggle.setAttribute('aria-pressed', String(hidden));
  const label = hidden ? 'Показать меня ученикам' : 'Скрыть меня от учеников';
  els.invisibleToggle.title = label;
  els.invisibleToggle.setAttribute('aria-label', label);
}

function updateBoardSizeUI(presentation = isPresentation()) {
  const canResize = !presentation && isStaff(state.user?.role);
  els.boardSizeBtn.hidden = !canResize;
  if (!canResize) els.boardSizePanel.hidden = true;
}

function currentWorkspace() {
  return state.workspaces.find((workspace) => workspace.id === state.workspaceId) || null;
}

function workspaceCanvas(workspace) {
  return workspace?.canvas || { mode: 'infinite' };
}

function applyWorkspaceBackground(workspace = currentWorkspace()) {
  if (!state.board || workspace?.kind === 'presentation') return;
  state.board.setBackground(workspace?.background || null);
}

function applyWorkspaceCanvas(workspace = currentWorkspace()) {
  if (!state.board) return;
  if (workspace?.kind === 'presentation') {
    state.board.setBackground(null);
    return;
  }
  const canvas = workspaceCanvas(workspace);
  if (canvas.mode === 'fixed') {
    state.board.setCanvasMode('fixed', canvas.width, canvas.height);
  } else {
    state.board.setCanvasMode('infinite');
  }
  state.board.setBackground(workspace?.background || null);
}

function updateBoardSizePanel() {
  if (!els.boardSizePanel || els.boardSizePanel.hidden) return;
  const canvas = workspaceCanvas(currentWorkspace());
  const infinite = canvas.mode !== 'fixed';
  els.canvasInfinite.checked = infinite;
  els.boardWidth.value = String(canvas.width ?? 1600);
  els.boardHeight.value = String(canvas.height ?? 900);
  els.boardWidth.disabled = infinite;
  els.boardHeight.disabled = infinite;
  if (els.boardColor) {
    els.boardColor.value = currentWorkspace()?.background || '#ffffff';
  }
  for (const preset of document.querySelectorAll('[data-board-preset]')) {
    preset.disabled = infinite;
  }
}

function bindBoardSize() {
  if (!els.boardSizeBtn || !els.boardSizePanel) return;
  els.boardSizeBtn.addEventListener('click', () => {
    els.boardSizePanel.hidden = !els.boardSizePanel.hidden;
    updateBoardSizePanel();
  });
  els.canvasInfinite?.addEventListener('change', () => {
    const infinite = els.canvasInfinite.checked;
    els.boardWidth.disabled = infinite;
    els.boardHeight.disabled = infinite;
    for (const preset of document.querySelectorAll('[data-board-preset]')) {
      preset.disabled = infinite;
    }
  });
  for (const preset of document.querySelectorAll('[data-board-preset]')) {
    preset.addEventListener('click', () => {
      const [width, height] = preset.dataset.boardPreset.split('x');
      els.canvasInfinite.checked = false;
      els.boardWidth.disabled = false;
      els.boardHeight.disabled = false;
      els.boardWidth.value = width;
      els.boardHeight.value = height;
    });
  }
  els.boardColor?.addEventListener('change', () => {
    sendWorkspace({ type: 'workspace_background', color: els.boardColor.value });
  });
  els.boardColorReset?.addEventListener('click', () => {
    sendWorkspace({ type: 'workspace_background', color: null });
  });
  els.boardSizeApply.addEventListener('click', () => {
    const mode = els.canvasInfinite.checked ? 'infinite' : 'fixed';
    if (mode === 'infinite') {
      sendWorkspace({ type: 'workspace_canvas', mode });
    } else {
      const width = Number(els.boardWidth.value);
      const height = Number(els.boardHeight.value);
      if (!Number.isInteger(width) || !Number.isInteger(height)) return;
      sendWorkspace({ type: 'workspace_canvas', mode, width, height });
    }
    els.boardSizePanel.hidden = true;
  });
}

function updateLockButton() {
  const id = state.board?.getSelectedId();
  const object = id ? state.board.getObjectData(id) : null;
  const staff = isStaff(state.user?.role);
  els.lockBtn.hidden = isPresentation() || !staff || !object;
  if (!object) return;
  els.lockBtn.classList.toggle('is-active', Boolean(object.locked));
  els.lockBtn.title = object.locked ? 'Снять блокировку' : 'Заблокировать';
}

function requestUndo() {
  if (!state.board || state.tools?.isDrawing()) return;
  if (isPresentation() && !isStaff(state.user?.role)) return;
  sendWorkspace({ type: 'undo' });
}

function selectedFrame() {
  const id = state.board?.getSelectedId();
  const data = id ? state.board.getObjectData(id) : null;
  if (!data || data.type !== 'frame' || !canEditObject(data)) return null;
  return data;
}

function buildFramePanel() {
  for (const color of PALETTE) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'frame-color';
    button.dataset.color = color;
    button.style.backgroundColor = color;
    button.title = color;
    button.addEventListener('click', () => applyFrameStyle({ fill: color }));
    els.frameColors.appendChild(button);
  }
  for (const [pattern, button] of Object.entries(els.framePatternButtons)) {
    button.addEventListener('click', () => applyFrameStyle({ pattern }));
  }
}

function updateFramePanel() {
  if (!els.framePanel) return;
  const frame = selectedFrame();
  if (!frame) {
    els.framePanel.hidden = true;
    return;
  }
  els.framePanel.hidden = false;
  for (const [pattern, button] of Object.entries(els.framePatternButtons)) {
    button.classList.toggle('is-active', (frame.pattern || 'none') === pattern);
  }
  for (const button of els.frameColors.querySelectorAll('.frame-color')) {
    button.classList.toggle('is-active', (frame.fill || '') === button.dataset.color);
  }
}

function applyFrameStyle(patch) {
  const frame = selectedFrame();
  if (!frame) return;
  const fill = patch.fill !== undefined ? patch.fill : frame.fill ?? null;
  const pattern =
    patch.pattern !== undefined ? patch.pattern : frame.pattern ?? 'none';
  state.board.setFrameStyle(frame.id, { fill, pattern });
  sendWorkspace({ type: 'frame_style', objectId: frame.id, fill, pattern });
  updateFramePanel();
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
      updateStyleButton();
      state.tools?.setStyle({ color });
      applyTextStyle({ color });
      updateFontControl();
    });
    els.colors.appendChild(button);
  }
  updatePalette();
  updateStyleButton();
  els.widthValue.textContent = `${state.width} px`;
}

function updatePalette() {
  for (const swatch of els.colors.children) {
    swatch.classList.toggle('is-active', swatch.dataset.color === state.color);
  }
}

function updateStyleButton() {
  if (els.styleDot) els.styleDot.style.backgroundColor = state.color;
  if (els.styleWidth) els.styleWidth.textContent = `${state.width} px`;
}

function updateRoomRole() {
  if (!els.roomRole) return;
  const role = state.user?.role || 'student';
  const labels = { student: 'Ученик', teacher: 'Учитель', admin: 'Администратор' };
  els.roomRole.textContent = labels[role] || role;
  els.roomRole.dataset.role = role;
}

function updateRoomContext() {
  if (!els.roomContext) return;
  const workspace = state.workspaces.find((item) => item.id === state.workspaceId);
  if (workspace?.kind === 'presentation') {
    const total = (workspace.slides || []).length;
    const index = Math.min(
      Math.max(Number(workspace.slideIndex) || 0, 0),
      Math.max(total - 1, 0),
    );
    els.roomContext.textContent = total
      ? `Презентация · Слайд ${index + 1} из ${total}`
      : 'Презентация';
    return;
  }
  els.roomContext.textContent = workspace?.name || 'Страница';
}

function selectTool(tool) {
  if (!tool) return;
  if (isPresentation() && !(isStaff(state.user?.role) && tool === 'brush')) return;
  state.tool = tool;
  for (const button of els.toolButtons) {
    button.classList.toggle('is-active', button.dataset.tool === tool);
  }
  state.tools?.setTool(tool);
  updateFontControl();
}

function updateZoomControls(percent = 100) {
  if (!els.zoomReset) return;
  const min = state.board?.canvasMode === 'infinite' ? 10 : 50;
  els.zoomReset.textContent = `${percent}%`;
  els.zoomOut.disabled = percent <= min;
  els.zoomIn.disabled = percent >= 400;
}

function zoomBy(direction) {
  if (!state.board) return;
  const center = { x: els.board.clientWidth / 2, y: els.board.clientHeight / 2 };
  state.board.zoomAt(direction > 0 ? ZOOM_STEP : 1 / ZOOM_STEP, center);
}

function updateToolbar() {
  const presentation = isPresentation();
  els.clearBtn.hidden = presentation || !state.permissions.canClear;
  els.pdfBtn.hidden = presentation || !isStaff(state.user?.role);
  els.imageBtn.hidden = presentation;
  els.undoBtn.hidden = presentation && !isStaff(state.user?.role);
  if (els.roomMoreBtn) {
    els.roomMoreBtn.hidden = presentation || !isStaff(state.user?.role);
  }
  els.imageBtn.disabled = false;
  updateFontControl();
  updateBoardSizeUI(presentation);
  updateInvisibilityToggle();
}

// -------------------------------------------------------------------- image

async function uploadImageFile(file) {
  const form = new FormData();
  form.append('file', file);
  const response = await fetch('/api/upload', {
    method: 'POST',
    body: form,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = data.detail;
    throw new Error(
      typeof detail === 'string'
        ? detail
        : detail?.message || 'Не удалось загрузить изображение',
    );
  }

  const image = new Image();
  await new Promise((resolve, reject) => {
    image.onload = resolve;
    image.onerror = () => reject(new Error('Не удалось открыть изображение'));
    image.src = data.url;
  });

  const maxWidth = Math.min(480, state.board.width * 0.6);
  const scale = Math.min(1, maxWidth / image.naturalWidth);
  return {
    url: data.url,
    width: Math.max(40, image.naturalWidth * scale),
    height: Math.max(40, image.naturalHeight * scale),
  };
}

function placeUploadedImage(data, { offset = 0 } = {}) {
  const x = Math.max(0, (state.board.width - data.width) / 2 + offset);
  const y = Math.max(0, (state.board.height - data.height) / 2 + offset);
  const objectId = newId();

  state.board.addObject({
    id: objectId,
    type: 'image',
    url: data.url,
    x,
    y,
    width: data.width,
    height: data.height,
    author: state.user?.id ?? null,
  });
  state.board.selectObject(objectId);
  sendWorkspace({
    type: 'image_add',
    objectId,
    url: data.url,
    x: round(x),
    y: round(y),
    width: round(data.width),
    height: round(data.height),
  });
  return objectId;
}

async function uploadImage(event) {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file || !state.board) return;

  els.imageBtn.disabled = true;
  try {
    placeUploadedImage(await uploadImageFile(file));
    selectTool('select');
  } catch (error) {
    toast(error.message || 'Не удалось вставить изображение');
  } finally {
    els.imageBtn.disabled = false;
  }
}

async function handlePaste(event) {
  if (!state.board || !state.ready || !els.textEditor.hidden || isPresentation()) return;
  const target = event.target;
  if (
    target &&
    (target.isContentEditable ||
      ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
  ) {
    return;
  }

  const files = [...(event.clipboardData?.items ?? [])]
    .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
    .map((item) => item.getAsFile())
    .filter(Boolean);
  if (!files.length) return;

  event.preventDefault();
  let lastId = null;
  for (const [index, file] of files.entries()) {
    try {
      lastId = placeUploadedImage(await uploadImageFile(file), { offset: index * 24 });
    } catch (error) {
      toast(error.message || 'Не удалось вставить изображение');
    }
  }
  if (lastId) selectTool('select');
}

async function uploadPresentation(event) {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file || !state.board || !isStaff(state.user?.role)) return;

  const name = file.name.replace(/\.pdf$/i, '').trim().slice(0, 60) || 'Презентация';
  try {
    const form = new FormData();
    form.append('file', file);
    const response = await fetch('/api/presentations', { method: 'POST', body: form });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = data.detail;
      toast(typeof detail === 'string' ? detail : detail?.message || 'Не удалось загрузить презентацию');
      return;
    }
    sendWorkspace({
      type: 'workspace_create',
      name,
      kind: 'presentation',
      slides: data.slides,
    });
  } catch {
    toast('Не удалось загрузить презентацию');
  }
}

function presentationWorkspace() {
  return (
    state.workspaces.find(
      (workspace) => workspace.id === state.workspaceId && workspace.kind === 'presentation',
    ) || null
  );
}

function isPresentation() {
  return Boolean(presentationWorkspace());
}

function presentationSlideUrl(workspace = presentationWorkspace()) {
  if (!workspace) return null;
  const slides = workspace.slides || [];
  const index = Math.min(Math.max(Number(workspace.slideIndex) || 0, 0), slides.length - 1);
  return slides[index] ?? null;
}

function updateSlideControls() {
  const workspace = presentationWorkspace();
  if (!workspace) {
    els.slideControls.hidden = true;
    return;
  }
  const slides = workspace.slides || [];
  const index = Math.min(Math.max(Number(workspace.slideIndex) || 0, 0), Math.max(slides.length - 1, 0));
  const staff = isStaff(state.user?.role);
  els.slideControls.hidden = false;
  els.slideCounter.textContent = slides.length ? `${index + 1} / ${slides.length}` : '0 / 0';
  els.slidePrev.hidden = !staff;
  els.slideNext.hidden = !staff;
  els.slidePrev.disabled = !staff || index <= 0;
  els.slideNext.disabled = !staff || index >= slides.length - 1;
  if (els.slideLiveText) els.slideLiveText.textContent = staff ? 'Презентация' : 'Просмотр';
  updateRoomContext();
}

function requestSlide(direction) {
  const workspace = presentationWorkspace();
  if (!workspace || !isStaff(state.user?.role)) return;
  const slides = workspace.slides || [];
  const index = Math.min(
    Math.max((Number(workspace.slideIndex) || 0) + direction, 0),
    slides.length - 1,
  );
  if (index === workspace.slideIndex) return;
  sendWorkspace({ type: 'presentation_slide', slideIndex: index });
}

function applyWorkspaceMode() {
  if (!state.board) return;
  const workspace = presentationWorkspace();
  const presentation = Boolean(workspace);
  const staff = isStaff(state.user?.role);
  const wasPresentation = Boolean(state.wasPresentation);
  state.wasPresentation = presentation;
  els.app.dataset.presentation = String(presentation);
  els.app.dataset.role = state.user?.role || '';
  if (els.roomMoreBtn) els.roomMoreBtn.hidden = presentation || !staff;
  updateRoomRole();
  updateRoomContext();

  for (const button of els.toolButtons) {
    button.hidden = presentation && (!staff || button.dataset.tool !== 'brush');
  }
  els.colors.hidden = presentation && !staff;
  els.widthControl.hidden = presentation && !staff;
  els.imageBtn.hidden = presentation;
  els.undoBtn.hidden = presentation && !staff;
  els.pdfBtn.hidden = presentation || !staff;
  els.clearBtn.hidden = presentation || !state.permissions.canClear;
  els.framePanel.hidden = true;
  updateFontControl();
  updateBoardSizeUI(presentation);

  if (presentation) {
    if (!wasPresentation) state.toolBeforePresentation = state.tool;
    state.board.setSelectMode(false);
    state.board.selectObject(null);
    closeTextEditor();
    if (staff) {
      state.board.setInteractive(true);
      selectTool('brush');
    } else {
      state.tools?.setTool('select');
      state.board.setInteractive(false);
    }
    updateSlideControls();
    state.board
      .setPresentationSlide(presentationSlideUrl(workspace))
      .catch(() => toast('Не удалось открыть слайд'));
  } else {
    state.board.setInteractive(state.ready);
    state.board.clearPresentationSlide();
    updateSlideControls();
    if (wasPresentation) {
      applyWorkspaceCanvas(currentWorkspace());
      const restore = state.toolBeforePresentation || 'brush';
      state.toolBeforePresentation = null;
      selectTool(restore);
    }
  }
  updateLockButton();
}

async function exportPdf() {
  if (!state.board || !isStaff(state.user?.role) || isPresentation()) return;
  if (state.tools?.isDrawing()) return;
  if (state.board.objects.size === 0) {
    toast('На странице нет объектов');
    return;
  }

  els.pdfBtn.disabled = true;
  try {
    const workspace = state.workspaces.find((item) => item.id === state.workspaceId);
    await exportWorkspacePdf(state.board, workspace?.name || 'board');
  } catch {
    toast('Не удалось экспортировать PDF');
  } finally {
    els.pdfBtn.disabled = false;
  }
}

// --------------------------------------------------------------------- text

function bindTextEditor() {
  els.textEditor.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
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
  state.textEditObjectId = null;
  state.textPoint = point;
  showTextEditorAt(point.x, point.y, state.tools.getTextStyle(), '');
}

function openTextEditorForObject(object) {
  if (!state.board || !state.user || !object) return;
  const canEdit = isStaff(state.user.role) || object.author === state.user.id;
  if (!canEdit) {
    toast('Редактировать можно только свои тексты');
    return;
  }
  state.textEditObjectId = object.id;
  state.textPoint = null;
  showTextEditorAt(object.x, object.y, {
    color: object.color || state.color,
    fontSize: object.fontSize || 24,
    fontFamily: object.fontFamily || 'sans',
    bold: Boolean(object.bold),
    italic: Boolean(object.italic),
    underline: Boolean(object.underline),
  }, object.content || '');
}

function showTextEditorAt(x, y, style, value) {
  const local = state.board.toScreen({ x, y });
  const container = els.board.getBoundingClientRect();
  const scale = state.board.scale;

  els.textEditor.hidden = false;
  els.textEditor.value = value;
  els.textEditor.style.left = `${container.left + local.x}px`;
  els.textEditor.style.top = `${container.top + local.y}px`;
  els.textEditor.style.width = `${Math.max(180, Math.min(420, 320 * scale))}px`;
  els.textEditor.style.fontSize = `${style.fontSize * scale}px`;
  els.textEditor.style.fontFamily = fontStack(style.fontFamily);
  els.textEditor.style.fontWeight = style.bold ? '700' : '400';
  els.textEditor.style.fontStyle = style.italic ? 'italic' : 'normal';
  els.textEditor.style.textDecoration = style.underline ? 'underline' : 'none';
  els.textEditor.style.color = style.color;
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
    fontFamily: style.fontFamily,
    bold: style.bold,
    italic: style.italic,
    underline: style.underline,
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
    fontFamily: style.fontFamily,
    bold: style.bold,
    italic: style.italic,
    underline: style.underline,
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
    collapsed: els.pagesPanel.classList.contains('is-collapsed'),
  });
  updateRoomContext();
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
    case 'users_state': {
      state.users = new Map(message.users.map((user) => [user.id, user]));
      if (typeof message.invisible === 'boolean') state.invisible = message.invisible;
      for (const id of [...(state.board?.cursors.keys() ?? [])]) {
        if (!state.users.has(id)) state.board?.removeCursor(id);
      }
      renderUsers();
      updateInvisibilityToggle();
      break;
    }
    case 'user_joined':
      state.users.set(message.user.id, message.user);
      renderUsers();
      break;
    case 'user_left':
      state.users.delete(message.id);
      board.removeCursor(message.id);
      renderUsers();
      break;
    case 'board_resize':
      state.board?.setBoardSize(message.width, message.height);
      updateBoardSizePanel();
      break;
    case 'workspace_canvas': {
      const workspace = state.workspaces.find((item) => item.id === message.workspaceId);
      if (workspace) {
        if (message.canvas) workspace.canvas = message.canvas;
        else delete workspace.canvas;
      }
      if (message.workspaceId === state.workspaceId) applyWorkspaceCanvas(workspace);
      updateBoardSizePanel();
      break;
    }
    case 'workspace_background': {
      const workspace = state.workspaces.find((item) => item.id === message.workspaceId);
      if (workspace) {
        if (message.color) workspace.background = message.color;
        else delete workspace.background;
      }
      if (message.workspaceId === state.workspaceId) applyWorkspaceBackground(workspace);
      updateBoardSizePanel();
      break;
    }
    case 'stroke_start':
    case 'stroke_point':
    case 'stroke_end':
    case 'shape_add':
    case 'text_add':
    case 'image_add':
    case 'connector_add':
    case 'frame_add':
    case 'frame_captured':
    case 'frame_moved':
    case 'frame_style':
    case 'object_update':
    case 'object_transform':
    case 'text_update':
    case 'text_style':
    case 'object_delete':
    case 'object_lock':
    case 'objects_restored':
    case 'clear':
    case 'cursor':
      applyWorkspaceEvent(message);
      break;
    case 'cursor_remove':
      board.removeCursor(message.id);
      break;
    case 'presentation_slide':
      handlePresentationSlide(message);
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
    case 'connector_add':
    case 'frame_add':
      board.addObject(message.object);
      break;
    case 'frame_captured':
      board.setFrameChildren(message.frameId, message.objectIds ?? []);
      break;
    case 'frame_moved':
      board.applyFrameMove(message);
      break;
    case 'frame_style':
      board.setFrameStyle(message.objectId, {
        fill: message.fill,
        pattern: message.pattern,
      });
      break;
    case 'object_update':
      board.updateObjectPosition(
        message.objectId,
        message.x,
        message.y,
        message.frameId,
      );
      break;
    case 'object_transform':
    case 'text_update':
    case 'text_style':
      board.applyObjectTransform(message.object);
      updateFontControl();
      break;
    case 'object_delete':
      board.removeObject(message.objectId);
      break;
    case 'object_lock':
      board.setObjectLocked(message.objectId, message.locked);
      updateFramePanel();
      updateLockButton();
      break;
    case 'objects_restored':
      board.applyObjectsRestored(message);
      updateFramePanel();
      updateLockButton();
      break;
    case 'presentation_slide':
      handlePresentationSlide(message);
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

function handlePresentationSlide(message) {
  const workspace = state.workspaces.find((item) => item.id === message.workspaceId);
  if (!workspace) return;
  workspace.slideIndex = message.slideIndex;
  if (workspace.id !== state.workspaceId) return;

  state.board?.setObjects(message.objects || []);
  state.board?.selectObject(null);
  state.board
    ?.setPresentationSlide(presentationSlideUrl(workspace))
    .catch(() => toast('Не удалось открыть слайд'));
  updateSlideControls();
}

function handleWorkspaceState(message) {
  const version = message.stateVersion ?? 0;
  if (version <= state.stateVersion) return;

  const switched = state.workspaceId !== message.workspaceId;
  state.stateVersion = version;
  state.workspaceId = message.workspaceId;
  state.pendingWorkspaceId = null;
  state.moveRequestId = null;
  state.ready = true;

  state.board.setObjects(message.objects || []);
  state.board.clearCursors();
  state.board.selectObject(null);
  const workspace = state.workspaces.find((item) => item.id === message.workspaceId);
  if (workspace && typeof message.slideIndex === 'number') {
    workspace.slideIndex = message.slideIndex;
  }
  if (workspace && workspace.kind !== 'presentation') {
    if (message.canvas) workspace.canvas = message.canvas;
    else delete workspace.canvas;
    if (message.background) workspace.background = message.background;
    else delete workspace.background;
  }
  if (switched) applyWorkspaceCanvas(workspace);

  const buffered = state.pendingEvents;
  state.pendingEvents = [];
  for (const event of buffered) applyObjectEvent(event);

  applyWorkspaceMode();
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
  state.invisible = Boolean(message.invisible);
  state.users = new Map(message.users.map((user) => [user.id, user]));

  state.workspaces = message.workspaces || [];
  state.workspaceId = message.workspaceId;
  state.pendingWorkspaceId = null;
  state.pendingEvents = [];
  state.stateVersion = 0;
  state.moveRequestId = null;
  state.selectedStudentIds = new Set();
  if (state.sync) state.sync.workspaceId = state.workspaceId ?? '';

  state.board.setObjects(message.objects);
  state.board.clearCursors();
  applyWorkspaceCanvas(currentWorkspace());
  state.ready = true;

  renderUsers();
  renderPages();
  updateToolbar();
  applyWorkspaceMode();
  updateInvisibilityToggle();
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
  els.userCount.textContent = users.length ? String(users.length) : '';

  const roleLabels = { admin: 'Администратор', teacher: 'Учитель', student: 'Ученик' };

  for (const user of users) {
    const item = document.createElement('li');
    item.className = 'user';
    item.dataset.role = user.role;

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

    const avatar = document.createElement('span');
    avatar.className = 'user__avatar';
    avatar.style.backgroundColor = user.color || '#2563eb';
    avatar.textContent = (user.name || '?').trim().charAt(0).toUpperCase();
    avatar.title = user.name;
    item.appendChild(avatar);

    const text = document.createElement('span');
    text.className = 'user__text';

    const name = document.createElement('span');
    name.className = 'user__name';
    name.textContent = user.name;
    name.title = user.name;
    text.appendChild(name);

    const role = document.createElement('span');
    role.className = 'user__role';
    role.textContent = roleLabels[user.role] || user.role;
    text.appendChild(role);

    item.appendChild(text);

    if (isStaff(user.role) && user.invisible) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = 'невидимка';
      item.appendChild(badge);
    }

    if (state.user && user.id === state.user.id) {
      const badge = document.createElement('span');
      badge.className = 'badge badge--self';
      badge.textContent = 'Вы';
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
    if (isPresentation()) {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        if (isStaff(state.user?.role)) {
          event.preventDefault();
          requestSlide(event.key === 'ArrowLeft' ? -1 : 1);
        }
        return;
      }
      if (['Delete', 'Backspace', 'F2'].includes(event.key)) {
        event.preventDefault();
        return;
      }
    }
    if (event.ctrlKey || event.metaKey) {
      if (event.code === 'KeyZ' && !event.shiftKey) {
        event.preventDefault();
        requestUndo();
      }
      return;
    }
    if (event.altKey) return;

    if (['+', '=', '-', '_', '0'].includes(event.key)) {
      if (!state.board) return;
      event.preventDefault();
      if (event.key === '0') {
        state.board.resetView();
        return;
      }
      const center = { x: els.board.clientWidth / 2, y: els.board.clientHeight / 2 };
      const factor = event.key === '-' || event.key === '_' ? 1 / ZOOM_STEP : ZOOM_STEP;
      state.board.zoomAt(factor, center);
      return;
    }

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
      const ids = state.board?.getSelectedIds?.() ?? [];
      if (!ids.length) return;
      event.preventDefault();
      if (!state.permissions.canDelete) {
        toast('Удалять объекты может только учитель');
        return;
      }
      const objects = ids
        .map((id) => state.board.getObjectData(id))
        .filter(Boolean);
      if (objects.some((object) => !canDeleteObject(object))) {
        toast('Некоторые выбранные элементы удалить нельзя');
        return;
      }
      if (ids.length > 1) {
        if (
          objects.some((object) => object.type === 'frame') &&
          !window.confirm('Удалить выбранные элементы вместе с содержимым?')
        ) {
          return;
        }
        state.board.removeObjects(ids);
        sendWorkspace({ type: 'objects_delete', objectIds: ids });
        return;
      }
      const object = objects[0];
      if (
        object?.type === 'frame' &&
        !window.confirm('Удалить фрейм и всё содержимое?')
      ) {
        return;
      }
      state.board.removeObject(ids[0]);
      sendWorkspace({ type: 'object_delete', objectId: ids[0] });
      return;
    }

    if (event.key === 'Escape') {
      state.board?.selectObjects([]);
    }
  });
}

function usersPanelMaxWidth() {
  return Math.max(
    USERS_PANEL_MIN,
    Math.min(USERS_PANEL_MAX, Math.floor(window.innerWidth * 0.5)),
  );
}

function clampUsersPanelWidth(width) {
  return Math.min(
    usersPanelMaxWidth(),
    Math.max(USERS_PANEL_MIN, Math.round(width)),
  );
}

function applyUsersPanelWidth(width, { persist = false } = {}) {
  if (!els.usersPanel) return;
  const value = clampUsersPanelWidth(width);
  els.usersPanel.style.width = `${value}px`;
  els.usersResizer?.setAttribute('aria-valuenow', String(value));
  if (persist) localStorage.setItem(USERS_PANEL_KEY, String(value));
}

function bindUsersResizer() {
  if (!els.usersPanel || !els.usersResizer) return;

  const saved = Number(localStorage.getItem(USERS_PANEL_KEY));
  applyUsersPanelWidth(Number.isFinite(saved) && saved > 0 ? saved : USERS_PANEL_DEFAULT);

  let dragging = false;
  let startX = 0;
  let startWidth = USERS_PANEL_DEFAULT;
  let currentWidth = USERS_PANEL_DEFAULT;

  const onMove = (event) => {
    if (!dragging) return;
    currentWidth = clampUsersPanelWidth(startWidth + (startX - event.clientX));
    applyUsersPanelWidth(currentWidth);
  };
  const stop = () => {
    if (!dragging) return;
    dragging = false;
    els.usersResizer.classList.remove('is-active');
    els.usersPanel.classList.remove('is-resizing');
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', stop);
    document.removeEventListener('pointercancel', stop);
    applyUsersPanelWidth(currentWidth, { persist: true });
  };

  els.usersResizer.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    dragging = true;
    startX = event.clientX;
    startWidth = els.usersPanel.getBoundingClientRect().width;
    currentWidth = startWidth;
    els.usersPanel.classList.add('is-resizing');
    els.usersResizer.classList.add('is-active');
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', stop);
    document.addEventListener('pointercancel', stop);
    event.preventDefault();
  });

  els.usersResizer.addEventListener('dblclick', () => {
    applyUsersPanelWidth(USERS_PANEL_DEFAULT, { persist: true });
  });

  els.usersResizer.addEventListener('keydown', (event) => {
    const current = els.usersPanel.getBoundingClientRect().width;
    if (event.key === 'ArrowLeft') {
      applyUsersPanelWidth(current + 16, { persist: true });
    } else if (event.key === 'ArrowRight') {
      applyUsersPanelWidth(current - 16, { persist: true });
    } else if (event.key === 'Home') {
      applyUsersPanelWidth(USERS_PANEL_DEFAULT, { persist: true });
    } else {
      return;
    }
    event.preventDefault();
  });

  window.addEventListener('resize', () => {
    if (els.usersPanel.classList.contains('is-collapsed')) return;
    applyUsersPanelWidth(els.usersPanel.getBoundingClientRect().width);
  });
}

function setPagesCollapsed(collapsed, { persist = true } = {}) {
  els.pagesPanel.classList.toggle('is-collapsed', collapsed);
  const toggle = $('#pages-toggle');
  if (toggle) {
    toggle.textContent = collapsed ? '»' : '«';
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('aria-label', collapsed ? 'Развернуть страницы' : 'Свернуть страницы');
  }
  if (persist) localStorage.setItem(PAGES_COLLAPSED_KEY, collapsed ? '1' : '0');
  state.board?.layout?.();
}

function setUsersCollapsed(collapsed, { persist = true } = {}) {
  els.usersPanel.classList.toggle('is-collapsed', collapsed);
  els.usersResizer.hidden = collapsed;
  if (collapsed) {
    els.usersPanel.style.width = '';
  } else {
    const saved = Number(localStorage.getItem(USERS_PANEL_KEY));
    applyUsersPanelWidth(saved > 0 ? saved : USERS_PANEL_DEFAULT);
  }
  els.usersToggle.textContent = collapsed ? '«' : '»';
  els.usersToggle.setAttribute('aria-expanded', String(!collapsed));
  els.usersToggle.setAttribute(
    'aria-label',
    collapsed ? 'Развернуть участников' : 'Свернуть участников',
  );
  if (persist) localStorage.setItem(USERS_COLLAPSED_KEY, collapsed ? '1' : '0');
  state.board?.layout?.();
}

function bindSidebarToggles() {
  els.usersToggle?.addEventListener('click', () => {
    setUsersCollapsed(!els.usersPanel.classList.contains('is-collapsed'));
  });
  els.invisibleToggle?.addEventListener('click', () => {
    state.invisible = !state.invisible;
    updateInvisibilityToggle();
    sendWorkspace({ type: 'set_invisible', invisible: state.invisible });
  });
  setPagesCollapsed(localStorage.getItem(PAGES_COLLAPSED_KEY) === '1', { persist: false });
  setUsersCollapsed(localStorage.getItem(USERS_COLLAPSED_KEY) === '1', { persist: false });
}

function bindWindowEvents() {
  window.addEventListener('beforeunload', () => state.sync?.close());
  document.addEventListener('paste', (event) => void handlePaste(event));
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
