/** Дашборд «Кабинет»: комнаты, доступ и администрирование по ролям. */

import { adminApi, roomsApi, usersApi } from './api.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const ROLE_LABELS = {
  student: 'Ученик',
  teacher: 'Учитель',
  admin: 'Администратор',
};

const STATUS_LABELS = {
  pending: 'Заявка',
  active: 'Активен',
  blocked: 'Заблокирован',
  rejected: 'Отклонён',
};

const ROOM_TINTS = [
  { accent: '#2563eb', soft: '#e8efff' },
  { accent: '#7c3aed', soft: '#f1eaff' },
  { accent: '#0f766e', soft: '#e3f6f1' },
  { accent: '#b45309', soft: '#fff3df' },
  { accent: '#be185d', soft: '#fdeaf5' },
];

const ICON_PATHS = {
  board:
    '<rect x="3" y="4" width="18" height="13" rx="2.5" /><path d="M7.5 9.5c1.6-1.8 3.2 1.8 4.9 0 1.4-1.5 2.6.4 3.6.8" /><path d="M9 21l3-4 3 4" />',
  users:
    '<path d="M16 19v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1" /><circle cx="9.5" cy="7" r="3.5" /><path d="M17 11a3 3 0 1 0 0-6" /><path d="M21 19v-1a3.5 3.5 0 0 0-2.5-3.35" />',
  shield:
    '<path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z" /><path d="M9.5 12l1.7 1.7L15 10" />',
  plus: '<path d="M12 5v14M5 12h14" />',
  search: '<circle cx="11" cy="11" r="7" /><path d="M20 20l-3.2-3.2" />',
  refresh: '<path d="M20 11a8 8 0 1 0-1.4 4.6" /><path d="M20 4.5v6h-6" />',
  arrowRight: '<path d="M5 12h14" /><path d="M14 7l5 5-5 5" />',
  more:
    '<circle cx="5" cy="12" r="1.5" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1.5" fill="currentColor" stroke="none" />',
  pencil:
    '<path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17z" /><path d="M13.5 7.5l3 3" />',
  trash:
    '<path d="M4 7h16" /><path d="M9 7V5h6v2" /><path d="M6 7l1 13h10l1-13" /><path d="M10 11v5M14 11v5" />',
  spark:
    '<path d="M12 3l1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8z" /><path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z" />',
};

const icon = (name) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name]}</svg>`;

const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (char) => {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return map[char];
  });

const plural = (count, one, few, many) => {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return `${count} ${one}`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${count} ${few}`;
  return `${count} ${many}`;
};

const roomsLabel = (count) => plural(count, 'комната', 'комнаты', 'комнат');
const studentsLabel = (count) => plural(count, 'ученик', 'ученика', 'учеников');
const initial = (name) => (name || '?').trim().charAt(0).toUpperCase();

let els = null;
let handlers = {
  onOpenRoom: () => {},
  onLogout: () => {},
  onSessionLost: () => {},
};

let currentUser = null;
let currentPermissions = null;
let page = 'rooms';
let rooms = [];
let users = [];
let userCounts = { all: 0, pending: 0, active: 0, blocked: 0 };
let pendingTotal = 0;
let roomsLoading = false;
let adminDataLoading = false;
let userRowsLoading = false;
let roomsError = '';
let roomSearch = '';
let userSearch = '';
let userFilter = 'all';
let userSearchTimer = null;
let accessRoom = null;
let accessStudents = [];
let accessSelected = new Set();
let accessSelectedDetails = new Map();
let accessSearch = '';
let accessLoading = false;
let accessSearchTimer = null;
let accessRequest = 0;
let renameTarget = null;
let deleteTarget = null;
let passwordTarget = null;
let toastTimer = null;

/* ------------------------------------------------------------------ setup */

export function initDashboard(options) {
  handlers = { ...handlers, ...options };
  cacheElements();

  els.logout.addEventListener('click', () => handlers.onLogout());
  els.root.addEventListener('click', handleRootClick);
  els.root.addEventListener('change', handleRootChange);
  els.root.addEventListener('input', handleRootInput);

  document.addEventListener('click', (event) => {
    if (!event.target.closest('.db-card-menu-wrap')) closeCardMenus();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeCardMenus();
  });

  $('#create-room-form').addEventListener('submit', createRoom);
  $('#rename-room-form').addEventListener('submit', renameRoom);
  $('#password-form').addEventListener('submit', savePassword);
  $('#delete-room-confirm').addEventListener('click', deleteRoom);
  $('#access-save').addEventListener('click', saveAccess);
  $('#access-clear').addEventListener('click', () => {
    accessSelected.clear();
    accessSelectedDetails.clear();
    renderAccessList();
  });

  window.addEventListener('focus', () => {
    if (els.root.hidden) return;
    loadRooms();
    if (isAdmin() && !adminDataLoading) loadAdminData({ silent: true });
    if (page === 'users' && !userRowsLoading) loadUserRows({ silent: true });
  });
}

