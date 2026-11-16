import { expect } from '@playwright/test';

export const ADMIN_LOGIN = process.env.ADMIN_LOGIN || 'e2e-admin';
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'e2e-admin-pass';
export const DEFAULT_PASSWORD = 'secret-1';

export function uniqueLogin(prefix = 'user') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

export async function registerUser(request, { login, name, password = DEFAULT_PASSWORD }) {
  const response = await request.post('/api/register', {
    data: { login, name, password },
  });
  expect(response.status()).toBe(201);
}

export async function apiLogin(request, login, password = DEFAULT_PASSWORD) {
  const response = await request.post('/api/login', {
    data: { login, password },
  });
  expect(response.ok()).toBeTruthy();
  return response;
}

export async function adminLogin(request) {
  return apiLogin(request, ADMIN_LOGIN, ADMIN_PASSWORD);
}

export async function findAdminUser(request, login) {
  await adminLogin(request);
  const response = await request.get(`/api/admin/users?q=${encodeURIComponent(login)}`);
  expect(response.ok()).toBeTruthy();
  const users = await response.json();
  return users.find((item) => item.login === login);
}

export async function approveUser(request, login, { role } = {}) {
  const user = await findAdminUser(request, login);
  if (!user) throw new Error(`user ${login} was not found`);
  const patch = { status: 'active' };
  if (role) patch.role = role;
  const response = await request.patch(`/api/admin/users/${user.id}`, { data: patch });
  expect(response.ok()).toBeTruthy();
}

export async function makeActiveStudent(request, { login, name }) {
  await registerUser(request, { login, name });
  await approveUser(request, login);
}

export async function makeTeacher(request, { login, name }) {
  await registerUser(request, { login, name });
  await approveUser(request, login, { role: 'teacher' });
}

export async function signInWith(request, page, login, password = DEFAULT_PASSWORD) {
  await apiLogin(request, login, password);
  const state = await request.storageState();
  await page.context().addCookies(state.cookies);
}

export function uniqueRoom(prefix = 'e2e') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export async function login(page, { name, role = 'student', room }) {
  await page.goto(`/?room=${encodeURIComponent(room)}`);
  await page.fill('input[name="name"]', name);
  if (role === 'teacher') {
    await page.selectOption('select[name="role"]', 'teacher');
    await page.fill('input[name="code"]', TEACHER_CODE);
  }
  await page.click('#login-submit');
  await expect(page.locator('#status')).toHaveText('Подключено', { timeout: 15_000 });
  await expect(page.locator('#app')).toBeVisible();
}

export async function boardBox(page) {
  const box = await page.locator('#board').boundingBox();
  if (!box) throw new Error('board is not visible');
  return box;
}

export async function stageView(page) {
  return page.evaluate(() => {
    const stage = window.Konva.stages[0];
    return {
      x: stage.x(),
      y: stage.y(),
      scaleX: stage.scaleX(),
      scaleY: stage.scaleY(),
    };
  });
}

/** World coordinates (logical 1600×900 board) → page coordinates. */
export async function worldToScreen(page, point) {
  const box = await boardBox(page);
  const view = await stageView(page);
  return {
    x: box.x + view.x + point.x * view.scaleX,
    y: box.y + view.y + point.y * view.scaleY,
  };
}

export async function clickWorld(page, point) {
  const target = await worldToScreen(page, point);
  await page.mouse.click(target.x, target.y);
}

export async function dblclickWorld(page, point) {
  const target = await worldToScreen(page, point);
  await page.mouse.dblclick(target.x, target.y);
}

export async function moveWorld(page, point, steps = 6) {
  const target = await worldToScreen(page, point);
  await page.mouse.move(target.x, target.y, { steps });
}

export async function drawRect(page, from, to) {
  await page.click('[data-tool="rect"]');
  const start = await worldToScreen(page, from);
  const end = await worldToScreen(page, to);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 8 });
  await page.mouse.up();
}

export async function objectCount(page) {
  return page.evaluate(
    () =>
      window.Konva.stages[0]
        .getLayers()[1]
        .getChildren((node) => Boolean(node.id())).length,
  );
}

export async function waitForObjectCount(page, count, timeout = 10_000) {
  await page.waitForFunction(
    (expected) =>
      window.Konva.stages[0]
        .getLayers()[1]
        .getChildren((node) => Boolean(node.id())).length === expected,
    count,
    { timeout },
  );
}

