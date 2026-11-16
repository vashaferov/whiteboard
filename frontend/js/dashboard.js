/** Дашборд: комнаты ученика/учителя и админская панель. */

import { adminApi, roomsApi, usersApi } from './api.js';

const $ = (selector) => document.querySelector(selector);

const ROLE_LABELS = {
  student: 'Ученик',
  teacher: 'Учитель',
  admin: 'Администратор',
};

const STATUS_LABELS = {
  pending: 'На рассмотрении',
  active: 'Активен',
  blocked: 'Заблокирован',
  rejected: 'Отклонён',
};

let els = null;
let handlers = { onOpenRoom: () => {}, onLogout: () => {}, onSessionLost: () => {} };
let currentUser = null;
let currentPermissions = null;
let accessRoom = null;
let selectedStudentIds = new Set();
let searchTimer = null;

export function initDashboard(options) {
  handlers = { ...handlers, ...options };
  els = {
    root: $('#dashboard'),
    name: $('#dash-name'),
    role: $('#dash-role'),
    rooms: $('#dash-rooms'),
    empty: $('#dash-empty'),
    error: $('#dash-error'),
    create: $('#create-room'),
    admin: $('#dash-admin'),
    logout: $('#logout-btn'),
    accessDialog: $('#access-dialog'),
    accessTitle: $('#access-title'),
    accessSearch: $('#access-search'),
    accessList: $('#access-list'),
    accessError: $('#access-error'),
    accessSave: $('#access-save'),
    accessCancel: $('#access-cancel'),
    tabUsers: $('#admin-tab-users'),
    tabRooms: $('#admin-tab-rooms'),
    refreshAdmin: $('#admin-refresh'),
    statusFilter: $('#admin-status-filter'),
    usersPanel: $('#admin-users-panel'),
    roomsPanel: $('#admin-rooms-panel'),
    adminUsers: $('#admin-users'),
    adminRooms: $('#admin-rooms'),
    adminError: $('#admin-error'),
  };

  els.logout.addEventListener('click', () => handlers.onLogout());
  els.create.addEventListener('click', createRoom);
  els.accessCancel.addEventListener('click', () => els.accessDialog.close());
  els.accessSave.addEventListener('click', saveAccess);
  els.accessSearch.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(searchStudents, 250);
  });
  els.tabUsers.addEventListener('click', () => selectAdminTab('users'));
  els.tabRooms.addEventListener('click', () => selectAdminTab('rooms'));
  els.statusFilter.addEventListener('change', loadAdminUsers);
  els.refreshAdmin.addEventListener('click', () => {
    if (els.tabRooms.classList.contains('is-active')) loadAdminRooms();
    else loadAdminUsers();
  });
  window.addEventListener('focus', () => {
    if (!els.root.hidden) loadRooms();
  });
}

export function showDashboard({ user, permissions }) {
  currentUser = user;
  currentPermissions = permissions;
  els.root.hidden = false;
  $('#auth').hidden = true;
  $('#status-screen').hidden = true;
  $('#app').hidden = true;
  els.name.textContent = user.name;
  els.role.textContent = ROLE_LABELS[user.role] || user.role;
  els.create.hidden = !permissions.canCreateRooms;
  els.admin.hidden = !permissions.canManageAccounts;
  showError('');
  loadRooms();
  if (permissions.canManageAccounts) {
    selectAdminTab('users');
  }
}

function showError(message) {
  if (els.error) els.error.textContent = message;
}

function canManageRoom(room) {
  if (!currentUser) return false;
  if (currentUser.role === 'admin') return true;
  return currentUser.role === 'teacher' && room.owner.id === currentUser.id;
}

async function loadRooms() {
  try {
    const rooms = await roomsApi.list();
    renderRooms(rooms);
  } catch (error) {
    showError(error.message || 'Не удалось загрузить комнаты');
  }
}

function button(label, className, onClick) {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = `btn btn--small ${className}`;
  element.textContent = label;
  element.addEventListener('click', onClick);
  return element;
}

