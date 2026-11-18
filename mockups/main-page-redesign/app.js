'use strict';

/* ------------------------------------------------------------------ utils */

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (char) => {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return map[char];
  });

const ICON_PATHS = {
  board:
    '<rect x="3" y="4" width="18" height="13" rx="2.5" /><path d="M7.5 9.5c1.6-1.8 3.2 1.8 4.9 0 1.4-1.5 2.6.4 3.6.8" /><path d="M9 21l3-4 3 4" />',
  users:
    '<path d="M16 19v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1" /><circle cx="9.5" cy="7" r="3.5" /><path d="M17 11a3 3 0 1 0 0-6" /><path d="M21 19v-1a3.5 3.5 0 0 0-2.5-3.35" />',
  shield:
    '<path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z" /><path d="M9.5 12l1.7 1.7L15 10" />',
  plus: '<path d="M12 5v14M5 12h14" />',
  search: '<circle cx="11" cy="11" r="7" /><path d="M20 20l-3.2-3.2" />',
  refresh:
    '<path d="M20 11a8 8 0 1 0-1.4 4.6" /><path d="M20 4.5v6h-6" />',
  logout:
    '<path d="M9 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h3" /><path d="M15 8l4 4-4 4" /><path d="M19 12H9" />',
  more:
    '<circle cx="5" cy="12" r="1.5" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1.5" fill="currentColor" stroke="none" />',
  arrowRight: '<path d="M5 12h14" /><path d="M14 7l5 5-5 5" />',
  pencil:
    '<path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17z" /><path d="M13.5 7.5l3 3" />',
  trash:
    '<path d="M4 7h16" /><path d="M9 7V5h6v2" /><path d="M6 7l1 13h10l1-13" /><path d="M10 11v5M14 11v5" />',
  spark:
    '<path d="M12 3l1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8z" /><path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z" />',
};

const icon = (name, className = '') =>
  `<svg class="icon ${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name]}</svg>`;

