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
  await expect(page.locator('#dash-admin')).toBeVisible();
  return { context, page };
}

test('admin: approves, promotes, blocks and resets passwords', async ({ browser, request }) => {
  const login = uniqueLogin('managed');
  await registerUser(request, { login, name: 'Управляемый' });

  const { context, page } = await adminPage(browser, request);
  const row = page.locator('.admin-user', { hasText: login });
  await expect(row.locator('.admin-user__status')).toHaveText('На рассмотрении');

  await row.locator('.admin-user__approve').click();
  await expect(row.locator('.admin-user__status')).toHaveText('Активен');
  const allowed = await request.post('/api/login', {
    data: { login, password: DEFAULT_PASSWORD },
  });
  expect(allowed.status()).toBe(200);

  await row.locator('select.admin-user__role').selectOption('teacher');
  await expect.poll(async () => (await findAdminUser(request, login))?.role).toBe('teacher');

  await row.locator('.admin-user__block').click();
  await expect(row.locator('.admin-user__status')).toHaveText('Заблокирован');
  const blocked = await request.post('/api/login', {
    data: { login, password: DEFAULT_PASSWORD },
  });
  expect(blocked.status()).toBe(403);

  await row.locator('.admin-user__block').click();
  await expect(row.locator('.admin-user__status')).toHaveText('Активен');

  page.once('dialog', (dialog) => dialog.accept('brand-new-1'));
  await row.locator('.admin-user__password').click();
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

test('admin: sees and deletes any room', async ({ browser, request }) => {
  const roomName = `Админская ${Date.now().toString(36)}`;
  const { context, page } = await adminPage(browser, request);

  page.once('dialog', (dialog) => dialog.accept(roomName));
  await page.click('#create-room');
  await expect(page.locator('.room-card__name', { hasText: roomName })).toBeVisible();

  await page.click('#admin-tab-rooms');
  const roomRow = page.locator('.admin-room', { hasText: roomName });
  await expect(roomRow).toBeVisible();

  page.once('dialog', (dialog) => dialog.accept());
  await roomRow.locator('.admin-room__delete').click();
  await expect(roomRow).toHaveCount(0);

  await context.close();
});
