import { expect, test } from '@playwright/test';

import {
  activePageName,
  createPage,
  deletePage,
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

test('workspaces: socket reconnect keeps the current page', async ({ browser }) => {
  const room = uniqueRoom('ws-reconnect');
  const teacherContext = await browser.newContext();
  const studentContext = await browser.newContext();
  const teacher = await teacherContext.newPage();
  const student = await studentContext.newPage();

  // Relay the student's socket so the test can drop the connection without
  // reloading the page; the client must reconnect with ?workspace=<current>.
  const sockets = [];
  await student.routeWebSocket(/\/ws\//, (socket) => {
    const server = socket.connectToServer();
    sockets.push(socket);
    socket.onMessage((message) => server.send(message));
    server.onMessage((message) => socket.send(message));
  });

  await login(teacher, { name: 'Учитель', role: 'teacher', room });
  await login(student, { name: 'Ученик', role: 'student', room });

  await createPage(teacher, 'Вторая');
  await expect.poll(() => pageNames(student)).toEqual(['Страница 1', 'Вторая']);
  await selectPage(student, 'Вторая');
  await expect.poll(() => activePageName(student)).toBe('Вторая');

  const first = sockets.at(-1);
  await first.close();
  await expect.poll(() => sockets.length, { timeout: 15_000 }).toBeGreaterThan(1);
  await expect(student.locator('#status')).toHaveText('Подключено', { timeout: 15_000 });
  expect(await activePageName(student)).toBe('Вторая');

  await teacherContext.close();
  await studentContext.close();
});

test('workspaces: switching to a deleted page recovers the board', async ({ browser }) => {
  const room = uniqueRoom('ws-abort');
  const teacherContext = await browser.newContext();
  const studentContext = await browser.newContext();
  const teacher = await teacherContext.newPage();
  const student = await studentContext.newPage();

  // Hold the student's switch until the teacher has deleted the target page,
  // which makes the server answer workspace_not_found deterministically.
  let releaseSwitch;
  const switchGate = new Promise((resolve) => {
    releaseSwitch = resolve;
  });
  await student.routeWebSocket(/\/ws\//, (socket) => {
    const server = socket.connectToServer();
    socket.onMessage(async (message) => {
      if (String(message).includes('"workspace_switch"')) await switchGate;
      server.send(message);
    });
    server.onMessage((message) => socket.send(message));
  });

  await login(teacher, { name: 'Учитель', role: 'teacher', room });
  await login(student, { name: 'Ученик', role: 'student', room });

  await createPage(teacher, 'Вторая');
  await expect.poll(() => pageNames(student)).toEqual(['Страница 1', 'Вторая']);

  await selectPage(student, 'Вторая');
  await deletePage(teacher, 'Вторая');
  await expect.poll(() => pageNames(student)).toEqual(['Страница 1']);
  expect(await activePageName(student)).toBe('Страница 1');

  releaseSwitch();
  await expect(student.locator('#status')).toHaveText('Подключено');

  // The board must accept input again: a student rectangle reaches the teacher.
  await drawRect(student, { x: 260, y: 260 }, { x: 380, y: 340 });
  await expect.poll(() => objectCount(teacher), { timeout: 10_000 }).toBe(1);

  await teacherContext.close();
  await studentContext.close();
});
