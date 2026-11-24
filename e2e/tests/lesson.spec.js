import { expect, test } from '@playwright/test';

import {
  clickWorld,
  collectErrors,
  dblclickWorld,
  dragBy,
  drawRect,
  firstObjectId,
  hasText,
  makeActiveStudent,
  makeRoomWithAccess,
  makeTeacher,
  moveWorld,
  openRoom,
  reloadAndWait,
  selectObject,
  signInWith,
  transformerAnchor,
  uniqueLogin,
  waitForObjectCount,
  waitForSelectedSize,
} from '../helpers.js';

test('main lesson: drawing, cursor, transforms, text editing, reload', async ({
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
    name: 'Урок',
  });

  const teacherContext = await browser.newContext();
  const studentContext = await browser.newContext();
  const teacher = await teacherContext.newPage();
  const student = await studentContext.newPage();
  const errors = [...collectErrors(teacher, 'teacher'), ...collectErrors(student, 'student')];

  await signInWith(request, teacher, teacherLogin);
  await openRoom(teacher, room.id);
  await signInWith(request, student, studentLogin);
  await openRoom(student, room.id);

  // Drawing is broadcast to the other participant.
  await drawRect(teacher, { x: 300, y: 300 }, { x: 450, y: 400 });
  await waitForObjectCount(student, 1);
  const objectId = await firstObjectId(student);
  expect(objectId).toBeTruthy();

  // Cursor presence is rendered in the overlay layer.
  await moveWorld(teacher, { x: 700, y: 420 }, 10);
  await student.waitForFunction(
    () => window.Konva.stages[0].getLayers()[2].getChildren().length > 0,
  );

  // Resize through the Transformer; the student sees the new dimensions.
  await selectObject(teacher, { x: 375, y: 350 });
  const bottomRight = await transformerAnchor(teacher, 'bottom-right');
  await dragBy(teacher, bottomRight, 80, 60);
  await waitForSelectedSize(teacher, 160);
  await student.waitForFunction(
    (id) => {
      const layer = window.Konva.stages[0].getLayers()[1];
      const node = layer.getChildren((child) => child.id() === id)[0];
      const shape = node?.getChildren()[0];
      return Boolean(shape && shape.width() > 150);
    },
    objectId,
  );

  // Rotation is synced as well.
  const rotater = await transformerAnchor(teacher, 'rotater');
  await dragBy(teacher, rotater, 100, 60);
  await student.waitForFunction(
    (id) => {
      const layer = window.Konva.stages[0].getLayers()[1];
      const node = layer.getChildren((child) => child.id() === id)[0];
      return Boolean(node && Math.abs(node.rotation()) > 5);
    },
    objectId,
  );

  // Text creation and editing via double click.
  await teacher.click('[data-tool="text"]');
  await clickWorld(teacher, { x: 600, y: 500 });
  await expect(teacher.locator('#text-editor')).toBeVisible();
  await teacher.fill('#text-editor', 'Первый вариант');
  await teacher.press('#text-editor', 'Control+Enter');
  await waitForObjectCount(student, 2);
  await hasText(student, 'Первый вариант');

  await selectObject(teacher, { x: 620, y: 515 });
  await dblclickWorld(teacher, { x: 620, y: 515 });
  await expect(teacher.locator('#text-editor')).toBeVisible();
  await teacher.fill('#text-editor', 'Обновлённый текст');
  await teacher.press('#text-editor', 'Control+Enter');
  await hasText(student, 'Обновлённый текст');

  // Reload keeps the session, room and board (cookie + snapshot restore).
  await reloadAndWait(student);
  await waitForObjectCount(student, 2, 15_000);
  await hasText(student, 'Обновлённый текст');

  expect(errors).toEqual([]);

  await student.click('#leave-btn');
  await expect(student.locator('#dashboard')).toBeVisible();
  await expect(student.locator('#app')).toBeHidden();

  await teacherContext.close();
  await studentContext.close();
});
