import { expect, test } from '@playwright/test';

import {
  makeActiveStudent,
  makeRoomWithAccess,
  makeTeacher,
  openRoom,
  signInWith,
  uniqueLogin,
} from '../helpers.js';

test('session: an expired cookie sends the room view back to login', async ({
  browser,
  request,
}) => {
  const teacherLogin = uniqueLogin('teacher');
  const studentLogin = uniqueLogin('student');
  await makeTeacher(request, { login: teacherLogin, name: 'Учитель' });
  await makeActiveStudent(request, { login: studentLogin, name: 'Ученик' });
  const room = await makeRoomWithAccess(request, {
    teacher: teacherLogin,
    student: studentLogin,
    name: 'Session',
  });

  const context = await browser.newContext();
  const page = await context.newPage();
  const sockets = [];
  await page.routeWebSocket(/\/ws\//, (socket) => {
    const server = socket.connectToServer();
    sockets.push(socket);
    socket.onMessage((message) => server.send(message));
    server.onMessage((message) => socket.send(message));
  });

  await signInWith(request, page, studentLogin);
  await openRoom(page, room.id);
  await expect.poll(() => sockets.length).toBeGreaterThan(0);

  await context.clearCookies();
  await sockets.at(-1).close();

  await expect(page.locator('#auth')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#app')).toBeHidden();
  await expect(page.locator('#auth-error')).toContainText('Сессия истекла');

  await context.close();
});