function cacheElements() {
  els = {
    root: $('#dashboard'),
    nav: $('#db-nav'),
    tip: $('#db-tip'),
    avatar: $('#dash-avatar'),
    name: $('#dash-name'),
    role: $('#dash-role'),
    eyebrow: $('#db-eyebrow'),
    title: $('#db-title'),
    subtitle: $('#db-subtitle'),
    actions: $('#db-page-actions'),
    body: $('#db-page-body'),
    logout: $('#logout-btn'),
    createDialog: $('#create-room-dialog'),
    createName: $('#create-room-name'),
    createError: $('#create-room-error'),
    createSubmit: $('#create-room-submit'),
    renameDialog: $('#rename-room-dialog'),
    renameName: $('#rename-room-name'),
    renameError: $('#rename-room-error'),
    deleteDialog: $('#delete-room-dialog'),
    deleteText: $('#delete-room-text'),
    deleteError: $('#delete-room-error'),
    accessDialog: $('#access-dialog'),
    accessTitle: $('#access-title'),
    accessSearch: $('#access-search'),
    accessList: $('#access-list'),
    accessEmpty: $('#access-empty'),
    accessCount: $('#access-count'),
    accessError: $('#access-error'),
    accessSave: $('#access-save'),
    passwordDialog: $('#password-dialog'),
    passwordText: $('#password-text'),
    passwordValue: $('#password-value'),
    passwordError: $('#password-error'),
    toast: $('#toast'),
  };
}

export function showDashboard({ user, permissions }) {
  currentUser = user;
  currentPermissions = permissions;
  page = 'rooms';
  rooms = [];
  users = [];
  userCounts = { all: 0, pending: 0, active: 0, blocked: 0 };
  pendingTotal = 0;
  roomsLoading = true;
  adminDataLoading = Boolean(permissions?.canManageAccounts);
  userRowsLoading = false;
  roomsError = '';
  roomSearch = '';
  userSearch = '';
  userFilter = 'all';
  accessRoom = null;
  renameTarget = null;
  deleteTarget = null;
  passwordTarget = null;

  closeAllDialogs();
  els.root.hidden = false;
  $('#auth').hidden = true;
  $('#status-screen').hidden = true;
  $('#app').hidden = true;
  els.root.scrollTop = 0;

  renderShell();
  renderPage();
  loadRooms();
  if (isAdmin()) loadAdminData({ silent: true });
}

function isAdmin() {
  return currentUser?.role === 'admin';
}

function canManageRoom(room) {
  if (!currentUser) return false;
  return isAdmin() || (currentUser.role === 'teacher' && room.owner.id === currentUser.id);
}

/* ------------------------------------------------------------------ shell */

function navItems() {
  if (isAdmin()) {
    return [
      { id: 'rooms', label: 'Все комнаты', icon: 'shield', navId: 'admin-tab-rooms' },
      {
        id: 'users',
        label: 'Пользователи',
        icon: 'users',
        navId: 'admin-tab-users',
        badge: pendingCount(),
      },
    ];
  }
  if (currentUser?.role === 'teacher') {
    return [{ id: 'rooms', label: 'Мои комнаты', icon: 'board' }];
  }
  return [{ id: 'rooms', label: 'Мои занятия', icon: 'board' }];
}

function pendingCount() {
  return pendingTotal;
}

function renderShell() {
  if (!currentUser) return;
  els.name.textContent = currentUser.name;
  els.role.textContent = ROLE_LABELS[currentUser.role] || currentUser.role;
  els.avatar.textContent = initial(currentUser.name);
  els.avatar.className =
    currentUser.role === 'teacher'
      ? 'db-avatar db-avatar--teacher'
      : currentUser.role === 'admin'
        ? 'db-avatar db-avatar--admin'
        : 'db-avatar';

  els.nav.innerHTML = navItems()
    .map(
      (item) => `
        <button
          type="button"
          class="db-nav__item ${page === item.id ? 'is-active' : ''}"
          data-nav="${item.id}"
          ${item.navId ? `id="${item.navId}"` : ''}
          ${page === item.id ? 'aria-current="page"' : ''}
        >
          ${icon(item.icon)}
          <span>${escapeHtml(item.label)}</span>
          ${item.badge ? `<span class="db-nav__badge">${item.badge}</span>` : ''}
        </button>`,
    )
    .join('');

  renderTip();
}