const plural = (count, one, few, many) => {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return `${count} ${one}`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${count} ${few}`;
  return `${count} ${many}`;
};

const roomsLabel = (count) => plural(count, 'комната', 'комнаты', 'комнат');
const studentsLabel = (count) => plural(count, 'ученик', 'ученика', 'учеников');

/* ------------------------------------------------------------------- data */

const STUDENT_ID = 'u1';
const TEACHER_ID = 'u2';
const ADMIN_ID = 'u0';

const ROLE_LABELS = {
  student: 'Ученик',
  teacher: 'Учитель',
  admin: 'Администратор',
};

const STATUS_LABELS = {
  active: 'Активен',
  pending: 'Заявка',
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

const initialUsers = [
  { id: 'u0', name: 'Администратор', login: 'admin', role: 'admin', status: 'active' },
  { id: 'u1', name: 'Вячеслав', login: 'vashaferov', role: 'student', status: 'active' },
  { id: 'u2', name: 'Софья', login: 'sashaferova', role: 'teacher', status: 'active' },
  { id: 'u3', name: 'Ирина', login: 'irina', role: 'teacher', status: 'active' },
  { id: 'u4', name: 'Мария', login: 'maria', role: 'student', status: 'pending' },
  { id: 'u5', name: 'Егор', login: 'egor', role: 'student', status: 'pending' },
  { id: 'u6', name: 'Анна', login: 'anna', role: 'student', status: 'active' },
  { id: 'u7', name: 'Дмитрий', login: 'dmitry', role: 'student', status: 'blocked' },
  { id: 'u8', name: 'Полина', login: 'polina', role: 'student', status: 'active' },
];

const initialRooms = [
  {
    id: 'r1',
    name: 'Алгебра, 8 класс',
    owner: { id: 'u2', name: 'Софья' },
    access: ['u1', 'u6'],
  },
  {
    id: 'r2',
    name: 'Геометрия, 8 класс',
    owner: { id: 'u2', name: 'Софья' },
    access: ['u1'],
  },
  {
    id: 'r3',
    name: 'Подготовка к ОГЭ',
    owner: { id: 'u2', name: 'Софья' },
    access: ['u6', 'u8'],
  },
  {
    id: 'r4',
    name: 'Олимпиадные задачи',
    owner: { id: 'u3', name: 'Ирина' },
    access: ['u8'],
  },
  {
    id: 'r5',
    name: 'Физика: разбор задач',
    owner: { id: 'u3', name: 'Ирина' },
    access: ['u1', 'u6'],
  },
  {
    id: 'r6',
    name: 'Русский язык, 7 класс',
    owner: { id: 'u3', name: 'Ирина' },
    access: ['u6'],
  },
];

const state = {
  role: 'teacher',
  page: 'rooms',
  search: '',
  usersFilter: 'all',
  usersSearch: '',
  accessSearch: '',
  rooms: initialRooms.map((room) => ({
    ...room,
    owner: { ...room.owner },
    access: [...room.access],
  })),
  users: initialUsers.map((user) => ({ ...user })),
  activeRoomId: null,
  accessSelected: new Set(),
  renameRoomId: null,
  deleteRoomId: null,
  passwordUserId: null,
};

/* ------------------------------------------------------------------- role */

const ROLES = {
  student: {
    label: ROLE_LABELS.student,
    nav: [{ id: 'rooms', label: 'Мои занятия', icon: 'board' }],
    title: 'Мои занятия',
    subtitle: 'Комнаты, которые открыл для вас учитель.',
    eyebrow: 'Кабинет ученика',
  },
  teacher: {
    label: ROLE_LABELS.teacher,
    nav: [{ id: 'rooms', label: 'Мои комнаты', icon: 'board' }],
    title: 'Мои комнаты',
    subtitle: 'Создавайте комнаты и выдавайте доступ ученикам.',
    eyebrow: 'Кабинет учителя',
  },
  admin: {
    label: ROLE_LABELS.admin,
    nav: [
      { id: 'rooms', label: 'Все комнаты', icon: 'shield' },
      { id: 'users', label: 'Пользователи', icon: 'users' },
    ],
    title: 'Все комнаты',
    subtitle: 'Комнаты всех учителей. Откройте любую или создайте новую.',
    eyebrow: 'Администрирование',
  },
};

function currentUser() {
  if (state.role === 'student') return state.users.find((user) => user.id === STUDENT_ID);
  if (state.role === 'teacher') return state.users.find((user) => user.id === TEACHER_ID);
  return state.users.find((user) => user.id === ADMIN_ID);
}

function pendingCount() {
  return state.users.filter((user) => user.status === 'pending').length;
}

function initial(name) {
  return (name || '?').trim().charAt(0).toUpperCase();
}

/* -------------------------------------------------------------- rendering */

const els = {
  nav: $('#nav'),
  tip: $('#sidebar-tip'),
  user: $('#sidebar-user'),
  eyebrow: $('#page-eyebrow'),
  title: $('#page-title'),
  subtitle: $('#page-subtitle'),
  actions: $('#page-actions'),
  body: $('#page-body'),
};

function render() {
  document.body.dataset.role = state.role;
  document.body.dataset.page = state.page;

  $$('[data-demo-role]').forEach((button) => {
    const isActive = button.dataset.demoRole === state.role;
    button.classList.toggle('is-active', isActive);
    button.setAttribute('aria-pressed', String(isActive));
  });

  renderNav();
  renderSidebarTip();
  renderSidebarUser();
  renderPage();
}

function navItems() {
  const items = ROLES[state.role].nav;
  if (state.role !== 'admin') return items;
  return items.map((item) =>
    item.id === 'users' ? { ...item, badge: pendingCount() } : item,
  );
}

function renderNav() {
  els.nav.innerHTML = navItems()
    .map(
      (item) => `
        <button
          type="button"
          class="nav__item ${state.page === item.id ? 'is-active' : ''}"
          data-nav="${item.id}"
          ${state.page === item.id ? 'aria-current="page"' : ''}
        >
          ${icon(item.icon)}
          <span>${escapeHtml(item.label)}</span>
          ${item.badge ? `<span class="nav__badge">${item.badge}</span>` : ''}
        </button>`,
    )
    .join('');

  $$('[data-nav]', els.nav).forEach((button) => {
    button.addEventListener('click', () => {
      state.page = button.dataset.nav;
      state.search = '';
      state.usersSearch = '';
      state.usersFilter = 'all';
      render();
      window.scrollTo({ top: 0, behavior: 'auto' });
    });
  });
}

function renderSidebarTip() {
  if (state.role === 'admin') {
    const pending = pendingCount();
    els.tip.innerHTML = `
      <div class="tip-card">
        <div class="tip-card__head">${icon('shield')} ${pending ? 'Нужно внимание' : 'Всё в порядке'}</div>
        <p>${
          pending
            ? `${plural(pending, 'заявка ждёт', 'заявки ждут', 'заявок ждут')} подтверждения.`
            : 'Новых заявок на регистрацию нет.'
        }</p>
        ${
          pending
            ? '<button type="button" class="link" data-action="open-pending">Открыть заявки</button>'
            : ''
        }
      </div>`;
    return;
  }

  const teacherTip = state.role === 'teacher';
  els.tip.innerHTML = `
    <div class="tip-card">
      <div class="tip-card__head">${icon('spark')} ${teacherTip ? 'Совет' : 'Как это работает'}</div>
      <p>${
        teacherTip
          ? 'Выдайте доступ к комнате — и ученик увидит её на своей главной.'
          : 'Когда учитель выдаст доступ к комнате, она появится в этом списке.'
      }</p>
    </div>`;
}

function renderSidebarUser() {
  const user = currentUser();
  const avatarClass =
    state.role === 'teacher' ? 'avatar--teacher' : state.role === 'admin' ? 'avatar--admin' : '';
  els.user.innerHTML = `
    <span class="avatar ${avatarClass}">${escapeHtml(initial(user.name))}</span>
    <span class="sidebar-user__text">
      <strong>${escapeHtml(user.name)}</strong>
      <small>${escapeHtml(ROLES[state.role].label)}</small>
    </span>
    <button type="button" class="icon-btn" data-action="logout" aria-label="Выйти" title="Выйти">
      ${icon('logout')}
    </button>`;
}

function setPageMeta({ title, subtitle, eyebrow }) {
  els.eyebrow.textContent = eyebrow;
  els.title.textContent = title;
  els.subtitle.textContent = subtitle;
}

function renderPage() {
  if (state.role === 'admin' && state.page === 'users') {
    renderUsersPage();
    return;
  }
  renderRoomsPage();
}

/* ------------------------------------------------------------------ rooms */

function roomsForRole() {
  if (state.role === 'student') {
    return state.rooms.filter((room) => room.access.includes(STUDENT_ID));
  }
  if (state.role === 'teacher') {
    return state.rooms.filter((room) => room.owner.id === TEACHER_ID);
  }
  return state.rooms;
}

function canManageRoom(room) {
  if (state.role === 'admin') return true;
  return state.role === 'teacher' && room.owner.id === TEACHER_ID;
}

function renderRoomsPage() {
  const config = ROLES[state.role];
  setPageMeta({
    title: config.title,
    subtitle: config.subtitle,
    eyebrow: config.eyebrow,
  });

  const isStudent = state.role === 'student';
  els.actions.innerHTML = isStudent
    ? `<button type="button" class="btn btn--ghost" data-action="refresh">${icon('refresh')}Обновить</button>`
    : `<button type="button" class="btn btn--primary" data-action="create">${icon('plus')}Создать комнату</button>`;

  els.body.innerHTML = `
    <div class="list-toolbar">
      <span class="list-count" id="rooms-count"></span>
      <label class="search">
        ${icon('search')}
        <input
          id="rooms-search"
          type="search"
          value="${escapeHtml(state.search)}"
          placeholder="Найти комнату"
          autocomplete="off"
          aria-label="Поиск комнат"
        />
      </label>
    </div>
    <div id="room-grid"></div>`;

  const searchInput = $('#rooms-search');
  searchInput.addEventListener('input', () => {
    state.search = searchInput.value;
    renderRoomGrid();
  });

  renderRoomGrid();
}

function renderRoomGrid() {
  const grid = $('#room-grid');
  const countEl = $('#rooms-count');
  if (!grid || !countEl) return;

  const base = roomsForRole();
  const query = state.search.trim().toLowerCase();
  const rooms = query
    ? base.filter(
        (room) =>
          room.name.toLowerCase().includes(query) ||
          room.owner.name.toLowerCase().includes(query),
      )
    : base;

  countEl.textContent = query
    ? `Найдено: ${rooms.length} из ${base.length}`
    : roomsLabel(base.length);

  if (!base.length) {
    grid.innerHTML = emptyRoomsState();
    return;
  }

  if (!rooms.length) {
    grid.innerHTML = `
      <div class="empty-state">
        <span class="empty-state__art">${icon('search')}</span>
        <h2>Ничего не найдено</h2>
        <p>Попробуйте изменить запрос или сбросить поиск.</p>
        <button type="button" class="btn btn--ghost" data-action="reset-search">Сбросить поиск</button>
      </div>`;
    return;
  }

  grid.innerHTML = `<div class="room-grid">${rooms
    .map((room) => roomCard(room, state.rooms.indexOf(room)))
    .join('')}</div>`;

  const cards = $('.room-grid', grid);
  cards.addEventListener('click', (event) => {
    const button = event.target.closest('[data-card-action]');
    if (!button) return;
    const card = button.closest('[data-room-id]');
    const room = state.rooms.find((item) => item.id === card.dataset.roomId);
    if (!room) return;

    const action = button.dataset.cardAction;
    if (action !== 'menu') closeCardMenus();
    if (action === 'open') {
      showToast(`Открываем комнату «${room.name}»…`);
    } else if (action === 'menu') {
      toggleCardMenu(button);
    } else if (action === 'access') {
      openAccessDialog(room);
    } else if (action === 'rename') {
      closeCardMenus();
      openRenameDialog(room);
    } else if (action === 'delete') {
      closeCardMenus();
      openDeleteDialog(room);
    }
  });
}

function emptyRoomsState() {
  if (state.role === 'student') {
    return `
      <div class="empty-state">
        <span class="empty-state__art">${icon('board')}</span>
        <h2>Пока нет занятий</h2>
        <p>Когда учитель выдаст доступ к комнате, она появится здесь. Можно проверить ещё раз.</p>
        <button type="button" class="btn btn--ghost" data-action="refresh">${icon('refresh')}Обновить</button>
      </div>`;
  }
  if (state.role === 'teacher') {
    return `
      <div class="empty-state">
        <span class="empty-state__art">${icon('board')}</span>
        <h2>Создайте первую комнату</h2>
        <p>Комната — это отдельная доска для урока. После создания вы сможете выдать доступ ученикам.</p>
        <button type="button" class="btn btn--primary" data-action="create">${icon('plus')}Создать комнату</button>
      </div>`;
  }
  return `
    <div class="empty-state">
      <span class="empty-state__art">${icon('shield')}</span>
      <h2>Комнат пока нет</h2>
      <p>Учителя ещё не создали ни одной комнаты. Как только появятся — они будут здесь.</p>
    </div>`;
}

function roomCard(room, index) {
  const tint = ROOM_TINTS[index % ROOM_TINTS.length];
  const isStudent = state.role === 'student';
  const canManage = canManageRoom(room);
  const ownerLine =
    state.role === 'teacher' && room.owner.id === TEACHER_ID
      ? 'Вы — владелец'
      : `Учитель: ${room.owner.name}`;

  const menu = canManage
    ? `<div class="card-menu-wrap">
        <button
          type="button"
          class="icon-btn"
          data-card-action="menu"
          aria-label="Действия с комнатой"
          aria-haspopup="menu"
          aria-expanded="false"
        >${icon('more')}</button>
        <div class="card-menu" role="menu" hidden>
          <button type="button" role="menuitem" data-card-action="rename">${icon('pencil')}Переименовать</button>
          <button type="button" role="menuitem" class="is-danger" data-card-action="delete">${icon('trash')}Удалить</button>
        </div>
      </div>`
    : '';

  return `
    <article
      class="room-card"
      data-room-id="${room.id}"
      style="--room-accent:${tint.accent};--room-soft:${tint.soft}"
    >
      <div class="room-card__head">
        <span class="room-card__icon">${icon('board')}</span>
        <div class="room-card__text">
          <h3 class="room-card__title" title="${escapeHtml(room.name)}">${escapeHtml(room.name)}</h3>
          <p class="room-card__sub">${escapeHtml(ownerLine)}</p>
        </div>
        ${menu}
      </div>
      <div class="room-card__actions">
        <button type="button" class="btn btn--primary btn--sm" data-card-action="open">
          <span>${isStudent ? 'Войти в комнату' : 'Открыть'}</span>
          ${isStudent ? icon('arrowRight') : ''}
        </button>
        ${
          canManage
            ? `<button type="button" class="btn btn--ghost btn--sm" data-card-action="access">${icon('users')}Доступ</button>`
            : ''
        }
      </div>
    </article>`;
}

function toggleCardMenu(button) {
  const wrap = button.closest('.card-menu-wrap');
  const menu = $('.card-menu', wrap);
  const willOpen = menu.hidden;
  closeCardMenus();
  if (willOpen) {
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
  }
}

function closeCardMenus() {
  $$('.card-menu').forEach((menu) => {
    menu.hidden = true;
  });
  $$('[data-card-action="menu"]').forEach((button) => {
    button.setAttribute('aria-expanded', 'false');
  });
}

/* ------------------------------------------------------------------ users */

function renderUsersPage() {
  setPageMeta({
    title: 'Пользователи',
    subtitle: 'Заявки, роли, блокировки и сброс пароля.',
    eyebrow: 'Администрирование',
  });

  els.actions.innerHTML = `<button type="button" class="btn btn--ghost" data-action="refresh-users">${icon('refresh')}Обновить</button>`;

  const counts = {
    all: state.users.length,
    pending: state.users.filter((user) => user.status === 'pending').length,
    active: state.users.filter((user) => user.status === 'active').length,
    blocked: state.users.filter((user) => user.status === 'blocked').length,
  };

  const tab = (id, label, count) => `
    <button
      type="button"
      class="tab ${state.usersFilter === id ? 'is-active' : ''}"
      data-filter="${id}"
      role="tab"
      aria-selected="${state.usersFilter === id}"
    >
      ${label}<span class="tab__count">${count}</span>
    </button>`;

  els.body.innerHTML = `
    <div class="toolbar-stack">
      <div class="toolbar-row">
        <div class="tabs" role="tablist" aria-label="Фильтр пользователей">
          ${tab('all', 'Все', counts.all)}
          ${tab('pending', 'Заявки', counts.pending)}
          ${tab('active', 'Активные', counts.active)}
          ${tab('blocked', 'Заблокированные', counts.blocked)}
        </div>
        <label class="search">
          ${icon('search')}
          <input
            id="users-search"
            type="search"
            value="${escapeHtml(state.usersSearch)}"
            placeholder="Имя или логин"
            autocomplete="off"
            aria-label="Поиск пользователей"
          />
        </label>
      </div>
    </div>
    <div class="user-table" role="table" aria-label="Пользователи">
      <div class="user-row user-row--head" role="row">
        <span role="columnheader">Пользователь</span>
        <span role="columnheader">Роль</span>
        <span role="columnheader">Статус</span>
        <span role="columnheader">Действия</span>
      </div>
      <div id="user-rows"></div>
    </div>`;

  const search = $('#users-search');
  search.addEventListener('input', () => {
    state.usersSearch = search.value;
    renderUserRows();
  });

  renderUserRows();
}

function renderUserRows() {
  const container = $('#user-rows');
  if (!container) return;

  const query = state.usersSearch.trim().toLowerCase();
  const users = state.users.filter((user) => {
    const statusMatch = state.usersFilter === 'all' || user.status === state.usersFilter;
    const queryMatch =
      !query ||
      user.name.toLowerCase().includes(query) ||
      user.login.toLowerCase().includes(query);
    return statusMatch && queryMatch;
  });

  if (!users.length) {
    container.innerHTML = '<p class="empty-inline">Пользователей не найдено</p>';
    return;
  }

  container.innerHTML = users.map((user) => userRow(user)).join('');
}

function userRow(user) {
  const avatarClass =
    user.role === 'teacher' ? 'avatar--teacher' : user.role === 'admin' ? 'avatar--admin' : '';

  const roleCell =
    user.role === 'admin'
      ? '<span class="role-static">Администратор</span>'
      : `<select class="select" data-user-role="${user.id}" aria-label="Роль пользователя ${escapeHtml(user.name)}">
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
  if (user.role !== 'admin') {
    actions.push(
      `<button type="button" class="btn btn--ghost btn--sm" data-user-action="password" data-user-id="${user.id}">Пароль</button>`,
    );
  }

  return `
    <div class="user-row ${user.status === 'pending' ? 'is-pending' : ''}" role="row">
      <div class="user-cell" role="cell">
        <span class="avatar avatar--sm ${avatarClass}">${escapeHtml(initial(user.name))}</span>
        <span class="user-cell__text">
          <span class="user-cell__name">${escapeHtml(user.name)}</span>
          <span class="user-cell__login">@${escapeHtml(user.login)}</span>
        </span>
      </div>
      <div role="cell">${roleCell}</div>
      <div role="cell"><span class="status status--${user.status}">${STATUS_LABELS[user.status]}</span></div>
      <div class="row-actions" role="cell">${actions.join('')}</div>
    </div>`;
}

