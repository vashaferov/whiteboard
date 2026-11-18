import { expect, test } from '@playwright/test';

import {
  makeActiveStudent,
  makeTeacher,
  signInWith,
  uniqueLogin,
} from '../helpers.js';

test('rooms: teacher manages rooms and grants access', async ({ browser, request }) => {
  const teacherLogin = uniqueLogin('teacher');
  const studentLogin = uniqueLogin('student');
  const studentName = 'Ученик Тест';
  await makeTeacher(request, { login: teacherLogin, name: 'Учитель Тест' });
  await makeActiveStudent(request, { login: studentLogin, name: studentName });

  const teacherContext = await browser.newContext();
  const studentContext = await browser.newContext();
  const teacher = await teacherContext.newPage();
  const student = await studentContext.newPage();

  await signInWith(request, teacher, teacherLogin);
  await teacher.goto('/');
  await expect(teacher.locator('#dashboard')).toBeVisible();
  await expect(teacher.locator('#create-room')).toBeVisible();

  await teacher.click('#create-room');
  await teacher.fill('#create-room-name', 'Алгебра');
  await teacher.click('#create-room-submit');
  await expect(teacher.locator('.room-card__name')).toHaveText('Алгебра');

  await teacher.locator('.room-card__menu').click();
  await teacher.click('.room-card__rename');
  await teacher.fill('#rename-room-name', 'Алгебра 7');
  await teacher.click('#rename-room-submit');
  await expect(teacher.locator('.room-card__name')).toHaveText('Алгебра 7');

  await signInWith(request, student, studentLogin);
  await student.goto('/');
  await expect(student.locator('#dashboard')).toBeVisible();
  await expect(student.locator('.room-card')).toHaveCount(0);
  await expect(student.locator('#dash-empty')).toBeVisible();
  await expect(student.locator('#create-room')).toBeHidden();

  await teacher.click('.room-card__access');
  await expect(teacher.locator('#access-dialog')).toBeVisible();
  await teacher.fill('#access-search', studentLogin);
  const studentRow = teacher.locator('#access-list .access-item', { hasText: studentLogin });
  await expect(studentRow).toBeVisible();
  await studentRow.locator('input[type="checkbox"]').check();
  await teacher.click('#access-save');
  await expect(teacher.locator('#access-dialog')).toBeHidden();

  await student.reload();
  await expect(student.locator('.room-card__name')).toHaveText('Алгебра 7');
  await expect(student.locator('.room-card__access')).toHaveCount(0);
  await expect(student.locator('.room-card__delete')).toHaveCount(0);

  await teacher.locator('.room-card__menu').click();
  await teacher.click('.room-card__delete');
  await teacher.click('#delete-room-confirm');
  await expect(teacher.locator('.room-card')).toHaveCount(0);

  await student.reload();
  await expect(student.locator('.room-card')).toHaveCount(0);
  await expect(student.locator('#dash-empty')).toBeVisible();

  await teacherContext.close();
  await studentContext.close();
});
