import { test } from '@playwright/test';
import { createPage, deletePage, drawRect, login, pageNames, selectPage, uniqueRoom } from '../helpers.js';

test('debug listening', async ({ browser }) => {
  const room = uniqueRoom('ws-debug');
  const tc = await browser.newContext();
  const sc = await browser.newContext();
  const teacher = await tc.newPage();
  const student = await sc.newPage();
  let release;
  const gate = new Promise((r) => { release = r; });
  await student.routeWebSocket(/\/ws\//, (socket) => {
    const server = socket.connectToServer();
    socket.onMessage(async (m) => {
      if (String(m).includes('"workspace_switch"')) { console.log('HOLD switch'); await gate; console.log('RELEASE switch'); }
      server.send(m);
    });
    server.onMessage((m) => socket.send(m));
  });
  await login(teacher, { name: 'У', role: 'teacher', room });
  await login(student, { name: 'С', role: 'student', room });
  await createPage(teacher, 'Вторая');
  await pageNames(student);
  await selectPage(student, 'Вторая');
  console.log('listening after switch', await student.evaluate(() => window.Konva.stages[0].listening()));
  await deletePage(teacher, 'Вторая');
  await pageNames(student);
  console.log('listening after delete', await student.evaluate(() => window.Konva.stages[0].listening()));
  release();
  await student.waitForTimeout(800);
  console.log('listening after error', await student.evaluate(() => window.Konva.stages[0].listening()));
  console.log('active', await student.locator('#pages-panel .page.is-active .page__name').textContent());
  await drawRect(student, { x: 260, y: 260 }, { x: 380, y: 340 });
  await student.waitForTimeout(800);
  console.log('teacher objects', await teacher.locator('canvas').count());
  await tc.close();
  await sc.close();
});