function renderRooms(rooms) {
  els.rooms.replaceChildren();
  els.empty.hidden = rooms.length > 0;
  if (!rooms.length) {
    els.empty.textContent =
      currentUser?.role === 'student'
        ? 'Вам ещё не выдали доступ ни к одной комнате.'
        : 'Пока нет комнат. Создайте первую.';
  }

  for (const room of rooms) {
    const item = document.createElement('li');
    item.className = 'room-card';

    const name = document.createElement('span');
    name.className = 'room-card__name';
    name.textContent = room.name;
    item.appendChild(name);

    const owner = document.createElement('span');
    owner.className = 'room-card__owner';
    owner.textContent = `Учитель: ${room.owner.name}`;
    item.appendChild(owner);

    const actions = document.createElement('div');
    actions.className = 'room-card__actions';
    actions.appendChild(button('Открыть', 'room-card__open', () => handlers.onOpenRoom(room.id)));

    if (canManageRoom(room)) {
      actions.appendChild(button('Доступ', 'room-card__access', () => openAccess(room)));
      actions.appendChild(button('Переименовать', 'room-card__rename', () => renameRoom(room)));
      actions.appendChild(button('Удалить', 'room-card__delete', () => deleteRoom(room)));
    }
    item.appendChild(actions);
    els.rooms.appendChild(item);
  }
}

async function createRoom() {
  const name = window.prompt('Название комнаты', 'Комната');
  if (name === null || !name.trim()) return;
  try {
    await roomsApi.create(name.trim());
    showError('');
    await loadRooms();
  } catch (error) {
    showError(error.message || 'Не удалось создать комнату');
  }
}

async function renameRoom(room) {
  const name = window.prompt('Название комнаты', room.name);
  if (name === null || !name.trim()) return;
  try {
    await roomsApi.rename(room.id, name.trim());
    showError('');
    await loadRooms();
  } catch (error) {
    showError(error.message || 'Не удалось переименовать комнату');
  }
}

async function deleteRoom(room) {
  const confirmed = window.confirm(
    `Удалить комнату «${room.name}»? Все объекты и доступы будут удалены безвозвратно.`,
  );
  if (!confirmed) return;
  try {
    await roomsApi.remove(room.id);
    showError('');
    await loadRooms();
  } catch (error) {
    showError(error.message || 'Не удалось удалить комнату');
  }
}

async function openAccess(room) {
  accessRoom = room;
  selectedStudentIds = new Set();
  els.accessTitle.textContent = `Доступ к комнате «${room.name}»`;
  els.accessSearch.value = '';
  els.accessError.textContent = '';
  els.accessList.replaceChildren();
  els.accessDialog.showModal();

  try {
    const [access, students] = await Promise.all([
      roomsApi.access(room.id),
      usersApi.students(''),
    ]);
    selectedStudentIds = new Set(access.map((student) => student.id));
    renderAccessList(students);
  } catch (error) {
    els.accessError.textContent = error.message || 'Не удалось загрузить доступ';
  }
}

async function searchStudents() {
  if (!accessRoom) return;
  try {
    const students = await usersApi.students(els.accessSearch.value.trim());
    renderAccessList(students);
  } catch (error) {
    els.accessError.textContent = error.message || 'Не удалось найти учеников';
  }
}

function renderAccessList(students) {
  els.accessList.replaceChildren();
  if (!students.length) {
    const empty = document.createElement('li');
    empty.className = 'access-list__empty';
    empty.textContent = 'Никого не найдено';
    els.accessList.appendChild(empty);
    return;
  }

  for (const student of students) {
    const item = document.createElement('li');
    item.className = 'access-item';

    const label = document.createElement('label');
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.dataset.userId = student.id;
    check.checked = selectedStudentIds.has(student.id);
    check.addEventListener('change', () => {
      if (check.checked) selectedStudentIds.add(student.id);
      else selectedStudentIds.delete(student.id);
    });

    const text = document.createElement('span');
    text.textContent = `${student.name} (${student.login})`;

    label.append(check, text);
    item.appendChild(label);
    els.accessList.appendChild(item);
  }
}

async function saveAccess() {
  if (!accessRoom) return;
  els.accessSave.disabled = true;
  try {
    await roomsApi.setAccess(accessRoom.id, [...selectedStudentIds]);
    els.accessDialog.close();
    showError('');
    await loadRooms();
  } catch (error) {
    els.accessError.textContent = error.message || 'Не удалось сохранить доступ';
  } finally {
    els.accessSave.disabled = false;
  }
}

/* ------------------------------------------------------------- admin panel */

