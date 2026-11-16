/** Дашборд: комнаты ученика/учителя и админская панель. */

const $ = (selector) => document.querySelector(selector);

const ROLE_LABELS = {
  student: 'Ученик',
  teacher: 'Учитель',
  admin: 'Администратор',
};

let els = null;
let handlers = { onOpenRoom: () => {}, onLogout: () => {} };

export function initDashboard(options) {
  handlers = { ...handlers, ...options };
  els = {
    root: $('#dashboard'),
    name: $('#dash-name'),
    role: $('#dash-role'),
    rooms: $('#dash-rooms'),
    empty: $('#dash-empty'),
    create: $('#create-room'),
    admin: $('#dash-admin'),
    logout: $('#logout-btn'),
  };
  els.logout.addEventListener('click', () => handlers.onLogout());
}

export function showDashboard({ user, permissions }) {
  els.root.hidden = false;
  $('#auth').hidden = true;
  $('#status-screen').hidden = true;
  $('#app').hidden = true;
  els.name.textContent = user.name;
  els.role.textContent = ROLE_LABELS[user.role] || user.role;
  els.create.hidden = !permissions.canCreateRooms;
  els.admin.hidden = !permissions.canManageAccounts;
  if (!els.rooms.children.length) {
    els.empty.hidden = false;
    els.empty.textContent = 'Пока нет комнат';
  }
}

export function currentDashboardHandlers() {
  return handlers;
}
