import { expect, test } from '@playwright/test';

import {
  ADMIN_LOGIN,
  ADMIN_PASSWORD,
  collectErrors,
  drawRect,
  firstObjectId,
  lessonSetup,
  objectCount,
  openLesson,
  openRoom,
  selectObject,
  signInWith,
  waitForObjectCount,
} from '../helpers.js';

test('permissions: student cannot delete or clear, teacher can clear and kick', async ({
  browser,
  request,
}) => {
  const setup = await lessonSetup(request, { name: 'Permissions' });
  const { teacherContext, studentContext, teacher, student } = await openLesson(
    request,
    browser,
    setup,
  );
  const errors = [...collectErrors(teacher, 'teacher'), ...collectErrors(student, 'student')];

  await drawRect(teacher, { x: 250, y: 250 }, { x: 420, y: 360 });
  await waitForObjectCount(student, 1);
  const objectId = await firstObjectId(student);
  expect(objectId).toBeTruthy();

  // The student has no clear button and cannot delete the teacher's object.
  await expect(student.locator('#clear-btn')).toBeHidden();
  await selectObject(student, { x: 335, y: 305 });
  await student.keyboard.press('Delete');
  await expect(student.locator('#toast')).toContainText('Удалять объекты может только учитель');
  expect(await objectCount(student)).toBe(1);

  // The teacher clears the board for everyone.
  teacher.once('dialog', (dialog) => dialog.accept());
  await teacher.click('#clear-btn');
  await waitForObjectCount(teacher, 0);
  await waitForObjectCount(student, 0);

  // The teacher kicks the student; the student returns to the dashboard.
  await expect(teacher.locator('.user__kick')).toHaveCount(1);
  teacher.once('dialog', (dialog) => dialog.accept());
  await teacher.click('.user__kick');
  await expect(student.locator('#dashboard')).toBeVisible({ timeout: 15_000 });
  await expect(student.locator('#app')).toBeHidden();

  expect(errors).toEqual([]);

  await teacherContext.close();
  await studentContext.close();
});

test('permissions: admin has teacher powers in a foreign room', async ({ browser, request }) => {
  const setup = await lessonSetup(request, { name: 'Admin powers' });
  const { teacherContext, studentContext, teacher, student } = await openLesson(
    request,
    browser,
    setup,
  );

  const adminContext = await browser.newContext();
  const admin = await adminContext.newPage();
  await signInWith(request, admin, ADMIN_LOGIN, ADMIN_PASSWORD);
  await openRoom(admin, setup.room.id);

  await drawRect(teacher, { x: 250, y: 250 }, { x: 420, y: 360 });
  await waitForObjectCount(student, 1);

  await admin.once('dialog', (dialog) => dialog.accept());
  await admin.click('#clear-btn');
  await waitForObjectCount(teacher, 0);
  await waitForObjectCount(student, 0);

  await teacherContext.close();
  await studentContext.close();
  await adminContext.close();
});
