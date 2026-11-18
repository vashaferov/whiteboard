import { expect, test } from '@playwright/test';

import {
  ADMIN_LOGIN,
  ADMIN_PASSWORD,
  lessonSetup,
  openLesson,
  openRoom,
  signInWith,
} from '../helpers.js';

test('admin is hidden from students until the eye is toggled', async ({ browser, request }) => {
  const setup = await lessonSetup(request, { name: 'Invisible admin' });
  const { teacherContext, studentContext, teacher, student } = await openLesson(
    request,
    browser,
    setup,
  );
  const adminContext = await browser.newContext();
  const admin = await adminContext.newPage();
  await signInWith(request, admin, ADMIN_LOGIN, ADMIN_PASSWORD);
  await openRoom(admin, setup.room.id);

  const adminRow = (page) => page.locator('#user-list .user[data-role="admin"]');
  await expect(adminRow(teacher)).toBeVisible();
  await expect(adminRow(student)).toBeHidden();

  await admin.click('#invisible-toggle');
  await expect(adminRow(student)).toBeVisible();

  await admin.click('#invisible-toggle');
  await expect(adminRow(student)).toBeHidden();
  await expect(adminRow(teacher)).toBeVisible();

  await adminContext.close();
  await teacherContext.close();
  await studentContext.close();
});