function renderTip() {
  if (!currentUser) return;
  if (isAdmin()) {
    const pending = pendingCount();
    if (adminDataLoading && !userCounts.all) {
      els.tip.innerHTML = `
        <div class="db-tip-card">
          <div class="db-tip-card__head">${icon('shield')} Заявки</div>
          <p>Загружаем список пользователей…</p>
        </div>`;
      return;
    }
    els.tip.innerHTML = `
      <div class="db-tip-card">
        <div class="db-tip-card__head">${icon('shield')} ${pending ? 'Нужно внимание' : 'Всё в порядке'}</div>
        <p>${
          pending
            ? `${plural(pending, 'заявка ждёт', 'заявки ждут', 'заявок ждут')} подтверждения.`
            : 'Новых заявок на регистрацию нет.'
        }</p>
        ${pending ? '<button type="button" class="db-link" data-db-action="open-pending">Открыть заявки</button>' : ''}
      </div>`;
    return;
  }

  const teacher = currentUser.role === 'teacher';
  els.tip.innerHTML = `
    <div class="db-tip-card">
      <div class="db-tip-card__head">${icon('spark')} ${teacher ? 'Совет' : 'Как это работает'}</div>
      <p>${
        teacher
          ? 'Выдайте доступ к комнате — и ученик увидит её на своей главной.'
          : 'Когда учитель выдаст доступ к комнате, она появится в этом списке.'
      }</p>
    </div>`;
}

/* ------------------------------------------------------------------ rooms */

function setPageMeta({ title, subtitle, eyebrow }) {
  els.eyebrow.textContent = eyebrow;
  els.title.textContent = title;
  els.subtitle.textContent = subtitle;
}

function renderPage() {
  if (isAdmin() && page === 'users') {
    renderUsersPage();
    return;
  }
  renderRoomsPage();
}

function visibleRooms() {
  if (isAdmin()) return rooms;
  if (currentUser?.role === 'teacher') {
    return rooms.filter((room) => room.owner.id === currentUser.id);
  }
  return rooms;
}

function renderRoomsPage() {
  if (!currentUser) return;
  const isStudent = currentUser.role === 'student';
  const isTeacher = currentUser.role === 'teacher';

  setPageMeta({
    title: isStudent ? 'Мои занятия' : isAdmin() ? 'Все комнаты' : 'Мои комнаты',
    subtitle: isStudent
      ? 'Комнаты, которые открыл для вас учитель.'
      : isAdmin()
        ? 'Комнаты всех учителей. Откройте любую или создайте новую.'
        : 'Создавайте комнаты и выдавайте доступ ученикам.',
    eyebrow: isAdmin() ? 'Администрирование' : isTeacher ? 'Кабинет учителя' : 'Кабинет ученика',
  });

  els.actions.innerHTML = isStudent
    ? `<button type="button" class="btn btn--ghost" data-db-action="refresh">${icon('refresh')}Обновить</button>`
    : `<button type="button" class="btn btn--primary" id="create-room" data-db-action="create">${icon('plus')}Создать комнату</button>`;

  els.body.innerHTML = `
    <section id="dash-rooms">
      <div class="db-list-toolbar">
        <span class="db-list-count" id="rooms-count"></span>
        <label class="db-search">
          ${icon('search')}
          <input
            id="room-search"
            type="search"
            value="${escapeHtml(roomSearch)}"
            placeholder="Найти комнату"
            autocomplete="off"
            aria-label="Поиск комнат"
          />
        </label>
      </div>
      <div id="dash-rooms-grid"></div>
    </section>`;

  renderRoomCards();
}

function renderRoomCards() {
  const grid = $('#dash-rooms-grid');
  const count = $('#rooms-count');
  if (!grid || !count) return;

  if (roomsLoading) {
    count.textContent = 'Загрузка…';
    grid.innerHTML = '<p class="db-loading">Загружаем комнаты…</p>';
    return;
  }

  const base = visibleRooms();
  const query = roomSearch.trim().toLowerCase();
  const filtered = query
    ? base.filter(
        (room) =>
          room.name.toLowerCase().includes(query) ||
          room.owner.name.toLowerCase().includes(query),
      )
    : base;

  count.textContent = query
    ? `Найдено: ${filtered.length} из ${base.length}`
    : roomsLabel(base.length);

  if (roomsError) {
    grid.innerHTML = `
      <div class="db-empty" id="dash-empty">
        <span class="db-empty__art">${icon('board')}</span>
        <h2>Не удалось загрузить комнаты</h2>
        <p>${escapeHtml(roomsError)}</p>
        <button type="button" class="btn btn--ghost" data-db-action="refresh">${icon('refresh')}Повторить</button>
      </div>`;
    return;
  }

  if (!base.length) {
    grid.innerHTML = emptyRooms();
    return;
  }

  if (!filtered.length) {
    grid.innerHTML = `
      <div class="db-empty">
        <span class="db-empty__art">${icon('search')}</span>
        <h2>Ничего не найдено</h2>
        <p>Попробуйте изменить запрос или сбросить поиск.</p>
        <button type="button" class="btn btn--ghost" data-db-action="reset-search">Сбросить поиск</button>
      </div>`;
    return;
  }

  grid.innerHTML = `<div class="db-room-grid">${filtered
    .map((room) => roomCard(room))
    .join('')}
  </div>`;
}

