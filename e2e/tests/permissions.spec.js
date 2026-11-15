import { expect, test } from '@playwright/test';

import {
  drawRect,
  firstObjectId,
  login,
  objectCount,
  selectObject,
  uniqueRoom,
  waitForObjectCount,
} from '../helpers.js';
test('permissions: student cannot delete or clear, teacher can clear and kick', async ({
  browser,
}) => {
  const room = uniqueRoom('perm');
  const teacherContext = await browser.newContext();
  const studentContext = await browser.newContext();
  const teacher = await teacherContext.newPage();
  const student = await studentContext.newPage();

  await login(teacher, { name: 'Учитель', role: 'teacher', room });
  await login(student, { name: 'Ученик', role: 'student', room });

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

  // The teacher kicks the student; the student returns to the login screen.
  await expect(teacher.locator('.user__kick')).toHaveCount(1);
  teacher.once('dialog', (dialog) => dialog.accept());
  await teacher.click('.user__kick');
  await expect(student.locator('#login')).toBeVisible({ timeout: 15_000 });
  await expect(student.locator('#app')).toBeHidden();

  await teacherContext.close();
  await studentContext.close();
});
