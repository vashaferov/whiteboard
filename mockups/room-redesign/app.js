'use strict';

/* ------------------------------------------------------------------ utils */

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (char) => {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return map[char];
  });

const ICONS = {
  back: '<path d="M19 12H5" /><path d="M11 6l-6 6 6 6" />',
  board:
    '<rect x="3" y="4" width="18" height="13" rx="2.5" /><path d="M7.5 9.5c1.6-1.8 3.2 1.8 4.9 0 1.4-1.5 2.6.4 3.6.8" /><path d="M9 21l3-4 3 4" />',
  select: '<path d="M5 3l14 8-6 1.6L10 20z" />',
  brush: '<path d="M4 20c1-4 3-5 5-5s2 2 4 0 6-8 6-8l-3-3s-5 6-8 9c-1.5 1.5-3 3.5-4 7z" />',
  eraser: '<path d="M5 15l7-7 6 6-7 7H8z" /><path d="M4 21h16" />',
  rect: '<rect x="5" y="6" width="14" height="12" rx="1" />',
  circle: '<circle cx="12" cy="12" r="7" />',
  line: '<path d="M5 19L19 5" />',
  arrow: '<path d="M5 19L19 5" /><path d="M12 5h7v7" />',
  process: '<rect x="4" y="7" width="16" height="10" rx="1" />',
  decision: '<path d="M12 4l8 8-8 8-8-8z" />',
  terminator: '<rect x="4" y="7" width="16" height="10" rx="5" />',
  frame: '<rect x="4" y="4" width="16" height="16" stroke-dasharray="3 2" />',
  text: '<path d="M5 5h14M12 5v15M9 20h6" />',
  image:
    '<rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 16l5-5 4 4 3-3 6 6" /><circle cx="8.5" cy="9.5" r="1.5" />',
  presentation:
    '<rect x="3" y="4" width="18" height="12" rx="2" /><path d="M12 16v4M8 20h8" /><path d="M10 8l4 2-4 2z" />',
  undo: '<path d="M9 7L4 12l5 5" /><path d="M4 12h9a6 6 0 0 1 6 6v3" />',
  lock:
    '<rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" />',
  more:
    '<circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none" />',
  file: '<path d="M6 3h8l4 4v14H6z" /><path d="M14 3v5h5" /><path d="M9 14h6M9 17h4" />',
  boardSize: '<rect x="3" y="5" width="18" height="14" rx="2" /><path d="M8 9h8M8 13h5" />',
  trash:
    '<path d="M4 7h16" /><path d="M9 7V5h6v2" /><path d="M6 7l1 13h10l1-13" /><path d="M10 11v5M14 11v5" />',
  help:
    '<circle cx="12" cy="12" r="9" /><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .9-1 1.7" /><circle cx="12" cy="17" r=".8" fill="currentColor" stroke="none" />',
  logout:
    '<path d="M9 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h3" /><path d="M15 8l4 4-4 4" /><path d="M19 12H9" />',
  plus: '<path d="M12 5v14M5 12h14" />',
  chevronLeft: '<path d="M15 6l-6 6 6 6" />',
  chevronRight: '<path d="M9 6l6 6-6 6" />',
  chevronDown: '<path d="M6 9l6 6 6-6" />',
  close: '<path d="M6 6l12 12M18 6L6 18" />',
  eye: '<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z" /><circle cx="12" cy="12" r="2.5" />',
  eyeOff:
    '<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z" /><circle cx="12" cy="12" r="2.5" /><path d="M4 4l16 16" />',
  users:
    '<path d="M16 19v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1" /><circle cx="9.5" cy="7" r="3.5" /><path d="M17 11a3 3 0 1 0 0-6" /><path d="M21 19v-1a3.5 3.5 0 0 0-2.5-3.35" />',
  pages:
    '<rect x="4" y="4" width="13" height="16" rx="2" /><path d="M17 7h2a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1h-9" /><path d="M8 8h5M8 12h5" />',
  pencil: '<path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17z" /><path d="M13.5 7.5l3 3" />',
};