function emptyRooms() {
  if (currentUser.role === 'student') {
    return `
      <div class="db-empty" id="dash-empty">
        <span class="db-empty__art">${icon('board')}</span>
        <h2>Пока нет занятий</h2>
        <p>Когда учитель выдаст доступ к комнате, она появится здесь. Можно проверить ещё раз.</p>
        <button type="button" class="btn btn--ghost" data-db-action="refresh">${icon('refresh')}Обновить</button>
      </div>`;
  }
  if (currentUser.role === 'teacher') {
    return `
      <div class="db-empty" id="dash-empty">
        <span class="db-empty__art">${icon('board')}</span>
        <h2>Создайте первую комнату</h2>
        <p>Комната — это отдельная доска для урока. После создания вы сможете выдать доступ ученикам.</p>
        <button type="button" class="btn btn--primary" data-db-action="create">${icon('plus')}Создать комнату</button>
      </div>`;
  }
  return `
    <div class="db-empty" id="dash-empty">
      <span class="db-empty__art">${icon('shield')}</span>
      <h2>Комнат пока нет</h2>
      <p>Учителя ещё не создали ни одной комнаты. Как только появятся — они будут здесь.</p>
    </div>`;
}

function roomCard(room) {
  const tint = ROOM_TINTS[Math.max(0, rooms.indexOf(room)) % ROOM_TINTS.length];
  const student = currentUser.role === 'student';
  const manage = canManageRoom(room);
  const ownerLine =
    currentUser.role === 'teacher' && room.owner.id === currentUser.id
      ? 'Вы — владелец'
      : `Учитель: ${room.owner.name}`;

  const menu = manage
    ? `<div class="db-card-menu-wrap">
        <button
          type="button"
          class="db-icon-btn room-card__menu"
          data-room-action="menu"
          aria-label="Действия с комнатой"
          aria-haspopup="menu"
          aria-expanded="false"
        >${icon('more')}</button>
        <div class="db-card-menu" role="menu" hidden>
          <button type="button" role="menuitem" class="room-card__rename" data-room-action="rename">${icon('pencil')}Переименовать</button>
          <button type="button" role="menuitem" class="is-danger room-card__delete" data-room-action="delete">${icon('trash')}Удалить</button>
        </div>
      </div>`
    : '';

  return `
    <article
      class="room-card"
      data-room-id="${room.id}"
      style="--db-room-accent:${tint.accent};--db-room-soft:${tint.soft}"
    >
      <div class="db-room-card__head">
        <span class="db-room-card__icon">${icon('board')}</span>
        <div class="db-room-card__text">
          <h3 class="room-card__name" title="${escapeHtml(room.name)}">${escapeHtml(room.name)}</h3>
          <p class="db-room-card__sub">${escapeHtml(ownerLine)}</p>
        </div>
        ${menu}
      </div>
      <div class="db-room-card__actions">
        <button type="button" class="btn btn--primary btn--sm room-card__open" data-room-action="open">
          ${student ? 'Войти в комнату' : 'Открыть'}
          ${student ? icon('arrowRight') : ''}
        </button>
        ${
          manage
            ? `<button type="button" class="btn btn--ghost btn--sm room-card__access" data-room-action="access">${icon('users')}Доступ</button>`
            : ''
        }
      </div>
    </article>`;
}

async function loadRooms() {
  roomsLoading = true;
  roomsError = '';
  if (page === 'rooms') renderRoomCards();

  try {
    rooms = isAdmin() ? await roomsApi.all() : await roomsApi.list();
  } catch (error) {
    if (error.status === 401) {
      handlers.onSessionLost();
      return;
    }
    rooms = [];
    roomsError = error.message || 'Не удалось загрузить комнаты';
    showToast(roomsError);
  } finally {
    roomsLoading = false;
    if (page === 'rooms') renderRoomCards();
  }
}

/* ----------------------------------------------------------- room actions */

function openCreateDialog() {
  els.createName.value = '';
  els.createError.hidden = true;
  els.createDialog.showModal();
  setTimeout(() => els.createName.focus(), 30);
}

async function createRoom(event) {
  event.preventDefault();
  const name = els.createName.value.trim();
  if (!name) {
    showFormError(els.createError, 'Введите название комнаты.');
    els.createName.focus();
    return;
  }

  els.createSubmit.disabled = true;
  try {
    await roomsApi.create(name);
    els.createDialog.close();
    await loadRooms();
    showToast(`Комната «${name}» создана`);
  } catch (error) {
    if (error.status === 401) {
      handlers.onSessionLost();
      return;
    }
    showFormError(els.createError, error.message || 'Не удалось создать комнату');
  } finally {
    els.createSubmit.disabled = false;
  }
}

function openRenameDialog(room) {
  renameTarget = room;
  els.renameName.value = room.name;
  els.renameError.hidden = true;
  els.renameDialog.showModal();
  setTimeout(() => {
    els.renameName.focus();
    els.renameName.select();
  }, 30);
}