/* ---------------------------------------------------------------- dialogs */

function openDialog(id) {
  const dialog = document.getElementById(id);
  if (dialog && !dialog.open) dialog.showModal();
}

function closeDialog(id) {
  const dialog = document.getElementById(id);
  if (dialog && dialog.open) dialog.close();
}

function openCreateDialog() {
  $('#create-name').value = '';
  $('#create-error').hidden = true;
  openDialog('create-dialog');
  setTimeout(() => $('#create-name').focus(), 30);
}

function openAccessDialog(room) {
  state.activeRoomId = room.id;
  state.accessSelected = new Set(room.access);
  state.accessSearch = '';
  $('#access-title').textContent = `Доступ к комнате «${room.name}»`;
  $('#access-search').value = '';
  openDialog('access-dialog');
  renderAccessList();
}

function renderAccessList() {
  const list = $('#access-list');
  const empty = $('#access-empty');
  const query = state.accessSearch.trim().toLowerCase();
  const students = state.users.filter(
    (user) => user.role === 'student' && user.status === 'active',
  );
  const filtered = query
    ? students.filter(
        (user) =>
          user.name.toLowerCase().includes(query) ||
          user.login.toLowerCase().includes(query),
      )
    : students;

  list.innerHTML = filtered
    .map((student) => {
      const selected = state.accessSelected.has(student.id);
      return `
        <li class="access-item ${selected ? 'is-selected' : ''}">
          <label>
            <input
              type="checkbox"
              data-student="${student.id}"
              ${selected ? 'checked' : ''}
            />
            <span class="access-item__name">${escapeHtml(student.name)}</span>
            <span class="access-item__login">@${escapeHtml(student.login)}</span>
          </label>
        </li>`;
    })
    .join('');

  empty.hidden = filtered.length > 0;
  updateAccessCount();
}

