/** Экран входа/регистрации и экран статуса заявки. */

import { ApiError, authApi } from './api.js';

const $ = (selector) => document.querySelector(selector);

let els = null;
let mode = 'login';
let onAuthenticated = () => {};

export function initAuth({ onAuthenticated: handler }) {
  onAuthenticated = handler;
  const form = $('#auth-form');
  els = {
    root: $('#auth'),
    form,
    error: $('#auth-error'),
    submit: $('#auth-submit'),
    tabLogin: $('#auth-tab-login'),
    tabRegister: $('#auth-tab-register'),
    nameField: $('#auth-name-field'),
    name: form.elements.name,
    login: form.elements.login,
    password: form.elements.password,
    statusScreen: $('#status-screen'),
    statusText: $('#status-text'),
    statusBack: $('#status-back'),
  };

  els.tabLogin.addEventListener('click', () => setMode('login'));
  els.tabRegister.addEventListener('click', () => setMode('register'));
  els.form.addEventListener('submit', submit);
  els.statusBack.addEventListener('click', () => showAuth());
  setMode('login');
}

function setMode(next) {
  mode = next;
  const registering = mode === 'register';
  els.nameField.hidden = !registering;
  els.name.required = registering;
  els.tabLogin.classList.toggle('is-active', !registering);
  els.tabRegister.classList.toggle('is-active', registering);
  els.submit.textContent = registering ? 'Зарегистрироваться' : 'Войти';
  els.password.autocomplete = registering ? 'new-password' : 'current-password';
  showError('');
}

function showError(message) {
  els.error.textContent = message;
}

async function submit(event) {
  event.preventDefault();
  const login = els.login.value.trim();
  const password = els.password.value;
  if (!login || !password) {
    showError('Укажите логин и пароль');
    return;
  }

  showError('');
  els.submit.disabled = true;
  try {
    if (mode === 'register') {
      const name = els.name.value.trim();
      if (!name) {
        showError('Укажите имя');
        return;
      }
      await authApi.register({ login, name, password });
      els.form.reset();
      showStatusScreen(
        'Заявка отправлена. Администратор должен подтвердить учётную запись — после этого можно войти.',
      );
      return;
    }

    const me = await authApi.login(login, password);
    onAuthenticated(me);
  } catch (error) {
    if (error instanceof ApiError && ['pending', 'rejected', 'blocked'].includes(error.code)) {
      showStatusScreen(error.message);
    } else {
      showError(error.message || 'Не удалось выполнить запрос');
    }
  } finally {
    els.submit.disabled = false;
  }
}

export function showAuth(message = '') {
  document.querySelectorAll('#dashboard dialog[open]').forEach((dialog) => dialog.close());
  window.dispatchEvent(new Event('wb:auth'));
  els.root.hidden = false;
  els.statusScreen.hidden = true;
  $('#dashboard').hidden = true;
  $('#app').hidden = true;
  showError(message);
  els.login.focus();
}

export function showStatusScreen(text) {
  els.root.hidden = true;
  els.statusScreen.hidden = false;
  els.statusText.textContent = text;
}