async function renameRoom(event) {
  event.preventDefault();
  if (!renameTarget) return;
  const name = els.renameName.value.trim();
  if (!name) {
    showFormError(els.renameError, 'Введите название комнаты.');
    els.renameName.focus();
    return;
  }

  const submit = $('#rename-room-submit');
  submit.disabled = true;
  try {
    await roomsApi.rename(renameTarget.id, name);
    els.renameDialog.close();
    await loadRooms();
    showToast('Название комнаты обновлено');
  } catch (error) {
    if (error.status === 401) {
      handlers.onSessionLost();
      return;
    }
    showFormError(els.renameError, error.message || 'Не удалось переименовать комнату');
  } finally {
    submit.disabled = false;
  }
}

function openDeleteDialog(room) {
  deleteTarget = room;
  els.deleteText.textContent = `Комната «${room.name}» и все её объекты будут удалены безвозвратно.`;
  els.deleteError.hidden = true;
  els.deleteDialog.showModal();
}

async function deleteRoom() {
  if (!deleteTarget) return;
  const room = deleteTarget;
  const confirm = $('#delete-room-confirm');
  confirm.disabled = true;
  try {
    await roomsApi.remove(room.id);
    els.deleteDialog.close();
    await loadRooms();
    showToast(`Комната «${room.name}» удалена`);
  } catch (error) {
    if (error.status === 401) {
      handlers.onSessionLost();
      return;
    }
    showFormError(els.deleteError, error.message || 'Не удалось удалить комнату');
  } finally {
    confirm.disabled = false;
  }
}

/* ------------------------------------------------------------- access */

async function openAccessDialog(room) {
  accessRoom = room;
  accessSelected = new Set();
  accessSelectedDetails = new Map();
  accessStudents = [];
  accessSearch = '';
  accessLoading = true;
  clearTimeout(accessSearchTimer);
  accessRequest += 1;
  els.accessTitle.textContent = `Доступ к комнате «${room.name}»`;
  els.accessSearch.value = '';
  els.accessError.hidden = true;
  els.accessDialog.showModal();
  renderAccessList();

  try {
    const current = await roomsApi.access(room.id);
    accessSelected = new Set(current.map((student) => student.id));
    accessSelectedDetails = new Map(current.map((student) => [student.id, student]));
  } catch (error) {
    if (error.status === 401) {
      handlers.onSessionLost();
      return;
    }
    showFormError(els.accessError, error.message || 'Не удалось загрузить доступ');
  }

  await loadAccessStudents(accessSearch.trim());
}

async function loadAccessStudents(query) {
  const request = ++accessRequest;
  accessLoading = true;
  renderAccessList();

  try {
    let students = await usersApi.students(query);
    if (request !== accessRequest) return;
    if (!query) {
      const shown = new Set(students.map((student) => student.id));
      students = [
        ...Array.from(accessSelectedDetails.values()).filter(
          (student) => !shown.has(student.id),
        ),
        ...students,
      ];
    }
    accessStudents = students;
    els.accessError.hidden = true;
  } catch (error) {
    if (request !== accessRequest) return;
    if (error.status === 401) {
      handlers.onSessionLost();
      return;
    }
    accessStudents = [];
    showFormError(els.accessError, error.message || 'Не удалось найти учеников');
  } finally {
    if (request === accessRequest) {
      accessLoading = false;
      renderAccessList();
    }
  }
}

function renderAccessList() {
  if (!els.accessList) return;

  if (accessLoading) {
    els.accessList.innerHTML = '<li class="db-empty-inline">Загружаем учеников…</li>';
    els.accessEmpty.hidden = true;
    updateAccessCount();
    return;
  }

  els.accessList.innerHTML = accessStudents
    .map((student) => {
      const selected = accessSelected.has(student.id);
      return `
        <li class="access-item ${selected ? 'is-selected' : ''}">
          <label>
            <input type="checkbox" data-student-id="${student.id}" ${selected ? 'checked' : ''} />
            <span class="db-access-item__name">${escapeHtml(student.name)}</span>
            <span class="db-access-item__login">@${escapeHtml(student.login)}</span>
          </label>
        </li>`;
    })
    .join('');

  els.accessEmpty.hidden = accessStudents.length > 0;
  updateAccessCount();
}

function updateAccessCount() {
  if (!els.accessCount) return;
  const count = accessSelected.size;
  els.accessCount.textContent = count ? `Выбрано: ${studentsLabel(count)}` : 'Никто не выбран';
}

async function saveAccess() {
  if (!accessRoom) return;
  els.accessSave.disabled = true;
  els.accessError.hidden = true;
  try {
    await roomsApi.setAccess(accessRoom.id, [...accessSelected]);
    els.accessDialog.close();
    showToast(
      accessSelected.size
        ? `Доступ сохранён: ${studentsLabel(accessSelected.size)}`
        : 'Доступ закрыт для всех учеников',
    );
  } catch (error) {
    if (error.status === 401) {
      handlers.onSessionLost();
      return;
    }
    showFormError(els.accessError, error.message || 'Не удалось сохранить доступ');
  } finally {
    els.accessSave.disabled = false;
  }
}