function selectAdminTab(tab) {
  const usersActive = tab === "users";
  els.tabUsers.classList.toggle("is-active", usersActive);
  els.tabRooms.classList.toggle("is-active", !usersActive);
  els.usersPanel.hidden = !usersActive;
  els.roomsPanel.hidden = usersActive;
  if (usersActive) loadAdminUsers();
  else loadAdminRooms();
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function handleAdminError(error) {
  if (error.status === 401) {
    handlers.onSessionLost();
    return;
  }
  els.adminError.textContent = error.message || "Не удалось выполнить действие";
}

async function loadAdminUsers() {
  if (!currentPermissions?.canManageAccounts) return;
  try {
    const users = await adminApi.listUsers({ status: els.statusFilter.value });
    renderAdminUsers(users);
    els.adminError.textContent = "";
  } catch (error) {
    handleAdminError(error);
  }
}

function renderAdminUsers(users) {
  els.adminUsers.replaceChildren();
  if (!users.length) {
    els.adminUsers.appendChild(element("li", "admin-list__empty", "Пользователей нет"));
    return;
  }

  for (const user of users) {
    const item = element("li", "admin-user");
    item.append(
      element("span", "admin-user__login", user.login),
      element("span", "admin-user__name", user.name),
      element("span", "admin-user__status", STATUS_LABELS[user.status] || user.status),
    );

    if (user.role === "admin") {
      item.appendChild(element("span", "badge", "администратор"));
    } else {
      const role = document.createElement("select");
      role.className = "admin-user__role";
      for (const value of ["student", "teacher"]) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = ROLE_LABELS[value];
        role.appendChild(option);
      }
      role.value = user.role;
      role.addEventListener("change", () => patchUser(user, { role: role.value }));
      item.appendChild(role);
    }

    const actions = element("div", "admin-user__actions");
    if (user.status === "pending") {
      actions.appendChild(
        button("Подтвердить", "admin-user__approve", () => patchUser(user, { status: "active" })),
      );
      actions.appendChild(
        button("Отклонить", "admin-user__reject", () => patchUser(user, { status: "rejected" })),
      );
    }
    if (user.role !== "admin") {
      const blocked = user.status === "blocked";
      actions.appendChild(
        button(
          blocked ? "Разблокировать" : "Заблокировать",
          "admin-user__block",
          () => patchUser(user, { status: blocked ? "active" : "blocked" }),
        ),
      );
      actions.appendChild(
        button("Пароль", "admin-user__password", () => resetPassword(user)),
      );
    }
    item.appendChild(actions);
    els.adminUsers.appendChild(item);
  }
}

async function patchUser(user, patch) {
  try {
    await adminApi.updateUser(user.id, patch);
    els.adminError.textContent = "";
    await loadAdminUsers();
  } catch (error) {
    handleAdminError(error);
  }
}

async function resetPassword(user) {
  const password = window.prompt(`Новый пароль для ${user.login} (не короче 8 символов)`);
  if (password === null || !password) return;
  try {
    await adminApi.resetPassword(user.id, password);
    els.adminError.textContent = "";
    await loadAdminUsers();
  } catch (error) {
    handleAdminError(error);
  }
}

async function loadAdminRooms() {
  if (!currentPermissions?.canManageAccounts) return;
  try {
    const rooms = await roomsApi.all();
    renderAdminRooms(rooms);
    els.adminError.textContent = "";
  } catch (error) {
    handleAdminError(error);
  }
}

function renderAdminRooms(rooms) {
  els.adminRooms.replaceChildren();
  if (!rooms.length) {
    els.adminRooms.appendChild(element("li", "admin-list__empty", "Комнат нет"));
    return;
  }

  for (const room of rooms) {
    const item = element("li", "admin-room");
    item.append(
      element("span", "admin-room__name", room.name),
      element("span", "admin-room__owner", `Учитель: ${room.owner.name}`),
    );
    const actions = element("div", "admin-room__actions");
    actions.appendChild(button("Открыть", "admin-room__open", () => handlers.onOpenRoom(room.id)));
    actions.appendChild(
      button("Удалить", "admin-room__delete", async () => {
        if (!window.confirm(`Удалить комнату «${room.name}»?`)) return;
        try {
          await roomsApi.remove(room.id);
          await loadAdminRooms();
          await loadRooms();
        } catch (error) {
          handleAdminError(error);
        }
      }),
    );
    item.appendChild(actions);
    els.adminRooms.appendChild(item);
  }
}