function updateAccessCount() {
  const count = state.accessSelected.size;
  $('#access-count').textContent = count
    ? `Выбрано: ${studentsLabel(count)}`
    : 'Никто не выбран';
}

function openRenameDialog(room) {
  state.renameRoomId = room.id;
  $('#rename-name').value = room.name;
  $('#rename-error').hidden = true;
  openDialog('rename-dialog');
  setTimeout(() => {
    const input = $('#rename-name');
    input.focus();
    input.select();
  }, 30);
}

function openDeleteDialog(room) {
  state.deleteRoomId = room.id;
  $('#delete-text').textContent = `Комната «${room.name}» и все её объекты будут удалены безвозвратно.`;
  openDialog('delete-dialog');
}

function openPasswordDialog(user) {
  state.passwordUserId = user.id;
  $('#password-text').textContent = `Новый пароль для ${user.name} (@${user.login}). Не короче 8 символов.`;
  $('#password-value').value = '';
  $('#password-error').hidden = true;
  openDialog('password-dialog');
  setTimeout(() => $('#password-value').focus(), 30);
}

/* ------------------------------------------------------------------ toast */

let toastTimer = null;

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 2800);
}

/* --------------------------------------------------------------- handlers */

function bindGlobalHandlers() {
  document.addEventListener('click', (event) => {
    if (!event.target.closest('.card-menu-wrap')) closeCardMenus();

    const closeButton = event.target.closest('[data-close]');
    if (closeButton) {
      closeDialog(closeButton.dataset.close);
      return;
    }

    const demoButton = event.target.closest('[data-demo-role]');
    if (demoButton) {
      state.role = demoButton.dataset.demoRole;
      state.page = 'rooms';
      state.search = '';
      state.usersSearch = '';
      state.usersFilter = 'all';
      render();
      window.scrollTo({ top: 0, behavior: 'auto' });
      return;
    }

    const actionButton = event.target.closest('[data-action]');
    if (actionButton) {
      handleAction(actionButton.dataset.action);
      return;
    }

    const filterButton = event.target.closest('[data-filter]');
    if (filterButton) {
      state.usersFilter = filterButton.dataset.filter;
      renderUsersPage();
      return;
    }

    const userButton = event.target.closest('[data-user-action]');
    if (userButton) {
      handleUserAction(userButton.dataset.userAction, userButton.dataset.userId);
    }
  });

  document.addEventListener('change', (event) => {
    const roleSelect = event.target.closest('[data-user-role]');
    if (!roleSelect) return;
    const user = state.users.find((item) => item.id === roleSelect.dataset.userRole);
    if (!user) return;
    user.role = roleSelect.value;
    showToast(`Роль изменена: ${ROLE_LABELS[user.role]}`);
    renderNav();
    renderUsersPage();
  });

  ['create-name', 'rename-name', 'password-value'].forEach((id) => {
    document.getElementById(id).addEventListener('input', () => {
      const error = document.getElementById(`${id.split('-')[0]}-error`);
      if (error) error.hidden = true;
    });
  });

  $('#access-search').addEventListener('input', (event) => {
    state.accessSearch = event.target.value;
    renderAccessList();
  });

  $('#access-list').addEventListener('change', (event) => {
    const checkbox = event.target.closest('input[data-student]');
    if (!checkbox) return;
    if (checkbox.checked) state.accessSelected.add(checkbox.dataset.student);
    else state.accessSelected.delete(checkbox.dataset.student);
    checkbox.closest('.access-item').classList.toggle('is-selected', checkbox.checked);
    updateAccessCount();
  });

  $('#access-clear').addEventListener('click', () => {
    state.accessSelected.clear();
    renderAccessList();
  });

  $('#access-save').addEventListener('click', () => {
    const room = state.rooms.find((item) => item.id === state.activeRoomId);
    if (!room) return;
    room.access = [...state.accessSelected];
    closeDialog('access-dialog');
    renderRoomGrid();
    showToast(
      room.access.length
        ? `Доступ сохранён: ${studentsLabel(room.access.length)}`
        : 'Доступ закрыт для всех учеников',
    );
  });

  $('#create-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const input = $('#create-name');
    const name = input.value.trim();
    if (!name) {
      $('#create-error').textContent = 'Введите название комнаты.';
      $('#create-error').hidden = false;
      input.focus();
      return;
    }
    const user = currentUser();
    state.rooms.push({
      id: `r_${Date.now()}`,
      name,
      owner: { id: user.id, name: user.name },
      access: [],
    });
    closeDialog('create-dialog');
    renderRoomGrid();
    showToast(`Комната «${name}» создана`);
  });

  $('#rename-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const room = state.rooms.find((item) => item.id === state.renameRoomId);
    if (!room) return;
    const input = $('#rename-name');
    const name = input.value.trim();
    if (!name) {
      $('#rename-error').textContent = 'Введите название комнаты.';
      $('#rename-error').hidden = false;
      input.focus();
      return;
    }
    room.name = name;
    closeDialog('rename-dialog');
    renderRoomGrid();
    showToast('Название комнаты обновлено');
  });

  $('#delete-confirm').addEventListener('click', () => {
    const room = state.rooms.find((item) => item.id === state.deleteRoomId);
    if (!room) return;
    state.rooms = state.rooms.filter((item) => item.id !== room.id);
    closeDialog('delete-dialog');
    renderRoomGrid();
    showToast(`Комната «${room.name}» удалена`);
  });

  $('#password-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const value = $('#password-value').value;
    if (value.length < 8) {
      $('#password-error').textContent = 'Пароль должен быть не короче 8 символов.';
      $('#password-error').hidden = false;
      return;
    }
    const user = state.users.find((item) => item.id === state.passwordUserId);
    closeDialog('password-dialog');
    showToast(user ? `Пароль для ${user.name} обновлён` : 'Пароль обновлён');
  });
}