/* ------------------------------------------------------------- admin users */

async function loadAdminData({ silent = false } = {}) {
  adminDataLoading = true;
  if (page === 'users') renderUsersPage();
  else renderTip();

  try {
    const [all, pending] = await Promise.all([
      adminApi.listUsers({}),
      adminApi.listUsers({ status: 'pending' }),
    ]);
    userCounts = {
      all: all.length,
      pending: pending.length,
      active: all.filter((user) => user.status === 'active').length,
      blocked: all.filter((user) => user.status === 'blocked').length,
    };
    pendingTotal = pending.length;
  } catch (error) {
    if (error.status === 401) {
      handlers.onSessionLost();
      return;
    }
    if (!silent) showToast(error.message || 'Не удалось загрузить пользователей');
  } finally {
    adminDataLoading = false;
    renderShell();
    if (page === 'users') renderUsersPage();
  }
}

async function loadUserRows({ silent = false } = {}) {
  if (!isAdmin()) return;
  userRowsLoading = true;
  if (page === 'users') renderUserRows();

  try {
    users = await adminApi.listUsers({
      status: userFilter === 'all' ? '' : userFilter,
      q: userSearch.trim(),
    });
  } catch (error) {
    if (error.status === 401) {
      handlers.onSessionLost();
      return;
    }
    if (!silent) showToast(error.message || 'Не удалось загрузить пользователей');
  } finally {
    userRowsLoading = false;
    if (page === 'users') renderUserRows();
  }
}

function renderUsersPage() {
  if (!isAdmin()) return;
  page = 'users';

  setPageMeta({
    title: 'Пользователи',
    subtitle: 'Заявки, роли, блокировки и сброс пароля.',
    eyebrow: 'Администрирование',
  });

  els.actions.innerHTML = `<button type="button" class="btn btn--ghost" id="admin-refresh" data-db-action="refresh-users">${icon('refresh')}Обновить</button>`;

  const counts = userCounts;

  const countLabel = (count) => (count >= 500 ? '500+' : count);
  const tab = (id, label, count) => `
    <button
      type="button"
      class="db-tab ${userFilter === id ? 'is-active' : ''}"
      data-user-filter="${id}"
      role="tab"
      aria-selected="${userFilter === id}"
    >
      ${label}<span class="db-tab__count">${countLabel(count)}</span>
    </button>`;

  els.body.innerHTML = `
    <section id="dash-admin">
      <div class="db-toolbar-stack">
        <div class="db-toolbar-row">
          <div class="db-tabs" role="tablist" aria-label="Фильтр пользователей">
            ${tab('all', 'Все', counts.all)}
            ${tab('pending', 'Заявки', counts.pending)}
            ${tab('active', 'Активные', counts.active)}
            ${tab('blocked', 'Заблокированные', counts.blocked)}
          </div>
          <label class="db-search">
            ${icon('search')}
            <input
              id="admin-search"
              type="search"
              value="${escapeHtml(userSearch)}"
              placeholder="Имя или логин"
              autocomplete="off"
              aria-label="Поиск пользователей"
            />
          </label>
        </div>
      </div>
      <div class="db-user-table" role="table" aria-label="Пользователи">
        <div class="db-user-row db-user-row--head" role="row">
          <span role="columnheader">Пользователь</span>
          <span role="columnheader">Роль</span>
          <span role="columnheader">Статус</span>
          <span role="columnheader">Действия</span>
        </div>
        <div id="admin-users-rows"></div>
      </div>
    </section>`;

  renderUserRows();
}

function renderUserRows() {
  const container = $('#admin-users-rows');
  if (!container) return;

  if (userRowsLoading && !users.length) {
    container.innerHTML = '<p class="db-loading">Загружаем пользователей…</p>';
    return;
  }

  if (!users.length) {
    container.innerHTML = '<p class="db-empty-inline">Пользователей не найдено</p>';
    return;
  }

  container.innerHTML = users.map(userRow).join('');
}