const icon = (name, className = '') =>
  `<svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;

const isMobile = () => window.matchMedia('(max-width: 900px)').matches;

const ROLE_LABELS = {
  teacher: 'Учитель',
  student: 'Ученик',
  admin: 'Администратор',
};

const USER_ROLE_LABELS = {
  teacher: 'Учитель',
  student: 'Ученик',
  admin: 'Админ',
};

const COLORS = ['#111827', '#2563eb', '#dc2626', '#16a34a', '#d97706', '#7c3aed', '#0891b2', '#db2777'];

const TOOLS = {
  select: { label: 'Выбор', key: 'V' },
  brush: { label: 'Кисть', key: 'B' },
  eraser: { label: 'Ластик', key: 'E' },
  rect: { label: 'Прямоугольник', key: 'R' },
  circle: { label: 'Круг', key: 'O' },
  line: { label: 'Линия', key: 'L' },
  arrow: { label: 'Стрелка', key: 'A' },
  process: { label: 'Процесс', key: 'P' },
  decision: { label: 'Решение', key: 'D' },
  terminator: { label: 'Начало/конец', key: 'S' },
  frame: { label: 'Фрейм', key: 'F' },
  text: { label: 'Текст', key: 'T' },
  image: { label: 'Картинка' },
};

const PEOPLE = [
  { id: 'u1', name: 'Софья', role: 'teacher', tint: 'violet', initials: 'С' },
  { id: 'u2', name: 'Вячеслав', role: 'student', tint: 'green', initials: 'В' },
  { id: 'u3', name: 'Мария', role: 'student', tint: 'amber', initials: 'М' },
  { id: 'u4', name: 'Администратор', role: 'admin', tint: 'blue', initials: 'А' },
];

const state = {
  role: 'teacher',
  presentation: false,
  activeTool: 'brush',
  color: '#2563eb',
  width: 4,
  zoom: 100,
  slideIndex: 3,
  slideTotal: 12,
  pages: [
    { id: 'p1', name: 'Разминка' },
    { id: 'p2', name: 'Квадратные уравнения' },
    { id: 'p3', name: 'Практика' },
    { id: 'p4', name: 'Презентация', kind: 'presentation', slides: 12 },
  ],
  activePageId: 'p2',
  beforePresentationPage: 'p2',
  selectedUsers: new Set(),
  pagesCollapsed: false,
  usersCollapsed: false,
  helpOpen: false,
  adminHidden: true,
  styleOpen: false,
  moreOpen: false,
  demoOpen: false,
  pageMenuId: null,
  renamingPageId: null,
  mobileSheet: false,
  mobilePanel: null,
};

/* ------------------------------------------------------------------ render */

function renderAll() {
  document.body.dataset.role = state.role;
  document.body.dataset.presentation = String(state.presentation);
  $('#role-chip').textContent = ROLE_LABELS[state.role];
  renderTopAvatars();
  renderDock();
  renderMobileDock();
  renderPages();
  renderUsers();
  renderMoreMenu();
  renderSheet();
  updateTopPopovers();
  updateDemoUI();
  updateSlide();
  updateBackdrop();
  updateCursor();
}

function visiblePeople() {
  return PEOPLE.filter((person) => !(state.role === 'student' && person.id === 'u4'));
}

function selfId() {
  if (state.role === 'teacher') return 'u1';
  if (state.role === 'student') return 'u2';
  return 'u4';
}

function renderTopAvatars() {
  const people = visiblePeople();
  const shown = people.slice(0, 2);
  const extra = people.length - shown.length;
  $('#top-avatars').innerHTML =
    shown
      .map((person) => `<span class="avatar avatar--${person.tint}">${escapeHtml(person.initials)}</span>`)
      .join('') + (extra > 0 ? `<span class="avatar avatar--amber">+${extra}</span>` : '');
}

function toolButton(tool) {
  const meta = TOOLS[tool];
  const key = meta.key ? ` (${meta.key})` : '';
  return `<button class="tool ${state.activeTool === tool ? 'is-active' : ''}" type="button" data-tool="${tool}" title="${meta.label}${key}" aria-label="${meta.label}">${icon(tool)}</button>`;
}

function actionButton(name) {
  const meta =
    name === 'undo'
      ? { icon: 'undo', title: 'Отменить (Ctrl+Z)', label: 'Отменить' }
      : { icon: 'lock', title: 'Замок', label: 'Замок' };
  return `<button class="icon-btn" type="button" data-action="${name}" title="${meta.title}" aria-label="${meta.label}">${icon(meta.icon)}</button>`;
}

function styleWrap() {
  return `<div class="style-wrap">
    <button class="style-btn" type="button" data-action="style" aria-expanded="${state.styleOpen}" title="Цвет и толщина">
      <span class="style-dot" style="--style-color:${state.color}"></span>
      <span class="style-label">${state.width} px</span>
    </button>
    ${state.styleOpen ? `<div class="popover style-popover">${stylePopover()}</div>` : ''}
  </div>`;
}

function stylePopover() {
  return `<p class="popover__label">Цвет и толщина</p>
    <div class="swatches">
      ${COLORS.map(
        (color) =>
          `<button class="swatch ${color === state.color ? 'is-active' : ''}" type="button" style="--c:${color}" data-color="${color}" aria-label="Цвет ${color}"></button>`,
      ).join('')}
    </div>
    <div class="width-row">
      <input type="range" min="1" max="30" value="${state.width}" data-width aria-label="Толщина" />
      <span class="style-label">${state.width} px</span>
    </div>`;
}

function renderDock() {
  const dock = $('#tool-dock');
  if (state.presentation) {
    if (state.role === 'student') {
      dock.innerHTML = '';
      return;
    }
    dock.innerHTML = `<div class="dock__group">${toolButton('brush')}${toolButton('eraser')}</div>
      <span class="dock__spacer"></span>${styleWrap()}${actionButton('undo')}`;
    return;
  }

  const staff = state.role !== 'student';
  const groups = [
    ['select'],
    ['brush', 'eraser'],
    ['rect', 'circle', 'line', 'arrow'],
    ['process', 'decision', 'terminator'],
    ['frame', 'text'],
    ['image'],
  ];

  let html = groups
    .map((group) => `<div class="dock__group">${group.map(toolButton).join('')}</div>`)
    .join('<span class="dock__sep"></span>');

  if (staff) {
    html += `<span class="dock__sep"></span><div class="dock__group">
      <button class="tool" type="button" data-action="presentation" title="Презентация" aria-label="Презентация">${icon('presentation')}</button>
    </div>`;
  }

  html += `<span class="dock__spacer"></span>${styleWrap()}${actionButton('undo')}`;
  if (staff && state.activeTool === 'select') html += actionButton('lock');
  dock.innerHTML = html;
}

function renderMobileDock() {
  const dock = $('#mobile-dock');
  if (state.presentation && state.role === 'student') {
    dock.hidden = true;
    dock.innerHTML = '';
    return;
  }
  dock.hidden = false;

  if (state.presentation) {
    dock.innerHTML = `${toolButton('brush')}${toolButton('eraser')}<span class="dock__spacer"></span>${styleWrap()}${actionButton('undo')}`;
    return;
  }

  dock.innerHTML =
    ['select', 'brush', 'eraser', 'rect', 'text'].map(toolButton).join('') +
    `<span class="dock__spacer"></span>${styleWrap()}<button class="icon-btn" type="button" data-action="mobile-more" title="Ещё" aria-label="Ещё">${icon('more')}</button>`;
}

/* ------------------------------------------------------------------- pages */

function renderPages() {
  const panel = $('#pages-panel');
  panel.classList.toggle('is-collapsed', state.pagesCollapsed && !isMobile());

  const staff = state.role !== 'student';
  let pages = state.pages;
  if (!staff) {
    pages = state.presentation
      ? pages.filter((page) => page.kind === 'presentation')
      : pages.filter((page) => page.kind !== 'presentation');
  }
  const activeId = state.presentation ? 'p4' : state.activePageId;
  const title = state.presentation && !staff ? 'Слайды' : 'Страницы';
  const toggleIcon = isMobile()
    ? icon('close')
    : icon(state.pagesCollapsed ? 'chevronRight' : 'chevronLeft');

  panel.innerHTML = `
    <div class="panel-head">
      <div class="panel-title">${title} <span class="panel-count">${pages.length}</span></div>
      <div class="panel-head__actions">
        ${
          staff
            ? `<button class="panel-btn panel-add-btn" type="button" data-action="add-page" title="Добавить страницу" aria-label="Добавить страницу">${icon('plus')}</button>`
            : ''
        }
        <button class="panel-btn" type="button" data-action="toggle-pages" title="${isMobile() ? 'Закрыть' : 'Свернуть'}">${toggleIcon}</button>
      </div>
    </div>
    <div class="page-list">${pages.map((page, index) => pageRow(page, index, activeId, staff)).join('')}</div>
    ${
      staff
        ? `<div class="panel-footer">
            <button class="btn btn--ghost btn--wide" type="button" data-action="add-page">${icon('plus')}Страница</button>
            <button class="link" type="button" data-action="upload-presentation">Загрузить презентацию</button>
          </div>`
        : `<div class="panel-footer"><p class="panel-hint">${
            state.presentation
              ? 'Слайды доступны только для просмотра.'
              : 'Страницы доступны только для просмотра.'
          }</p></div>`
    }`;

  if (state.renamingPageId) {
    const input = $(`[data-rename-input="${state.renamingPageId}"]`);
    if (input) {
      input.focus();
      input.select();
    }
  }
}

function pageRow(page, index, activeId, staff) {
  const active = page.id === activeId && (page.kind !== 'presentation' || state.presentation);
  const renaming = page.id === state.renamingPageId;
  const menuOpen = page.id === state.pageMenuId;
  const badge =
    page.kind === 'presentation'
      ? `<span class="page-row__badge">${state.presentation ? `${state.slideIndex} / ${page.slides}` : 'PDF'}</span>`
      : '';

  const content = renaming
    ? `<input class="page-row__input" data-rename-input="${page.id}" value="${escapeHtml(page.name)}" aria-label="Название страницы" />`
    : `<button class="page-row__select" type="button" data-page-id="${page.id}">
        <span class="page-row__num">${index + 1}</span>
        <span class="page-row__name">${escapeHtml(page.name)}</span>
        ${badge}
      </button>`;

  const menuButton =
    staff && !renaming
      ? `<button class="page-row__menu" type="button" data-page-menu="${page.id}" aria-label="Действия со страницей" aria-expanded="${menuOpen}">⋯</button>`
      : '';

  const menu = menuOpen
    ? `<div class="popover popover--menu page-menu">
        <button type="button" data-page-action="rename" data-page-id="${page.id}">${icon('pencil')}Переименовать</button>
        <button type="button" class="is-danger" data-page-action="delete" data-page-id="${page.id}">${icon('trash')}Удалить</button>
      </div>`
    : '';

  return `<div class="page-row ${active ? 'is-active' : ''}">${content}${menuButton}${menu}</div>`;
}

/* ------------------------------------------------------------------- users */

function renderUsers() {
  const panel = $('#users-panel');
  panel.classList.toggle('is-collapsed', state.usersCollapsed && !isMobile());

  const staff = state.role !== 'student';
  const people = visiblePeople();
  const currentId = selfId();
  const toggleIcon = isMobile()
    ? icon('close')
    : icon(state.usersCollapsed ? 'chevronLeft' : 'chevronRight');
  const eye =
    state.role === 'admin'
      ? `<button class="eye-btn" type="button" data-action="invisible" aria-pressed="${state.adminHidden}" title="${state.adminHidden ? 'Показать меня ученикам' : 'Скрыть меня от учеников'}">${icon(state.adminHidden ? 'eyeOff' : 'eye')}</button>`
      : '';
  const hint = state.presentation
    ? staff
      ? 'Рисуйте кистью поверх слайда. Листайте стрелками.'
      : 'Смотрите слайд и пометки учителя.'
    : staff
      ? 'Двойной клик по тексту — редактировать. Рамка — масштаб и поворот.'
      : 'Свои объекты можно двигать, масштабировать и поворачивать. Двойной клик по своему тексту — редактировать.';

  panel.innerHTML = `
    <div class="panel-head">
      <div class="panel-title">Участники <span class="panel-count">${people.length}</span></div>
      <div class="panel-head__actions">
        ${eye}
        <button class="panel-btn" type="button" data-action="toggle-users" title="${isMobile() ? 'Закрыть' : 'Свернуть'}">${toggleIcon}</button>
      </div>
    </div>
    <div class="user-list">${people.map((person) => userRow(person, currentId, staff)).join('')}</div>
    ${
      staff
        ? `<div class="pull">
            <button class="btn btn--ghost" type="button" data-action="pull-selected" ${state.selectedUsers.size ? '' : 'disabled'}>К себе</button>
            <button class="btn btn--primary" type="button" data-action="pull-all">Всех к себе</button>
          </div>`
        : ''
    }
    <p class="panel-hint">${hint}</p>
    <div class="help">
      <button class="help-toggle" type="button" data-action="toggle-help" aria-expanded="${state.helpOpen}">
        Горячие клавиши ${icon('chevronDown')}
      </button>
      ${state.helpOpen ? helpList(staff) : ''}
    </div>`;
}

function userRow(person, currentId, staff) {
  const isSelf = person.id === currentId;
  const showCheck = staff && person.role === 'student';
  const canKick = staff && person.role === 'student';

  return `<div class="user-row">
    ${
      showCheck
        ? `<input class="user-row__check" type="checkbox" data-pull-user="${person.id}" ${state.selectedUsers.has(person.id) ? 'checked' : ''} aria-label="Выбрать ${escapeHtml(person.name)}" />`
        : ''
    }
    <span class="user-avatar user-avatar--${person.tint}">${escapeHtml(person.initials)}</span>
    <span class="user-row__text">
      <span class="user-row__name">${escapeHtml(person.name)}</span>
      <span class="user-row__role">${USER_ROLE_LABELS[person.role]}</span>
    </span>
    ${isSelf ? '<span class="self-badge">Вы</span>' : ''}
    ${
      canKick
        ? `<button class="user-row__menu" type="button" data-kick="${person.id}" title="Отключить" aria-label="Отключить ${escapeHtml(person.name)}">×</button>`
        : ''
    }
  </div>`;
}

function helpList(staff) {
  return `<div class="help-list">
    <p><kbd>B</kbd> кисть · <kbd>E</kbd> ластик</p>
    <p><kbd>R</kbd> прямоугольник · <kbd>O</kbd> круг</p>
    <p><kbd>L</kbd> линия · <kbd>A</kbd> стрелка</p>
    <p><kbd>P</kbd> процесс · <kbd>D</kbd> решение · <kbd>S</kbd> начало/конец</p>
    <p><kbd>T</kbd> текст · <kbd>V</kbd> выбор · <kbd>F</kbd> фрейм</p>
    ${staff ? '<p><kbd>Del</kbd> удалить</p>' : ''}
  </div>`;
}

/* --------------------------------------------------------------- top menus */

function renderMoreMenu() {
  const menu = $('#more-popover');
  const staff = state.role !== 'student';
  menu.innerHTML = `
    ${
      staff
        ? `<button type="button" data-action="pdf">${icon('file')}Экспорт в PDF</button>
           <button type="button" data-action="board-size">${icon('boardSize')}Размер холста</button>
           <button type="button" class="is-danger" data-action="clear">${icon('trash')}Очистить доску</button>
           <div class="popover__divider"></div>`
        : ''
    }
    <button type="button" data-action="help">${icon('help')}Горячие клавиши</button>
    <button type="button" data-action="leave">${icon('logout')}Выйти из комнаты</button>`;
}

function updateTopPopovers() {
  $('#more-popover').hidden = !state.moreOpen;
  $('#demo-popover').hidden = !state.demoOpen;
  $('[data-action="more"]').setAttribute('aria-expanded', String(state.moreOpen));
  $('[data-action="demo"]').setAttribute('aria-expanded', String(state.demoOpen));
}

function updateDemoUI() {
  $$('#demo-roles button').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.demoRole === state.role);
  });
  const checkbox = $('#demo-presentation');
  if (checkbox) checkbox.checked = state.presentation;
}

/* ------------------------------------------------------------- presentation */

function updateSlide() {
  state.slideIndex = Math.max(1, Math.min(state.slideTotal, state.slideIndex));
  $('#slide-counter').textContent = `${state.slideIndex} / ${state.slideTotal}`;
  const number = $('#slide-number');
  if (number) number.textContent = `${state.slideIndex} / ${state.slideTotal}`;
  const live = $('#slide-live-text');
  if (live) live.textContent = state.role === 'student' ? 'Просмотр' : 'Презентация';
  const previous = $('#slide-prev');
  const next = $('#slide-next');
  if (previous) previous.disabled = state.slideIndex <= 1;
  if (next) next.disabled = state.slideIndex >= state.slideTotal;

  $('#slide-bar').hidden = !state.presentation;
  $('#view-badge').hidden = !(state.presentation && state.role === 'student');

  if (state.presentation) {
    $('#context-chip').textContent = `Презентация · Слайд ${state.slideIndex} из ${state.slideTotal}`;
  } else {
    const page = state.pages.find((item) => item.id === state.activePageId);
    $('#context-chip').textContent = page ? page.name : 'Страница';
  }
}

function updateCursor() {
  const studentView = state.role === 'student';
  const name = studentView ? 'Софья' : 'Вячеслав';
  const color = studentView ? '#7c3aed' : '#15803d';
  const nameElement = $('#cursor-name');
  if (nameElement) nameElement.textContent = name;
  $('#cursor-pointer')?.setAttribute('fill', color);
  $('#cursor-tag')?.setAttribute('fill', color);
}

/* ------------------------------------------------------------------- sheet */

function renderSheet() {
  const sheet = $('#mobile-sheet');
  if (!state.mobileSheet) {
    sheet.hidden = true;
    sheet.innerHTML = '';
    return;
  }
  sheet.hidden = false;

  const staff = state.role !== 'student';
  const tools = [
    'select',
    'brush',
    'eraser',
    'rect',
    'circle',
    'line',
    'arrow',
    'process',
    'decision',
    'terminator',
    'frame',
    'text',
    'image',
  ];

  sheet.innerHTML = `
    <div class="mobile-sheet__head">
      <h2>Инструменты</h2>
      <button class="icon-btn" type="button" data-action="close-sheet" aria-label="Закрыть">${icon('close')}</button>
    </div>
    <div class="mobile-sheet__grid">
      ${tools
        .map(
          (tool) =>
            `<button class="tool ${state.activeTool === tool ? 'is-active' : ''}" type="button" data-tool="${tool}">${icon(tool)}<span>${TOOLS[tool].label}</span></button>`,
        )
        .join('')}
    </div>
    <div class="mobile-sheet__actions">
      <button class="btn btn--ghost" type="button" data-action="undo">${icon('undo')}Отменить</button>
      ${
        staff
          ? `<button class="btn btn--ghost" type="button" data-action="lock">${icon('lock')}Замок</button>
             <button class="btn btn--primary" type="button" data-action="presentation">${icon('presentation')}Презентация</button>
             <button class="btn btn--ghost" type="button" data-action="pdf">${icon('file')}Экспорт в PDF</button>
             <button class="btn btn--ghost" type="button" data-action="clear">${icon('trash')}Очистить доску</button>`
          : ''
      }
      <button class="btn btn--ghost" type="button" data-action="help">${icon('help')}Горячие клавиши</button>
    </div>`;
}

function updateBackdrop() {
  const open =
    state.mobileSheet ||
    $('#pages-panel').classList.contains('is-open') ||
    $('#users-panel').classList.contains('is-open');
  $('#sheet-backdrop').hidden = !open;
}

/* --------------------------------------------------------------- overlays */

function closeTopPopovers() {
  state.moreOpen = false;
  state.demoOpen = false;
  updateTopPopovers();
}

function closeStyle() {
  if (!state.styleOpen) return;
  state.styleOpen = false;
  renderDock();
  renderMobileDock();
}

function closePageMenu() {
  if (!state.pageMenuId) return;
  state.pageMenuId = null;
  renderPages();
}

function closeMobileOverlays() {
  $('#pages-panel').classList.remove('is-open');
  $('#users-panel').classList.remove('is-open');
  state.mobilePanel = null;
  state.mobileSheet = false;
  $('#mobile-sheet').hidden = true;
  $('#mobile-sheet').innerHTML = '';
  updateBackdrop();
}

function openPanel(which) {
  closeMobileOverlays();
  const panel = which === 'pages' ? $('#pages-panel') : $('#users-panel');
  panel.classList.remove('is-collapsed');
  panel.classList.add('is-open');
  state.mobilePanel = which;
  updateBackdrop();
}

function togglePanel(which) {
  if (isMobile()) {
    const panel = which === 'pages' ? $('#pages-panel') : $('#users-panel');
    const open = panel.classList.contains('is-open');
    closeMobileOverlays();
    if (!open) openPanel(which);
    return;
  }

  if (which === 'pages') {
    state.pagesCollapsed = !state.pagesCollapsed;
    renderPages();
  } else {
    state.usersCollapsed = !state.usersCollapsed;
    renderUsers();
  }
}

function openMobileSheet() {
  $('#pages-panel').classList.remove('is-open');
  $('#users-panel').classList.remove('is-open');
  state.mobilePanel = null;
  state.mobileSheet = true;
  renderSheet();
  updateBackdrop();
}

function openHelp() {
  state.helpOpen = true;
  state.usersCollapsed = false;
  state.mobileSheet = false;
  renderUsers();
  renderSheet();
  if (isMobile()) openPanel('users');
  closeTopPopovers();
  renderDock();
  renderMobileDock();
  updateBackdrop();
}

/* --------------------------------------------------------------- actions */

function setRole(role) {
  state.role = role;
  state.selectedUsers.clear();
  state.pageMenuId = null;
  state.renamingPageId = null;
  if (role !== 'admin') state.adminHidden = true;
  if (role === 'student' && !state.presentation && state.activePageId === 'p4') {
    state.activePageId = 'p2';
  }
  renderAll();
}

function setPresentation(enabled) {
  if (enabled === state.presentation) return;
  if (enabled) {
    if (state.activePageId !== 'p4') state.beforePresentationPage = state.activePageId;
    state.presentation = true;
    state.activePageId = 'p4';
  } else {
    state.presentation = false;
    state.activePageId = state.beforePresentationPage === 'p4' ? 'p2' : state.beforePresentationPage || 'p2';
  }
  state.pageMenuId = null;
  renderAll();
  showToast(enabled ? 'Режим презентации включён' : 'Режим презентации выключен');
}

function selectPage(id) {
  const page = state.pages.find((item) => item.id === id);
  if (!page) return;

  if (page.kind === 'presentation') {
    if (state.activePageId !== 'p4') state.beforePresentationPage = state.activePageId;
    state.presentation = true;
    state.activePageId = 'p4';
  } else {
    state.presentation = false;
    state.activePageId = page.id;
  }

  state.pageMenuId = null;
  if (isMobile()) closeMobileOverlays();
  renderAll();
}

function addPage() {
  if (state.role === 'student') return;
  const id = `p${Date.now()}`;
  state.pages.push({ id, name: `Страница ${state.pages.length + 1}` });
  state.presentation = false;
  state.activePageId = id;
  state.pageMenuId = null;
  renderAll();
  if (isMobile()) closeMobileOverlays();
  showToast('Страница добавлена');
}

function deletePage(id) {
  if (state.role === 'student') return;
  if (state.pages.length <= 1) {
    showToast('Нельзя удалить последнюю страницу');
    return;
  }
  const page = state.pages.find((item) => item.id === id);
  if (!page) return;
  state.pages = state.pages.filter((item) => item.id !== id);
  if (state.activePageId === id) {
    const first = state.pages.find((item) => item.kind !== 'presentation') || state.pages[0];
    state.activePageId = first.id;
    state.presentation = false;
  }
  state.pageMenuId = null;
  renderAll();
  showToast('Страница удалена');
}

function beginRename(id) {
  state.renamingPageId = id;
  state.pageMenuId = null;
  renderPages();
}

function commitRename() {
  if (!state.renamingPageId) return;
  const id = state.renamingPageId;
  const input = $('[data-rename-input]');
  const page = state.pages.find((item) => item.id === id);
  const name = input?.value.trim();
  if (page && name) page.name = name;
  state.renamingPageId = null;
  renderPages();
  if (name) showToast('Название страницы обновлено');
}

function togglePageMenu(id) {
  state.pageMenuId = state.pageMenuId === id ? null : id;
  state.styleOpen = false;
  state.moreOpen = false;
  state.demoOpen = false;
  renderPages();
  renderDock();
  renderMobileDock();
  updateTopPopovers();
}

function handlePageAction(action, id) {
  if (action === 'rename') {
    beginRename(id);
    return;
  }
  if (action === 'delete') deletePage(id);
}

function selectTool(tool) {
  if (!TOOLS[tool]) return;
  state.activeTool = tool;
  state.styleOpen = false;
  state.moreOpen = false;
  state.demoOpen = false;
  state.pageMenuId = null;
  state.mobileSheet = false;
  renderDock();
  renderMobileDock();
  renderPages();
  renderSheet();
  updateTopPopovers();
  updateBackdrop();
}

function toggleStyle() {
  state.styleOpen = !state.styleOpen;
  state.moreOpen = false;
  state.demoOpen = false;
  state.pageMenuId = null;
  renderDock();
  renderMobileDock();
  renderPages();
  updateTopPopovers();
}

function toggleMore() {
  state.moreOpen = !state.moreOpen;
  state.styleOpen = false;
  state.demoOpen = false;
  state.pageMenuId = null;
  renderMoreMenu();
  renderDock();
  renderMobileDock();
  renderPages();
  updateTopPopovers();
}

function toggleDemo() {
  state.demoOpen = !state.demoOpen;
  state.styleOpen = false;
  state.moreOpen = false;
  state.pageMenuId = null;
  renderDock();
  renderMobileDock();
  renderPages();
  updateTopPopovers();
  updateDemoUI();
}

function toggleInvisible() {
  state.adminHidden = !state.adminHidden;
  renderUsers();
  showToast(state.adminHidden ? 'Администратор скрыт от учеников' : 'Администратор виден ученикам');
}

function pullSelected() {
  if (!state.selectedUsers.size) return;
  const count = state.selectedUsers.size;
  state.selectedUsers.clear();
  renderUsers();
  showToast(`${count} ${count === 1 ? 'ученик перенесён' : 'ученика перенесены'} на вашу страницу`);
}

function pullAll() {
  state.selectedUsers.clear();
  renderUsers();
  showToast('Все ученики перенесены на вашу страницу');
}

function kickUser(id) {
  const person = PEOPLE.find((item) => item.id === id);
  if (!person) return;
  showToast(`${person.name} отключён (демо)`);
}

function handleZoom(action) {
  if (action === 'reset') state.zoom = 100;
  else state.zoom = Math.max(50, Math.min(400, state.zoom + (action === 'in' ? 25 : -25)));
  $$('.zoom__value').forEach((element) => {
    element.textContent = `${state.zoom}%`;
  });
}

function handleAction(action, element) {
  if (action === 'back') {
    window.location.href = '../main-page-redesign/index.html';
    return;
  }

  if (action === 'leave') {
    closeTopPopovers();
    showToast('В рабочей версии вы вернётесь к комнатам');
    return;
  }

  if (action === 'toggle-pages' || action === 'toggle-users') {
    togglePanel(action === 'toggle-pages' ? 'pages' : 'users');
    return;
  }

  if (action === 'add-page') {
    addPage();
    return;
  }

  if (action === 'upload-presentation') {
    showToast('Загрузка PDF — в рабочей версии');
    return;
  }

  if (action === 'undo') {
    showToast('Последнее действие отменено');
    return;
  }

  if (action === 'lock') {
    showToast('Объект заблокирован (демо)');
    return;
  }

  if (action === 'presentation') {
    setPresentation(!state.presentation);
    return;
  }

  if (action === 'style') {
    toggleStyle();
    return;
  }

  if (action === 'more') {
    toggleMore();
    return;
  }

  if (action === 'demo') {
    toggleDemo();
    return;
  }

  if (action === 'mobile-more') {
    openMobileSheet();
    return;
  }

  if (action === 'close-sheet') {
    state.mobileSheet = false;
    renderSheet();
    updateBackdrop();
    return;
  }

  if (action === 'invisible') {
    toggleInvisible();
    return;
  }

  if (action === 'pull-selected') {
    pullSelected();
    return;
  }

  if (action === 'pull-all') {
    pullAll();
    return;
  }

  if (action === 'help') {
    openHelp();
    return;
  }

  if (action === 'toggle-help') {
    state.helpOpen = !state.helpOpen;
    renderUsers();
    return;
  }

  if (action === 'pdf') {
    closeTopPopovers();
    showToast('Экспорт PDF — в рабочей версии');
    return;
  }

  if (action === 'board-size') {
    closeTopPopovers();
    showToast('Размер холста — в рабочей версии');
    return;
  }

  if (action === 'clear') {
    closeTopPopovers();
    showToast('Очистка доски — в рабочей версии');
  }
}

/* ----------------------------------------------------------------- events */

document.addEventListener('click', (event) => {
  const actionElement = event.target.closest('[data-action]');
  if (actionElement) {
    if (actionElement.closest('#mobile-sheet') && actionElement.dataset.action !== 'close-sheet') {
      state.mobileSheet = false;
      renderSheet();
      updateBackdrop();
    }
    handleAction(actionElement.dataset.action, actionElement);
    return;
  }

  const demoRole = event.target.closest('[data-demo-role]');
  if (demoRole) {
    setRole(demoRole.dataset.demoRole);
    return;
  }

  const tool = event.target.closest('[data-tool]');
  if (tool) {
    selectTool(tool.dataset.tool);
    return;
  }

  const pageMenu = event.target.closest('[data-page-menu]');
  if (pageMenu) {
    togglePageMenu(pageMenu.dataset.pageMenu);
    return;
  }

  const pageAction = event.target.closest('[data-page-action]');
  if (pageAction) {
    handlePageAction(pageAction.dataset.pageAction, pageAction.dataset.pageId);
    return;
  }

  const pageSelect = event.target.closest('[data-page-id]');
  if (pageSelect) {
    selectPage(pageSelect.dataset.pageId);
    return;
  }

  const color = event.target.closest('[data-color]');
  if (color) {
    state.color = color.dataset.color;
    renderDock();
    renderMobileDock();
    return;
  }

  const kick = event.target.closest('[data-kick]');
  if (kick) {
    kickUser(kick.dataset.kick);
    return;
  }

  const zoom = event.target.closest('[data-zoom]');
  if (zoom) {
    handleZoom(zoom.dataset.zoom);
    return;
  }

  if (!event.target.closest('.style-wrap') && state.styleOpen) {
    state.styleOpen = false;
    renderDock();
    renderMobileDock();
  }

  if (!event.target.closest('.popover-wrap') && (state.moreOpen || state.demoOpen)) {
    closeTopPopovers();
  }

  if (!event.target.closest('.page-row') && state.pageMenuId) {
    closePageMenu();
  }
});

document.addEventListener('change', (event) => {
  if (event.target.id === 'demo-presentation') {
    setPresentation(event.target.checked);
    return;
  }

  const checkbox = event.target.closest('[data-pull-user]');
  if (checkbox) {
    if (checkbox.checked) state.selectedUsers.add(checkbox.dataset.pullUser);
    else state.selectedUsers.delete(checkbox.dataset.pullUser);
    const button = $('[data-action="pull-selected"]');
    if (button) button.disabled = state.selectedUsers.size === 0;
  }
});

document.addEventListener('input', (event) => {
  if (!event.target.matches('[data-width]')) return;
  state.width = Number(event.target.value);
  $$('[data-width]').forEach((input) => {
    input.value = state.width;
  });
  $$('.style-label').forEach((label) => {
    label.textContent = `${state.width} px`;
  });
});

document.addEventListener('keydown', (event) => {
  if (event.target.matches('[data-rename-input]')) {
    if (event.key === 'Enter') {
      event.preventDefault();
      commitRename();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      state.renamingPageId = null;
      renderPages();
      return;
    }
  }

  if (event.key !== 'Escape') return;

  if (state.renamingPageId) {
    state.renamingPageId = null;
    renderPages();
    return;
  }

  if (state.mobileSheet || state.mobilePanel) {
    closeMobileOverlays();
    renderPages();
    renderUsers();
    return;
  }

  if (state.styleOpen) {
    state.styleOpen = false;
    renderDock();
    renderMobileDock();
  }
  if (state.moreOpen || state.demoOpen) closeTopPopovers();
  if (state.pageMenuId) closePageMenu();
});

document.addEventListener('focusout', (event) => {
  if (!event.target.matches('[data-rename-input]')) return;
  const id = state.renamingPageId;
  setTimeout(() => {
    if (state.renamingPageId === id) commitRename();
  }, 0);
});

$('#slide-prev').addEventListener('click', () => {
  state.slideIndex = Math.max(1, state.slideIndex - 1);
  updateSlide();
  renderPages();
});

$('#slide-next').addEventListener('click', () => {
  state.slideIndex = Math.min(state.slideTotal, state.slideIndex + 1);
  updateSlide();
  renderPages();
});

$('#sheet-backdrop').addEventListener('click', () => {
  closeMobileOverlays();
  renderPages();
  renderUsers();
});

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (!isMobile()) closeMobileOverlays();
    state.styleOpen = false;
    state.moreOpen = false;
    state.demoOpen = false;
    state.pageMenuId = null;
    renderAll();
  }, 120);
});

/* ------------------------------------------------------------------ toast */

let toastTimer = null;

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 2400);
}

/* ------------------------------------------------------------------- init */

renderAll();
