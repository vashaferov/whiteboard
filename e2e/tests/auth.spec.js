import { expect, test } from '@playwright/test';

import {
  DEFAULT_PASSWORD,
  makeActiveStudent,
  uniqueLogin,
  approveUser,
} from '../helpers.js';

async function openAuth(page) {
  await page.goto('/');
  await expect(page.locator('#auth')).toBeVisible();
}

async function fillCredentials(page, login, password = DEFAULT_PASSWORD) {
  await page.fill('#auth-form input[name="login"]', login);
  await page.fill('#auth-form input[name="password"]', password);
  await page.click('#auth-submit');
}

test('auth: registration, admin approval, login and logout', async ({ page, request }) => {
  const login = uniqueLogin('auth');
  const name = 'Тест Ученик';

  await openAuth(page);
  await page.click('#auth-tab-register');
  await page.fill('#auth-name-field input', name);
  await fillCredentials(page, login);

  await expect(page.locator('#status-screen')).toBeVisible();
  await expect(page.locator('#status-text')).toContainText('Заявка отправлена');

  await page.click('#status-back');
  await page.click('#auth-tab-login');
  await fillCredentials(page, login);
  await expect(page.locator('#status-screen')).toBeVisible();
  await expect(page.locator('#status-text')).toContainText('рассмотрении');

  await test.step('admin approves the account', async () => {
    await approveUser(request, login);
  });

  await page.click('#status-back');
  await page.click('#auth-tab-login');
  await fillCredentials(page, login);
  await expect(page.locator('#dashboard')).toBeVisible();
  await expect(page.locator('#dash-name')).toHaveText(name);
  await expect(page.locator('#dash-role')).toHaveText('Ученик');

  await page.click('#logout-btn');
  await expect(page.locator('#auth')).toBeVisible();
  await expect(page.locator('#dashboard')).toBeHidden();
});

test('auth: wrong password and blocked account are reported', async ({ page, request }) => {
  const login = uniqueLogin('wrong');
  await makeActiveStudent(request, { login, name: 'Ошибка' });

  await openAuth(page);
  await fillCredentials(page, login, 'bad-password-1');
  await expect(page.locator('#auth-error')).toContainText('Неверный логин или пароль');
  await expect(page.locator('#dashboard')).toBeHidden();
});
