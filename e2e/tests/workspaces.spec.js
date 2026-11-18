import { expect, test } from '@playwright/test';

import {
  activePageName,
  createPage,
  deletePage,
  drawRect,
  grantAccess,
  lessonSetup,
  makeActiveStudent,
  movePage,
  objectCount,
  openLesson,
  openRoom,
  pageNames,
  pullAll,
  pullSelected,
  reloadAndWait,
  renamePage,
  selectPage,
  selectStudent,
  signInWith,
  uniqueLogin,
  worldToScreen,
} from '../helpers.js';

test('workspaces: create, isolate, switch, rename, reorder, reload', async ({
  browser,
  request,
}) => {
  const setup = await lessonSetup(request, { name: 'Pages' });
  const { teacherContext, studentContext, teacher, student } = await openLesson(
    request,
    browser,
    setup,
  );

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

test('workspaces: socket reconnect keeps the current page', async ({ browser, request }) => {
  const setup = await lessonSetup(request, { name: 'Pages reconnect' });
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

  await signInWith(request, teacher, setup.teacherLogin);
  await openRoom(teacher, setup.room.id);
  await signInWith(request, student, setup.studentLogin);
  await openRoom(student, setup.room.id);

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

test('workspaces: switching to a deleted page recovers the board', async ({
  browser,
  request,
}) => {
  const setup = await lessonSetup(request, { name: 'Pages abort' });
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

  await signInWith(request, teacher, setup.teacherLogin);
  await openRoom(teacher, setup.room.id);
  await signInWith(request, student, setup.studentLogin);
  await openRoom(student, setup.room.id);

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

test('workspaces: deleting a non-empty page discards objects and moves viewers', async ({
  browser,
  request,
}) => {
  const setup = await lessonSetup(request, { name: 'Pages delete' });
  const { teacherContext, studentContext, teacher, student } = await openLesson(
    request,
    browser,
    setup,
  );

  await createPage(teacher, 'Вторая');
  await expect.poll(() => pageNames(student)).toEqual(['Страница 1', 'Вторая']);
  await selectPage(student, 'Вторая');
  await expect.poll(() => activePageName(student)).toBe('Вторая');

  await drawRect(teacher, { x: 300, y: 300 }, { x: 420, y: 390 });
  await expect.poll(() => objectCount(student)).toBe(1);

  let prompt = '';
  teacher.once('dialog', async (dialog) => {
    prompt = dialog.message();
    await dialog.accept();
  });
  await teacher.locator('#pages-panel .page', { hasText: 'Вторая' }).locator('.page__delete').click();

  // Objects of the page are gone for good and every viewer lands on the first
  // remaining page.
  await expect.poll(() => pageNames(student)).toEqual(['Страница 1']);
  await expect.poll(() => activePageName(student)).toBe('Страница 1');
  await expect.poll(() => objectCount(student)).toBe(0);
  await expect.poll(() => activePageName(teacher)).toBe('Страница 1');
  expect(await objectCount(teacher)).toBe(0);
  expect(prompt).toContain('Вторая');
  expect(prompt).toContain('безвозвратно');

  // The only page left cannot be deleted: its × control is disabled.
  await expect(teacher.locator('#pages-panel .page__delete')).toBeDisabled();

  await teacherContext.close();
  await studentContext.close();
});

test('pull one and all students to the teacher page', async ({ browser, request }) => {
  const setup = await lessonSetup(request, { name: 'Pull', studentName: 'Первый' });
  const secondLogin = uniqueLogin('student');
  await makeActiveStudent(request, { login: secondLogin, name: 'Второй' });
  await grantAccess(request, setup.room.id, setup.teacherLogin, secondLogin);

  const teacherContext = await browser.newContext();
  const studentContext = await browser.newContext();
  const secondContext = await browser.newContext();
  const teacher = await teacherContext.newPage();
  const student = await studentContext.newPage();
  const second = await secondContext.newPage();

  await signInWith(request, teacher, setup.teacherLogin);
  await openRoom(teacher, setup.room.id);
  await signInWith(request, student, setup.studentLogin);
  await openRoom(student, setup.room.id);
  await signInWith(request, second, secondLogin);
  await openRoom(second, setup.room.id);

  await createPage(teacher, 'Вторая');
  await selectStudent(teacher, 'Первый');
  await pullSelected(teacher);
  await expect.poll(() => activePageName(student)).toBe('Вторая');
  expect(await activePageName(second)).toBe('Страница 1');

  await pullAll(teacher);
  await expect.poll(() => activePageName(second)).toBe('Вторая');
  await expect.poll(() => activePageName(teacher)).toBe('Вторая');

  await teacherContext.close();
  await studentContext.close();
  await secondContext.close();
});

test('pull preserves a text draft on the old page', async ({ browser, request }) => {
  const setup = await lessonSetup(request, { name: 'Draft' });
  const { teacherContext, studentContext, teacher, student } = await openLesson(
    request,
    browser,
    setup,
  );

  await createPage(teacher, 'Вторая');
  await student.click('[data-tool="text"]');
  const point = await worldToScreen(student, { x: 500, y: 400 });
  await student.mouse.click(point.x, point.y);
  await student.fill('#text-editor', 'Черновик');
  await expect(student.locator('#text-editor')).toBeVisible();

  await pullAll(teacher);
  await expect.poll(() => activePageName(student)).toBe('Вторая');
  await expect(student.locator('#text-editor')).toBeHidden();

  await selectPage(teacher, 'Страница 1');
  await expect
    .poll(() =>
      teacher.evaluate(() =>
        window.Konva.stages[0]
          .getLayers()[1]
          .getChildren((node) => Boolean(node.id()))
          .some((node) => node.findOne('Text')?.text() === 'Черновик'),
      ),
    )
    .toBe(true);

  await teacherContext.close();
  await studentContext.close();
});

test('undo works after leaving and returning to a page', async ({ page, request }) => {
  const setup = await lessonSetup(request, { name: 'Undo across pages', student: false });
  await signInWith(request, page, setup.teacherLogin);
  await openRoom(page, setup.room.id);

  await drawRect(page, { x: 300, y: 300 }, { x: 420, y: 390 });
  await expect.poll(() => objectCount(page)).toBe(1);

  await createPage(page, 'Вторая');
  await drawRect(page, { x: 500, y: 300 }, { x: 620, y: 390 });
  await expect.poll(() => objectCount(page)).toBe(1);

  await selectPage(page, 'Страница 1');
  await expect.poll(() => objectCount(page)).toBe(1);
  await page.click('#undo-btn');
  await expect.poll(() => objectCount(page)).toBe(0);

  await selectPage(page, 'Вторая');
  await expect.poll(() => objectCount(page)).toBe(1);
  await page.click('#undo-btn');
  await expect.poll(() => objectCount(page)).toBe(0);
});
