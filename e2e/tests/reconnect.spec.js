import { expect, test } from '@playwright/test';

import {
  drawRect,
  makeActiveStudent,
  makeRoomWithAccess,
  makeTeacher,
  objectCount,
  openRoom,
  reloadAndWait,
  signInWith,
  uniqueLogin,
  waitForObjectCount,
} from '../helpers.js';

test('reconnect: reload restores the session and the socket keeps syncing', async ({
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
    name: 'Reconnect',
  });

  const teacherContext = await browser.newContext();
  const studentContext = await browser.newContext();
  const teacher = await teacherContext.newPage();
  const student = await studentContext.newPage();

  await signInWith(request, teacher, teacherLogin);
  await openRoom(teacher, room.id);
  await signInWith(request, student, studentLogin);
  await openRoom(student, room.id);

  await drawRect(teacher, { x: 200, y: 200 }, { x: 340, y: 300 });
  await waitForObjectCount(student, 1);

  // A reload reconnects with the cookie session and restores the room.
  await reloadAndWait(teacher);
  await waitForObjectCount(teacher, 1, 15_000);
  expect(await objectCount(teacher)).toBe(1);

  // The new WebSocket continues to work in both directions.
  await drawRect(teacher, { x: 600, y: 300 }, { x: 760, y: 420 });
  await waitForObjectCount(student, 2);

  await teacherContext.close();
  await studentContext.close();
});
