import { expect, test } from '@playwright/test';

import {
  drawRect,
  login,
  objectCount,
  reloadAndWait,
  uniqueRoom,
  waitForObjectCount,
} from '../helpers.js';

test('reconnect: reload restores the session and the socket keeps syncing', async ({
  browser,
}) => {
  const room = uniqueRoom('reconnect');
  const teacherContext = await browser.newContext();
  const studentContext = await browser.newContext();
  const teacher = await teacherContext.newPage();
  const student = await studentContext.newPage();

  await login(teacher, { name: 'Учитель', role: 'teacher', room });
  await login(student, { name: 'Ученик', role: 'student', room });

  await drawRect(teacher, { x: 200, y: 200 }, { x: 340, y: 300 });
  await waitForObjectCount(student, 1);

  // A reload reconnects with the stored token and restores the snapshot.
  await reloadAndWait(teacher);
  await waitForObjectCount(teacher, 1, 15_000);
  expect(await objectCount(teacher)).toBe(1);

  // The new WebSocket continues to work in both directions.
  await drawRect(teacher, { x: 600, y: 300 }, { x: 760, y: 420 });
  await waitForObjectCount(student, 2);

  await teacherContext.close();
  await studentContext.close();
});
