/** Дашборд: комнаты ученика/учителя и админская панель. */

import { roomsApi, usersApi } from './api.js';

const $ = (selector) => document.querySelector(selector);

const ROLE_LABELS = {
  student: 'Ученик',
  teacher: 'Учитель',
  admin: 'Администратор',
};

let els = null;
let handlers = { onOpenRoom: () => {}, onLogout: () => {} };
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
  };

  els.logout.addEventListener('click', () => handlers.onLogout());
  els.create.addEventListener('click', createRoom);
  els.accessCancel.addEventListener('click', () => els.accessDialog.close());
  els.accessSave.addEventListener('click', saveAccess);
  els.accessSearch.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(searchStudents, 250);
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
