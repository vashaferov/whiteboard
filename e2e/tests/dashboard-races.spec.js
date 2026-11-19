import { expect, test } from '@playwright/test';

import {
  ADMIN_LOGIN,
  ADMIN_PASSWORD,
  createRoom,
  grantAccess,
  makeActiveStudent,
  makeTeacher,
  signInWith,
  uniqueLogin,
} from '../helpers.js';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function teacherWithRooms(request, { rooms = 1 } = {}) {
  const teacherLogin = uniqueLogin('race_teacher');
  await makeTeacher(request, { login: teacherLogin, name: 'Учитель' });
  const created = [];
  for (let index = 0; index < rooms; index += 1) {
    created.push(await createRoom(request, teacherLogin, `Комната ${index + 1}`));
  }
  return { teacherLogin, rooms: created };
}

async function student(request, name = 'Ученик') {
  const login = uniqueLogin('race_student');
  await makeActiveStudent(request, { login, name });
  return login;
}

test('access: Save is disabled until the current access list is loaded', async ({
  browser,
  request,
}) => {
  const { teacherLogin, rooms } = await teacherWithRooms(request);
  const studentLogin = await student(request);
  await grantAccess(request, rooms[0].id, teacherLogin, studentLogin);

  const context = await browser.newContext();
  const page = await context.newPage();
  await signInWith(request, page, teacherLogin);
  await page.goto('/');
  await expect(page.locator('#dashboard')).toBeVisible();

  await page.route('**/api/rooms/*/access', async (route) => {
    if (route.request().method() === 'GET') await delay(1500);
    await route.continue();
  });

  await page.locator('.room-card', { hasText: rooms[0].name }).locator('.room-card__access').click();
  await expect(page.locator('#access-dialog')).toBeVisible();
  await expect(page.locator('#access-save')).toBeDisabled();
  await expect(page.locator('#access-save')).toBeEnabled({ timeout: 10_000 });
  await expect(page.locator('#access-list input:checked')).toHaveCount(1);

  await context.close();
});

test('access: a failed access load keeps Save disabled and shows the error', async ({
  browser,
  request,
}) => {
  const { teacherLogin, rooms } = await teacherWithRooms(request);
  const studentLogin = await student(request);
  await grantAccess(request, rooms[0].id, teacherLogin, studentLogin);

  const context = await browser.newContext();
  const page = await context.newPage();
  await signInWith(request, page, teacherLogin);
  await page.goto('/');
  await expect(page.locator('#dashboard')).toBeVisible();

  await page.route('**/api/rooms/*/access', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ status: 500, body: 'boom' });
      return;
    }
    await route.continue();
  });

  await page.locator('.room-card', { hasText: rooms[0].name }).locator('.room-card__access').click();
  await expect(page.locator('#access-dialog')).toBeVisible();
  await expect(page.locator('#access-error')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('#access-save')).toBeDisabled();

  await context.close();
});

test('access: a late response from a previous room cannot change the current room', async ({
  browser,
  request,
}) => {
  const { teacherLogin, rooms } = await teacherWithRooms(request, { rooms: 2 });
  const firstStudent = await student(request, 'Первый');
  const secondStudent = await student(request, 'Второй');
  await grantAccess(request, rooms[0].id, teacherLogin, firstStudent);
  await grantAccess(request, rooms[1].id, teacherLogin, secondStudent);

  const context = await browser.newContext();
  const page = await context.newPage();
  await signInWith(request, page, teacherLogin);
  await page.goto('/');
  await expect(page.locator('#dashboard')).toBeVisible();

  await page.route('**/api/rooms/*/access', async (route) => {
    if (route.request().method() === 'GET' && route.request().url().includes(rooms[0].id)) {
      await delay(1800);
    }
    await route.continue();
  });

  await page.locator('.room-card', { hasText: rooms[0].name }).locator('.room-card__access').click();
  await expect(page.locator('#access-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#access-dialog')).toBeHidden();

  await page.locator('.room-card', { hasText: rooms[1].name }).locator('.room-card__access').click();
  await expect(page.locator('#access-dialog')).toBeVisible();
  await expect(page.locator('#access-list input:checked')).toHaveCount(1);
  await expect(page.locator('#access-dialog')).toContainText(rooms[1].name);
  await expect(page.locator('#access-list .access-item.is-selected')).toContainText('Второй');

  await delay(2200);
  await expect(page.locator('#access-dialog')).toContainText(rooms[1].name);
  await expect(page.locator('#access-list .access-item.is-selected')).toContainText('Второй');
  await expect(page.locator('#access-list .access-item.is-selected')).not.toContainText('Первый');

  await context.close();
});

test('session: an expired session closes an open dashboard dialog', async ({ browser, request }) => {
  const { teacherLogin } = await teacherWithRooms(request);
  const context = await browser.newContext();
  const page = await context.newPage();
  await signInWith(request, page, teacherLogin);
  await page.goto('/');
  await expect(page.locator('#dashboard')).toBeVisible();

  await page.click('#create-room');
  await expect(page.locator('#create-room-dialog')).toHaveJSProperty('open', true);

  await context.clearCookies();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));

  await expect(page.locator('#auth')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#create-room-dialog')).toHaveJSProperty('open', false);
  await expect(page.locator('#auth-submit')).toBeEnabled();

  await context.close();
});

test('admin: a late filter response cannot replace the active tab rows', async ({
  browser,
  request,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signInWith(request, page, ADMIN_LOGIN, ADMIN_PASSWORD);
  await page.goto('/');
  await expect(page.locator('#dashboard')).toBeVisible();
  await page.click('#admin-tab-users');
  await expect(page.locator('#dash-admin')).toBeVisible();

  await page.route('**/api/admin/users*', async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('status') === 'pending') await delay(1500);
    await route.continue();
  });

  await page.click('[data-user-filter="pending"]');
  await page.click('[data-user-filter="active"]');
  await expect(page.locator('[data-user-filter="active"]')).toHaveAttribute('aria-selected', 'true');
  await expect
    .poll(async () => {
      const statuses = await page.locator('.db-user-row__status').allTextContents();
      return statuses.length > 0 && statuses.every((text) => text === 'Активен');
    })
    .toBe(true);

  await delay(1800);
  await expect
    .poll(async () => {
      const statuses = await page.locator('.db-user-row__status').allTextContents();
      return statuses.length > 0 && statuses.every((text) => text === 'Активен');
    })
    .toBe(true);

  await context.close();
});
