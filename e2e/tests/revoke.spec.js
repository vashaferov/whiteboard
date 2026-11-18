import { expect, test } from '@playwright/test';

import {
  apiLogin,
  findAdminUser,
  lessonSetup,
  openLesson,
  openRoom,
  signInWith,
} from '../helpers.js';

test('access: revoking kicks the student and hides the room', async ({ browser, request }) => {
  const setup = await lessonSetup(request, { name: 'Revoke' });
  const { teacherContext, studentContext, teacher, student } = await openLesson(
    request,
    browser,
    setup,
  );

  await teacher.click('#leave-btn');
  await expect(teacher.locator('#dashboard')).toBeVisible();
  const card = teacher.locator('.room-card', { hasText: setup.room.name });
  await card.locator('.room-card__access').click();
  await expect(teacher.locator('#access-dialog')).toBeVisible();
  await teacher.fill('#access-search', setup.studentLogin);

  const row = teacher.locator('#access-list .access-item', {
    hasText: setup.studentLogin,
  });
  await expect(row).toBeVisible();
  await row.locator('input[type="checkbox"]').uncheck();
  await teacher.click('#access-save');
  await expect(teacher.locator('#access-dialog')).toBeHidden();

  // The live student is thrown back to the dashboard, the room disappears.
  await expect(student.locator('#dashboard')).toBeVisible({ timeout: 15_000 });
  await expect(student.locator('#app')).toBeHidden();

  await student.reload();
  await expect(student.locator('.room-card')).toHaveCount(0);

  // A deep link without access keeps the student on the dashboard.
  await student.goto(`/?room=${encodeURIComponent(setup.room.id)}`);
  await expect(student.locator('#dashboard')).toBeVisible();
  await expect(student.locator('#toast')).toContainText('Нет доступа');

  await teacherContext.close();
  await studentContext.close();
});

test('access: demoting the owner removes the room and the session', async ({
  browser,
  request,
}) => {
  const setup = await lessonSetup(request, { name: 'Demote' });
  const context = await browser.newContext();
  const page = await context.newPage();
  await signInWith(request, page, setup.teacherLogin);
  await openRoom(page, setup.room.id);

  const managed = await findAdminUser(request, setup.teacherLogin);
  const demoted = await request.patch(`/api/admin/users/${managed.id}`, {
    data: { role: 'student' },
  });
  expect(demoted.ok()).toBeTruthy();

  // Sessions are revoked, so the app returns to the login screen immediately.
  await expect(page.locator('#auth')).toBeVisible({ timeout: 15_000 });

  // A reload keeps the user on the login screen.
  await page.reload();
  await expect(page.locator('#auth')).toBeVisible({ timeout: 15_000 });

  // After logging in again the former owner is a plain student without rooms.
  await apiLogin(request, setup.teacherLogin);
  const state = await request.storageState();
  await page.context().addCookies(state.cookies);
  await page.goto('/');
  await expect(page.locator('#dashboard')).toBeVisible();
  await expect(page.locator('.room-card')).toHaveCount(0);

  await context.close();
});