function userRow(user) {
  const avatarClass =
    user.role === 'teacher' ? 'db-avatar--teacher' : user.role === 'admin' ? 'db-avatar--admin' : '';

  const roleCell =
    user.role === 'admin'
      ? '<span class="db-role-static">Администратор</span>'
      : `<select class="db-select" data-user-role="${user.id}" aria-label="Роль пользователя ${escapeHtml(user.name)}">
          <option value="student" ${user.role === 'student' ? 'selected' : ''}>Ученик</option>
          <option value="teacher" ${user.role === 'teacher' ? 'selected' : ''}>Учитель</option>
        </select>`;

  const actions = [];
  if (user.status === 'pending') {
    actions.push(
      `<button type="button" class="btn btn--primary btn--sm" data-user-action="approve" data-user-id="${user.id}">Подтвердить</button>`,
      `<button type="button" class="btn btn--ghost btn--sm" data-user-action="reject" data-user-id="${user.id}">Отклонить</button>`,
    );
  }
  if (user.role !== 'admin' && user.status === 'active') {
    actions.push(
      `<button type="button" class="btn btn--ghost btn--sm" data-user-action="block" data-user-id="${user.id}">Заблокировать</button>`,
    );
  }
  if (user.role !== 'admin' && user.status === 'blocked') {
    actions.push(
      `<button type="button" class="btn btn--ghost btn--sm" data-user-action="unblock" data-user-id="${user.id}">Разблокировать</button>`,
    );
  }
  actions.push(
    `<button type="button" class="btn btn--ghost btn--sm" data-user-action="password" data-user-id="${user.id}">Пароль</button>`,
  );

  return `
    <div class="db-user-row ${user.status === 'pending' ? 'is-pending' : ''}" data-user-row="${user.id}" role="row">
      <div class="db-user-cell" role="cell">
        <span class="db-avatar db-avatar--sm ${avatarClass}">${escapeHtml(initial(user.name))}</span>
        <span class="db-user-cell__text">
          <span class="db-user-cell__name">${escapeHtml(user.name)}</span>
          <span class="db-user-cell__login">@${escapeHtml(user.login)}</span>
        </span>
      </div>
      <div role="cell">${roleCell}</div>
      <div role="cell">
        <span class="db-status db-status--${user.status} db-user-row__status">${STATUS_LABELS[user.status] || user.status}</span>
      </div>
      <div class="db-row-actions" role="cell">${actions.join('')}</div>
    </div>`;
}

async function updateUserStatus(user, status) {
  try {
    const updated = await adminApi.updateUser(user.id, { status });
    Object.assign(user, updated);
    await Promise.all([loadUserRows({ silent: true }), loadAdminData({ silent: true })]);
    showToast(`${user.name}: ${STATUS_LABELS[status] || status}`);
  } catch (error) {
    if (error.status === 401) {
      handlers.onSessionLost();
      return;
    }
    showToast(error.message || 'Не удалось обновить пользователя');
    renderUsersPage();
  }
}

async function updateUserRole(user, role) {
  try {
    const updated = await adminApi.updateUser(user.id, { role });
    Object.assign(user, updated);
    await Promise.all([loadUserRows({ silent: true }), loadAdminData({ silent: true })]);
    showToast(`Роль изменена: ${ROLE_LABELS[role] || role}`);
  } catch (error) {
    if (error.status === 401) {
      handlers.onSessionLost();
      return;
    }
    showToast(error.message || 'Не удалось изменить роль');
    renderUsersPage();
  }
}

function openPasswordDialog(user) {
  passwordTarget = user;
  els.passwordText.textContent = `Новый пароль для ${user.name} (@${user.login}). Не короче 8 символов.`;
  els.passwordValue.value = '';
  els.passwordError.hidden = true;
  els.passwordDialog.showModal();
  setTimeout(() => els.passwordValue.focus(), 30);
}

async function savePassword(event) {
  event.preventDefault();
  if (!passwordTarget) return;
  const value = els.passwordValue.value;
  if (value.length < 8) {
    showFormError(els.passwordError, 'Пароль должен быть не короче 8 символов.');
    els.passwordValue.focus();
    return;
  }

  const submit = $('#password-submit');
  submit.disabled = true;
  try {
    await adminApi.resetPassword(passwordTarget.id, value);
    els.passwordDialog.close();
    showToast(`Пароль для ${passwordTarget.name} обновлён`);
  } catch (error) {
    if (error.status === 401) {
      handlers.onSessionLost();
      return;
    }
    showFormError(els.passwordError, error.message || 'Не удалось обновить пароль');
  } finally {
    submit.disabled = false;
  }
}

/* ----------------------------------------------------------------- events */

function handleRootClick(event) {
  const nav = event.target.closest('[data-nav]');
  if (nav) {
    page = nav.dataset.nav;
    renderShell();
    renderPage();
    if (page === 'users') {
      if (!userCounts.all && !adminDataLoading) loadAdminData({ silent: true });
      loadUserRows();
    }
    return;
  }

  const close = event.target.closest('[data-close-dialog]');
  if (close) {
    closeDialog(close.dataset.closeDialog);
    return;
  }

  const action = event.target.closest('[data-db-action]');
  if (action) {
    handleDbAction(action.dataset.dbAction);
    return;
  }

  const filter = event.target.closest('[data-user-filter]');
  if (filter) {
    userFilter = filter.dataset.userFilter;
    renderUsersPage();
    loadUserRows();
    return;
  }

  const userAction = event.target.closest('[data-user-action]');
  if (userAction) {
    handleUserAction(userAction.dataset.userAction, userAction.dataset.userId);
    return;
  }

  const roomAction = event.target.closest('[data-room-action]');
  if (roomAction) {
    handleRoomAction(roomAction);
  }
}