export async function firstObjectId(page) {
  return page.evaluate(
    () =>
      window.Konva.stages[0]
        .getLayers()[1]
        .getChildren((node) => Boolean(node.id()))[0]?.id() ?? null,
  );
}

export async function selectObject(page, point) {
  await page.click('[data-tool="select"]');
  await clickWorld(page, point);
}

/**
 * Anchor position of the Transformer for the selected node.
 * Targets the actual Konva anchor node so the centre lands on its hit area
 * regardless of the board's scale (anchors keep a fixed on-screen size).
 */
export async function transformerAnchor(page, position = 'bottom-right') {
  const rect = await page.evaluate((pos) => {
    const transformer = window.Konva.stages[0].findOne('Transformer');
    const selector = pos === 'rotater' ? '.rotater' : '.bottom-right';
    const anchor = transformer?.findOne(selector);
    if (!anchor) return null;
    const clientRect = anchor.getClientRect();
    return {
      x: clientRect.x + clientRect.width / 2,
      y: clientRect.y + clientRect.height / 2,
    };
  }, position);
  if (!rect) throw new Error('nothing is selected in the Transformer');
  const box = await boardBox(page);
  return { x: box.x + rect.x, y: box.y + rect.y };
}

export async function dragBy(page, start, dx, dy) {
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + dx, start.y + dy, { steps: 12 });
  await page.mouse.up();
}

export async function waitForSelectedSize(page, minWidth, timeout = 10_000) {
  await page.waitForFunction(
    (width) => {
      const transformer = window.Konva.stages[0].findOne('Transformer');
      const node = transformer?.nodes()[0];
      const child = node?.getChildren()[0];
      return Boolean(child && child.width() >= width);
    },
    minWidth,
    { timeout },
  );
}

export async function selectedShape(page) {
  return page.evaluate(() => {
    const transformer = window.Konva.stages[0].findOne('Transformer');
    const node = transformer?.nodes()[0];
    const child = node?.getChildren()[0];
    return {
      rotation: node?.rotation() ?? 0,
      width: child?.width?.() ?? 0,
      height: child?.height?.() ?? 0,
      text: node?.findOne('Text')?.text() ?? null,
    };
  });
}

export async function hasText(page, value, timeout = 10_000) {
  await page.waitForFunction(
    (expected) =>
      window.Konva.stages[0]
        .getLayers()[1]
        .getChildren((node) => Boolean(node.id()))
        .some((node) => node.findOne('Text')?.text() === expected),
    value,
    { timeout },
  );
}

export async function reloadAndWait(page) {
  await page.reload();
  await expect(page.locator('#status')).toHaveText('Подключено', { timeout: 15_000 });
  await expect(page.locator('#app')).toBeVisible();
}

export async function pageNames(page) {
  return page.locator('#pages-panel .page__name').allTextContents();
}

export async function activePageName(page) {
  return page.locator('#pages-panel .page.is-active .page__name').textContent();
}

export async function selectPage(page, name) {
  await page.locator('#pages-panel .page', { hasText: name }).locator('.page__select').click();
}

export async function createPage(page, name) {
  page.once('dialog', async (dialog) => {
    await dialog.accept(name);
  });
  await page.click('#page-add');
}

export async function renamePage(page, oldName, newName) {
  page.once('dialog', async (dialog) => {
    await dialog.accept(newName);
  });
  await page.locator('#pages-panel .page', { hasText: oldName }).locator('.page__rename').click();
}

export async function deletePage(page, name) {
  page.once('dialog', async (dialog) => {
    await dialog.accept();
  });
  await page.locator('#pages-panel .page', { hasText: name }).locator('.page__delete').click();
}

export async function selectStudent(page, name) {
  await page
    .locator('#user-list .user', { hasText: name })
    .locator('.user__pull-check')
    .check();
}

export async function pullSelected(page) {
  await page.click('#pull-selected');
}

export async function pullAll(page) {
  await page.click('#pull-all');
}

export async function movePage(page, name, direction) {
  const selector = direction === 'up' ? '.page__up' : '.page__down';
  await page.locator('#pages-panel .page', { hasText: name }).locator(selector).click();
}

export function collectErrors(page, label = 'page') {
  const errors = [];
  page.on('pageerror', (error) => errors.push(`${label}: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`${label}: ${message.text()}`);
  });
  return errors;
}
