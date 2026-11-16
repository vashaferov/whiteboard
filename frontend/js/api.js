/** REST-клиент: единая обработка ошибок и cookie-сессии. */

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request(path, { method = 'GET', body } = {}) {
  const options = { method, credentials: 'same-origin', headers: {} };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(path, options);
  } catch {
    throw new ApiError(0, 'network', 'Сервер недоступен. Попробуйте ещё раз.');
  }

  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = data.detail;
    const structured = detail && typeof detail === 'object';
    throw new ApiError(
      response.status,
      structured ? detail.code : 'error',
      structured ? detail.message : detail || 'Ошибка запроса',
    );
  }
  return data;
}

export const authApi = {
  register: (payload) => request('/api/register', { method: 'POST', body: payload }),
  login: (login, password) =>
    request('/api/login', { method: 'POST', body: { login, password } }),
  logout: () => request('/api/logout', { method: 'POST' }),
  me: () => request('/api/me'),
};

const roomPath = (id) => `/api/rooms/${encodeURIComponent(id)}`;

export const roomsApi = {
  list: () => request('/api/rooms'),
  all: () => request('/api/rooms/all'),
  get: (id) => request(roomPath(id)),
  create: (name) => request('/api/rooms', { method: 'POST', body: { name } }),
  rename: (id, name) =>
    request(roomPath(id), { method: 'PATCH', body: { name } }),
  remove: (id) => request(roomPath(id), { method: 'DELETE' }),
  access: (id) => request(`${roomPath(id)}/access`),
  setAccess: (id, userIds) =>
    request(`${roomPath(id)}/access`, { method: 'PUT', body: { userIds } }),
};

export const usersApi = {
  students: (q = '') => request(`/api/users?q=${encodeURIComponent(q)}`),
};

export const adminApi = {
  listUsers: ({ status = '', role = '', q = '' } = {}) => {
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    if (role) params.set('role', role);
    if (q) params.set('q', q);
    const suffix = params.toString();
    return request(`/api/admin/users${suffix ? `?${suffix}` : ''}`);
  },
  updateUser: (id, patch) =>
    request(`/api/admin/users/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: patch,
    }),
  resetPassword: (id, password) =>
    request(`/api/admin/users/${encodeURIComponent(id)}/password`, {
      method: 'POST',
      body: { password },
    }),
};
