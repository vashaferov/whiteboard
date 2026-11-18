import { expect, test } from '@playwright/test';

import {
  ADMIN_LOGIN,
  ADMIN_PASSWORD,
  DEFAULT_PASSWORD,
  findAdminUser,
  registerUser,
  signInWith,
  uniqueLogin,
} from '../helpers.js';

async function adminPage(browser, request) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signInWith(request, page, ADMIN_LOGIN, ADMIN_PASSWORD);
  await page.goto('/');
  await expect(page.locator('#dashboard')).toBeVisible();
  await page.click('#admin-tab-users');
  await expect(page.locator('#dash-admin')).toBeVisible();
  return { context, page };
}

test('admin: approves, promotes, blocks and resets passwords', async ({ browser, request }) => {
  const login = uniqueLogin('managed');
  await registerUser(request, { login, name: 'Управляемый' });

  const { context, page } = await adminPage(browser, request);
  await page.fill('#admin-search', ADMIN_LOGIN);
  const adminRow = page.locator('.db-user-row', { hasText: ADMIN_LOGIN });
  await expect(adminRow.locator('[data-user-action="password"]')).toBeVisible();

  await page.fill('#admin-search', login);
  const row = page.locator('.db-user-row', { hasText: login });
  await expect(row.locator('.db-user-row__status')).toHaveText('Заявка');

  await row.locator('[data-user-action="approve"]').click();
  await expect(row.locator('.db-user-row__status')).toHaveText('Активен');
  const allowed = await request.post('/api/login', {
    data: { login, password: DEFAULT_PASSWORD },
  });
  expect(allowed.status()).toBe(200);

  await row.locator('select[data-user-role]').selectOption('teacher');
  await expect.poll(async () => (await findAdminUser(request, login))?.role).toBe('teacher');

  await row.locator('[data-user-action="block"]').click();
  await expect(row.locator('.db-user-row__status')).toHaveText('Заблокирован');
  const blocked = await request.post('/api/login', {
    data: { login, password: DEFAULT_PASSWORD },
  });
  expect(blocked.status()).toBe(403);

  await row.locator('[data-user-action="unblock"]').click();
  await expect(row.locator('.db-user-row__status')).toHaveText('Активен');

  await row.locator('[data-user-action="password"]').click();
  await page.fill('#password-value', 'brand-new-1');
  await page.click('#password-submit');
  await expect(page.locator('#password-dialog')).toBeHidden();
  await expect
    .poll(async () => {
      const response = await request.post('/api/login', {
        data: { login, password: 'brand-new-1' },
      });
      return response.status();
    })
    .toBe(200);

  const old = await request.post('/api/login', {
    data: { login, password: DEFAULT_PASSWORD },
  });
  expect(old.status()).toBe(401);

  await context.close();
});

test('admin: restores a rejected registration', async ({ browser, request }) => {
  const login = uniqueLogin('rejected');
  await registerUser(request, { login, name: 'Отклонённый' });

  const { context, page } = await adminPage(browser, request);
  await page.fill('#admin-search', login);
  const row = page.locator('.db-user-row', { hasText: login });
  await expect(row.locator('.db-user-row__status')).toHaveText('Заявка');

  await row.locator('[data-user-action="reject"]').click();
  await expect(row.locator('.db-user-row__status')).toHaveText('Отклонён');

  await row.locator('[data-user-action="approve"]').click();
  await expect(row.locator('.db-user-row__status')).toHaveText('Активен');

  await context.close();
});

test('admin: sees and deletes any room', async ({ browser, request }) => {
  const roomName = `Комната админа ${Date.now().toString(36)}`;
  const { context, page } = await adminPage(browser, request);

  await page.click('#admin-tab-rooms');
  await expect(page.locator('#create-room')).toBeVisible();

  await page.click('#create-room');
  await page.fill('#create-room-name', roomName);
  await page.click('#create-room-submit');

  const card = page.locator('.room-card', { hasText: roomName });
  await expect(card).toBeVisible();

  await card.locator('.room-card__menu').click();
  await card.locator('.room-card__delete').click();
  await page.click('#delete-room-confirm');
  await expect(card).toHaveCount(0);

  await context.close();
});