function handleDbAction(action) {
  if (action === 'create') openCreateDialog();
  else if (action === 'refresh') loadRooms();
  else if (action === 'reset-search') {
    roomSearch = '';
    const input = $('#room-search');
    if (input) input.value = '';
    renderRoomCards();
    input?.focus();
  } else if (action === 'refresh-users') {
    loadAdminData({ silent: true });
    loadUserRows();
    showToast('Список пользователей обновлён');
  } else if (action === 'open-pending') {
    page = 'users';
    userFilter = 'pending';
    userSearch = '';
    renderShell();
    renderPage();
    if (!userCounts.all && !adminDataLoading) loadAdminData({ silent: true });
    loadUserRows();
  }
}

function handleRoomAction(button) {
  const card = button.closest('[data-room-id]');
  const room = rooms.find((item) => item.id === card?.dataset.roomId);
  if (!room) return;

  const action = button.dataset.roomAction;
  if (action !== 'menu') closeCardMenus();

  if (action === 'open') {
    handlers.onOpenRoom(room.id);
  } else if (action === 'menu') {
    toggleCardMenu(button);
  } else if (action === 'access') {
    openAccessDialog(room);
  } else if (action === 'rename') {
    openRenameDialog(room);
  } else if (action === 'delete') {
    openDeleteDialog(room);
  }
}

function toggleCardMenu(button) {
  const wrap = button.closest('.db-card-menu-wrap');
  const menu = $('.db-card-menu', wrap);
  const willOpen = menu.hidden;
  closeCardMenus();
  if (willOpen) {
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
  }
}

function closeCardMenus() {
  $$('.db-card-menu').forEach((menu) => {
    menu.hidden = true;
  });
  $$('[data-room-action="menu"]').forEach((button) => {
    button.setAttribute('aria-expanded', 'false');
  });
}

function handleRootChange(event) {
  const roleSelect = event.target.closest('[data-user-role]');
  if (roleSelect) {
    const user = users.find((item) => item.id === roleSelect.dataset.userRole);
    if (user) updateUserRole(user, roleSelect.value);
    return;
  }

  const checkbox = event.target.closest('#access-list input[data-student-id]');
  if (checkbox) {
    const studentId = checkbox.dataset.studentId;
    if (checkbox.checked) {
      accessSelected.add(studentId);
      const student = accessStudents.find((item) => item.id === studentId);
      if (student) accessSelectedDetails.set(studentId, student);
    } else {
      accessSelected.delete(studentId);
      accessSelectedDetails.delete(studentId);
    }
    checkbox.closest('.access-item')?.classList.toggle('is-selected', checkbox.checked);
    updateAccessCount();
  }
}

function handleRootInput(event) {
  if (event.target.id === 'room-search') {
    roomSearch = event.target.value;
    renderRoomCards();
  } else if (event.target.id === 'admin-search') {
    userSearch = event.target.value;
    clearTimeout(userSearchTimer);
    userSearchTimer = setTimeout(() => loadUserRows(), 250);
  } else if (event.target.id === 'access-search') {
    accessSearch = event.target.value;
    clearTimeout(accessSearchTimer);
    accessSearchTimer = setTimeout(() => loadAccessStudents(accessSearch.trim()), 250);
  } else if (event.target.id === 'create-room-name') {
    els.createError.hidden = true;
  } else if (event.target.id === 'rename-room-name') {
    els.renameError.hidden = true;
  } else if (event.target.id === 'password-value') {
    els.passwordError.hidden = true;
  }
}

function handleUserAction(action, userId) {
  const user = users.find((item) => item.id === userId);
  if (!user) return;

  if (action === 'approve') updateUserStatus(user, 'active');
  else if (action === 'reject') updateUserStatus(user, 'rejected');
  else if (action === 'block') updateUserStatus(user, 'blocked');
  else if (action === 'unblock') updateUserStatus(user, 'active');
  else if (action === 'password') openPasswordDialog(user);
}

/* ------------------------------------------------------------------ utils */

function showFormError(element, message) {
  element.textContent = message;
  element.hidden = false;
}

function closeDialog(id) {
  const dialog = document.getElementById(id);
  if (dialog?.open) dialog.close();
}

function closeAllDialogs() {
  $$('#dashboard dialog').forEach((dialog) => {
    if (dialog.open) dialog.close();
  });
}

function showToast(message) {
  if (!els.toast) return;
  els.toast.textContent = message;
  els.toast.hidden = false;
  requestAnimationFrame(() => els.toast.classList.add('is-visible'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.classList.remove('is-visible');
    setTimeout(() => {
      if (!els.toast.classList.contains('is-visible')) els.toast.hidden = true;
    }, 200);
  }, 2800);
}
