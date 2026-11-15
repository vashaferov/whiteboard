import { expect, test } from '@playwright/test';

import {
  activePageName,
  createPage,
  drawRect,
  login,
  movePage,
  objectCount,
  pageNames,
  reloadAndWait,
  renamePage,
  selectPage,
  uniqueRoom,
} from '../helpers.js';

test('workspaces: create, isolate, switch, rename, reorder, reload', async ({ browser }) => {
  const room = uniqueRoom('ws');
  const teacherContext = await browser.newContext();
  const studentContext = await browser.newContext();
  const teacher = await teacherContext.newPage();
  const student = await studentContext.newPage();

  await login(teacher, { name: 'Учитель', role: 'teacher', room });
  await login(student, { name: 'Ученик', role: 'student', room });

  expect(await pageNames(student)).toEqual(['Страница 1']);
  await createPage(teacher, 'Вторая');
  await expect.poll(() => pageNames(student)).toEqual(['Страница 1', 'Вторая']);
  expect(await activePageName(teacher)).toBe('Вторая');

  await drawRect(teacher, { x: 300, y: 300 }, { x: 420, y: 390 });
  await expect.poll(() => objectCount(teacher)).toBe(1);
  expect(await objectCount(student)).toBe(0);

  await selectPage(student, 'Вторая');
  await expect.poll(() => objectCount(student)).toBe(1);

  await renamePage(teacher, 'Вторая', 'Черновик');
  await expect.poll(() => pageNames(student)).toEqual(['Страница 1', 'Черновик']);

  await movePage(teacher, 'Черновик', 'up');
  await expect.poll(() => pageNames(student)).toEqual(['Черновик', 'Страница 1']);

  await reloadAndWait(student);
  await expect.poll(() => pageNames(student)).toEqual(['Черновик', 'Страница 1']);
  expect(await activePageName(student)).toBe('Черновик');

  await teacherContext.close();
  await studentContext.close();
});