function handleAction(action) {
  if (action === 'create') {
    openCreateDialog();
  } else if (action === 'refresh') {
    showToast('Список обновлён');
  } else if (action === 'refresh-users') {
    showToast('Список пользователей обновлён');
  } else if (action === 'reset-search') {
    state.search = '';
    renderRoomsPage();
    setTimeout(() => $('#rooms-search')?.focus(), 20);
  } else if (action === 'logout') {
    showToast('Выход из аккаунта — в рабочей версии');
  } else if (action === 'open-pending') {
    state.page = 'users';
    state.usersFilter = 'pending';
    state.usersSearch = '';
    render();
    window.scrollTo({ top: 0, behavior: 'auto' });
  }
}

function handleUserAction(action, userId) {
  const user = state.users.find((item) => item.id === userId);
  if (!user) return;

  if (action === 'approve') {
    user.status = 'active';
    showToast(`${user.name}: заявка подтверждена`);
  } else if (action === 'reject') {
    user.status = 'rejected';
    showToast(`${user.name}: заявка отклонена`);
  } else if (action === 'block') {
    user.status = 'blocked';
    state.rooms.forEach((room) => {
      room.access = room.access.filter((id) => id !== user.id);
    });
    showToast(`${user.name} заблокирован(а)`);
  } else if (action === 'unblock') {
    user.status = 'active';
    showToast(`${user.name} разблокирован(а)`);
  } else if (action === 'password') {
    openPasswordDialog(user);
    return;
  }

  renderNav();
  renderSidebarTip();
  renderUsersPage();
}

/* ------------------------------------------------------------------- init */

bindGlobalHandlers();
render();
