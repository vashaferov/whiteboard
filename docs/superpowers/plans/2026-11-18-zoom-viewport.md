# Локальный масштаб доски: план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Добавить локальный зум 50–400% и панорамирование доски: кнопки, колесо, жесты двумя пальцами; вид не влияет на других участников.

**Architecture:** `Board` хранит `fitScale`, `zoom` и `pan`, применяет их к stage и продолжает отдавать мировые координаты через `getRelativePointerPosition()`/`toScreen()`. UI-блок в `#board` вызывает методы доски; жесты обрабатываются на контейнере доски и не конфликтуют с рисованием.

**Tech Stack:** Konva.js, ванильный JS, CSS, Playwright (CDP для мультитача).

**Spec:** `docs/superpowers/specs/2026-11-18-zoom-viewport-design.md`

## Global Constraints

- Диапазон зума: 50–400% от «вписать» (`zoom` 0.5–4.0), шаг кнопок 1.25.
- Вид локальный: сервер, протокол и данные не меняются.
- Новых зависимостей нет; координаты объектов остаются мировыми.
- Русские подписи и существующий стиль кода.
- Холст нельзя утащить: минимум 25% окна по каждой оси остаётся занято доской.
- При `zoom ≤ 1` панорама принудительно сбрасывается, холст центрируется.
- Backend-тесты из `backend`: `..\.venv\Scripts\python.exe -m pytest -q -p no:warnings`.
- E2E из `e2e`: `$env:PYTHON='D:\Dev\whiteboard\.venv\Scripts\python.exe'; npx.cmd playwright test`.

## Review Focus

- Рисование и ластик после зума/панорамы попадают в правильные мировые координаты.
- Второй палец во время штриха не оставляет «мусорных» объектов и не рвёт уже нарисованное.
- Смена размера окна/ориентации при увеличенном масштабе сохраняет зум и не теряет холст.
- `Ctrl+колесо` над доской не масштабирует страницу браузера; экспорт PDF при увеличенном виде не меняет результат и возвращает вид.
- Ученик на презентации может приблизить слайд, но по-прежнему не может рисовать или листать.

---

## Структура файлов

- `frontend/js/board.js` — состояние вида, зум/пан, кламп, колесо, жесты, восстановление вида после экспорта.
- `frontend/js/tools.js` — пауза старта штриха на касании и отмена штриха при pinch.
- `frontend/js/main.js` — разметка кнопок, обработчики, `onViewChange`/`onGestureStart`, клавиши.
- `frontend/index.html` — блок `#zoom-controls` внутри `#board`.
- `frontend/css/style.css` — стиль блока зума.
- `e2e/tests/zoom.spec.js` — новые сценарии зума.
- `e2e/tests/presentations.spec.js` — зум ученика на презентации.
- `README.md`, `plan.md` — документация.

---

### Task 1: Состояние вида, API зума и кнопки

**Files:**
- Modify: `frontend/js/board.js`
- Modify: `frontend/index.html`
- Modify: `frontend/css/style.css`
- Modify: `frontend/js/main.js`
- Test: `e2e/tests/zoom.spec.js` (create)

**Interfaces:**
- Produces:
  - `Board` option `onViewChange(percent: number)`
  - `Board.layout()`, `Board.resetView()`, `Board.setZoom(zoom, anchor?)`, `Board.zoomAt(factor, anchor?)`, `Board.panBy(dx, dy)`, `Board.getZoomPercent()`
  - `anchor` — `{x, y}` в координатах контейнера доски.
  - DOM: `#zoom-controls`, `#zoom-out`, `#zoom-reset`, `#zoom-in`.

- [ ] **Step 1: Написать падающие E2E**

Создать `e2e/tests/zoom.spec.js`:

```js
import { expect, test } from '@playwright/test';

import {
  lessonSetup,
  objectCount,
  openRoom,
  signInWith,
  stageView,
  worldToScreen,
} from '../helpers.js';

async function openTeacherRoom(page, request) {
  const setup = await lessonSetup(request, { student: false });
  await signInWith(request, page, setup.teacherLogin);
  await openRoom(page, setup.room.id);
}

test('zoom controls change the view and reset to fit', async ({ page, request }) => {
  await openTeacherRoom(page, request);
  await expect(page.locator('#zoom-reset')).toHaveText('100%');
  const fit = await stageView(page);

  await page.click('#zoom-in');
  await expect(page.locator('#zoom-reset')).toHaveText('125%');
  const zoomed = await stageView(page);
  expect(zoomed.scaleX / fit.scaleX).toBeCloseTo(1.25, 2);

  await page.click('#zoom-reset');
  await expect(page.locator('#zoom-reset')).toHaveText('100%');
  expect((await stageView(page)).scaleX).toBeCloseTo(fit.scaleX, 3);

  while (!(await page.locator('#zoom-out').isDisabled())) await page.click('#zoom-out');
  await expect(page.locator('#zoom-reset')).toHaveText('50%');

  while (!(await page.locator('#zoom-in').isDisabled())) await page.click('#zoom-in');
  await expect(page.locator('#zoom-reset')).toHaveText('400%');
});

test('drawing after zoom uses world coordinates', async ({ page, request }) => {
  await openTeacherRoom(page, request);
  await page.click('#zoom-in');
  await page.click('#zoom-in');
  await expect(page.locator('#zoom-reset')).toHaveText('156%');

  const target = { x: 400, y: 300 };
  const screen = await worldToScreen(page, target);
  await page.click('[data-tool="brush"]');
  await page.mouse.move(screen.x, screen.y);
  await page.mouse.down();
  await page.mouse.move(screen.x + 60, screen.y + 40, { steps: 6 });
  await page.mouse.up();
  await expect.poll(() => objectCount(page)).toBe(1);

  const first = await page.evaluate(() => {
    const layer = window.Konva.stages[0].getLayers()[1];
    const node = layer.getChildren((item) => item.className === 'Line' && item.id())[0];
    return node ? node.points().slice(0, 2) : null;
  });
  expect(Math.abs(first[0] - target.x)).toBeLessThan(2);
  expect(Math.abs(first[1] - target.y)).toBeLessThan(2);
});

test('resizing keeps the zoom', async ({ page, request }) => {
  await openTeacherRoom(page, request);
  await page.click('#zoom-in');
  await page.click('#zoom-in');
  await expect(page.locator('#zoom-reset')).toHaveText('156%');
  const before = await stageView(page);

  await page.setViewportSize({ width: 900, height: 600 });
  await expect(page.locator('#zoom-reset')).toHaveText('156%');
  const after = await stageView(page);
  expect(after.scaleX).not.toBeCloseTo(before.scaleX, 3);
});

test('export keeps the current zoom', async ({ page, request }) => {
  await openTeacherRoom(page, request);
  await page.click('#zoom-in');
  await expect(page.locator('#zoom-reset')).toHaveText('125%');
  const before = await stageView(page);

  const download = page.waitForEvent('download');
  await page.click('#pdf-btn');
  await download;

  await expect(page.locator('#zoom-reset')).toHaveText('125%');
  const after = await stageView(page);
  expect(after.scaleX).toBeCloseTo(before.scaleX, 3);
  expect(after.x).toBeCloseTo(before.x, 1);
  expect(after.y).toBeCloseTo(before.y, 1);
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `npx.cmd playwright test tests/zoom.spec.js --timeout=30000`
Expected: FAIL — нет `#zoom-reset`, вид не меняется.

- [ ] **Step 3: Реализовать состояние вида в `Board`**

В `board.js` рядом с `MIN_SCALE` добавить:

```js
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 4;
const ZOOM_STEP = 1.25;
const PAN_KEEP_RATIO = 0.25;
```

В конструкторе после `this.slideToken = 0;`:

```js
this.fitScale = 1;
this.zoom = 1;
this.panX = 0;
this.panY = 0;
this.onViewChange = options.onViewChange ?? (() => {});
```

Заменить `fit()` на:

```js
fit() {
  this.resetView();
}

resetView() {
  this.zoom = 1;
  this.panX = 0;
  this.panY = 0;
  this.layout();
}

layout() {
  if (this.destroyed) return;
  const containerWidth = Math.max(1, this.container.clientWidth);
  const containerHeight = Math.max(1, this.container.clientHeight);
  this.fitScale = Math.max(
    MIN_SCALE,
    Math.min(containerWidth / this.width, containerHeight / this.height),
  );
  this._clampView(containerWidth, containerHeight);
  this._applyView(containerWidth, containerHeight);
}

_applyView(containerWidth, containerHeight) {
  const scale = this.fitScale * this.zoom;
  this.scale = scale;
  this.offsetX = (containerWidth - this.width * scale) / 2 + this.panX;
  this.offsetY = (containerHeight - this.height * scale) / 2 + this.panY;
  this.stage.size({ width: containerWidth, height: containerHeight });
  this.stage.scale({ x: scale, y: scale });
  this.stage.position({ x: this.offsetX, y: this.offsetY });
  this.stage.batchDraw();
  this.onViewChange(this.getZoomPercent());
}

_clampView(containerWidth, containerHeight) {
  if (this.zoom <= 1) {
    this.panX = 0;
    this.panY = 0;
    return;
  }
  const scale = this.fitScale * this.zoom;
  const boardWidth = this.width * scale;
  const boardHeight = this.height * scale;
  const baseX = (containerWidth - boardWidth) / 2;
  const baseY = (containerHeight - boardHeight) / 2;
  this.panX = clamp(
    this.panX,
    PAN_KEEP_RATIO * containerWidth - baseX - boardWidth,
    (1 - PAN_KEEP_RATIO) * containerWidth - baseX,
  );
  this.panY = clamp(
    this.panY,
    PAN_KEEP_RATIO * containerHeight - baseY - boardHeight,
    (1 - PAN_KEEP_RATIO) * containerHeight - baseY,
  );
}

getZoomPercent() {
  return Math.round(this.zoom * 100);
}

setZoom(zoom, anchor = null) {
  const next = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
  if (next === this.zoom) return;
  const containerWidth = Math.max(1, this.container.clientWidth);
  const containerHeight = Math.max(1, this.container.clientHeight);
  const world = anchor
    ? {
        x: (anchor.x - this.offsetX) / this.scale,
        y: (anchor.y - this.offsetY) / this.scale,
      }
    : null;
  this.zoom = next;
  if (world) {
    const scale = this.fitScale * next;
    this.panX = anchor.x - world.x * scale - (containerWidth - this.width * scale) / 2;
    this.panY = anchor.y - world.y * scale - (containerHeight - this.height * scale) / 2;
  }
  this._clampView(containerWidth, containerHeight);
  this._applyView(containerWidth, containerHeight);
}

zoomAt(factor, anchor = null) {
  this.setZoom(this.zoom * factor, anchor);
}

panBy(dx, dy) {
  if (this.zoom <= 1) return;
  const containerWidth = Math.max(1, this.container.clientWidth);
  const containerHeight = Math.max(1, this.container.clientHeight);
  this.panX += dx;
  this.panY += dy;
  this._clampView(containerWidth, containerHeight);
  this._applyView(containerWidth, containerHeight);
}
```

- В `ResizeObserver` и `window.resize` вызывать `this.layout()` вместо `this.fit()`.
- В `exportCanvas()` в `finally` заменить `this.fit()` на восстановление сохранённых
  `stage.size/scale/position` и `stage.batchDraw()`.
- `ZOOM_STEP` здесь ещё не используется — он нужен в `main.js` (см. шаг 4).

- [ ] **Step 4: Добавить блок зума и обработчики**

`index.html`, внутрь `<div id="board" class="board">`:

```html
<div id="zoom-controls" class="zoom-controls" role="group" aria-label="Масштаб">
  <button id="zoom-out" class="zoom-controls__button" type="button" aria-label="Отдалить">−</button>
  <button id="zoom-reset" class="zoom-controls__value" type="button" title="Вписать доску">100%</button>
  <button id="zoom-in" class="zoom-controls__button" type="button" aria-label="Приблизить">+</button>
</div>
```

CSS (рядом с `.slide-controls`):

```css
.zoom-controls {
  position: absolute;
  right: 16px;
  bottom: 16px;
  z-index: 15;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 5px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.94);
  box-shadow: 0 6px 18px rgba(15, 23, 42, 0.14);
}

.zoom-controls__button,
.zoom-controls__value {
  border: none;
  border-radius: 50%;
  background: #f1f5f9;
  color: #334155;
  cursor: pointer;
  font: inherit;
}

.zoom-controls__button {
  width: 30px;
  height: 30px;
  font-size: 18px;
  line-height: 1;
}

.zoom-controls__value {
  min-width: 52px;
  height: 30px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
}

.zoom-controls__button:hover:not(:disabled),
.zoom-controls__value:hover {
  background: var(--accent);
  color: #fff;
}

.zoom-controls__button:disabled {
  opacity: 0.35;
  cursor: default;
}
```

`main.js`:
- в `cacheElements()` добавить `els.zoomOut/zoomIn/zoomReset`.
- передать в `new Board(...)` опцию `onViewChange: (percent) => updateZoomControls(percent)`.
- добавить:

```js
function updateZoomControls(percent = 100) {
  if (!els.zoomReset) return;
  els.zoomReset.textContent = `${percent}%`;
  els.zoomOut.disabled = percent <= 50;
  els.zoomIn.disabled = percent >= 400;
}

function zoomBy(direction) {
  const center = { x: els.board.clientWidth / 2, y: els.board.clientHeight / 2 };
  state.board?.zoomAt(direction > 0 ? 1.25 : 1 / 1.25, center);
}
```

- в `bindToolbar()` добавить обработчики кликов `#zoom-out`, `#zoom-in`,
  `#zoom-reset` (`resetView`).
- `updateZoomControls()` не вызывать в `applyWorkspaceMode`: блок зума доступен всегда.

- [ ] **Step 5: Прогнать тесты**

Run: `npx.cmd playwright test tests/zoom.spec.js --timeout=30000`
Expected: `4 passed`.

- [ ] **Step 6: Коммит**

```bash
git add frontend/js/board.js frontend/index.html frontend/css/style.css frontend/js/main.js e2e/tests/zoom.spec.js
git commit -m "feat: add local board zoom controls"
```

---

### Task 2: Колесо и жесты двумя пальцами

**Files:**
- Modify: `frontend/js/board.js`
- Modify: `frontend/js/tools.js`
- Modify: `frontend/js/main.js`
- Test: `e2e/tests/zoom.spec.js`

**Interfaces:**
- Consumes: Task 1 `zoomAt`, `panBy`, `layout`, `getZoomPercent`.
- Produces:
  - `Board` options `onGestureStart()`
  - `Board.isGesturing(): boolean`
  - `ToolManager.cancelOrFinishStroke()`, `ToolManager` учитывает `pendingTouch`.

- [ ] **Step 1: Написать падающие E2E**

Добавить в `zoom.spec.js`:

```js
async function worldUnderPagePoint(page, point) {
  return page.evaluate(({ pageX, pageY }) => {
    const stage = window.Konva.stages[0];
    const box = document.querySelector('#board').getBoundingClientRect();
    return {
      x: (pageX - box.x - stage.x()) / stage.scaleX(),
      y: (pageY - box.y - stage.y()) / stage.scaleY(),
    };
  }, point);
}

test('ctrl+wheel zooms around the cursor', async ({ page, request }) => {
  await openTeacherRoom(page, request);
  const box = await page.locator('#board').boundingBox();
  const point = { pageX: box.x + box.width * 0.4, pageY: box.y + box.height * 0.4 };
  const before = await worldUnderPagePoint(page, point);

  await page.evaluate(({ pageX, pageY }) => {
    document.querySelector('#board').dispatchEvent(
      new WheelEvent('wheel', {
        deltaY: -120,
        ctrlKey: true,
        clientX: pageX,
        clientY: pageY,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, point);

  await expect(page.locator('#zoom-reset')).not.toHaveText('100%');
  const after = await worldUnderPagePoint(page, point);
  expect(Math.abs(after.x - before.x)).toBeLessThan(2);
  expect(Math.abs(after.y - before.y)).toBeLessThan(2);
});

test('wheel pans a zoomed board', async ({ page, request }) => {
  await openTeacherRoom(page, request);
  await page.click('#zoom-in');
  await page.click('#zoom-in');
  const before = await stageView(page);

  await page.evaluate(() => {
    document.querySelector('#board').dispatchEvent(
      new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true }),
    );
  });

  const after = await stageView(page);
  expect(after.y).toBeCloseTo(before.y - 120, 0);
  expect(after.x).toBeCloseTo(before.x, 0);
});

test('two fingers pinch, pan and do not leave stray objects', async ({ page, request }) => {
  await openTeacherRoom(page, request);
  const box = await page.locator('#board').boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const client = await page.context().newCDPSession(page);
  await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 });

  await client.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [
      { x: cx - 60, y: cy, id: 1 },
      { x: cx + 60, y: cy, id: 2 },
    ],
  });
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [
      { x: cx - 120, y: cy, id: 1 },
      { x: cx + 120, y: cy, id: 2 },
    ],
  });
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

  await expect(page.locator('#zoom-reset')).toHaveText('200%');
  expect(await objectCount(page)).toBe(0);

  await client.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: cx, y: cy, id: 3 }],
  });
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: cx + 80, y: cy + 40, id: 3 }],
  });
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect.poll(() => objectCount(page)).toBe(1);
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `npx.cmd playwright test tests/zoom.spec.js --timeout=30000`
Expected: новые тесты FAIL — колесо и касания не меняют вид.

- [ ] **Step 3: Реализовать колесо и указатели в `Board`**

В конструктор добавить:

```js
this.pointers = new Map();
this.gesture = null;
this.onGestureStart = options.onGestureStart ?? (() => {});
```

и подписки (после `this.stage.on(...)`):

```js
this._onPointerDown = (event) => this._trackPointerDown(event);
this._onPointerMove = (event) => this._trackPointerMove(event);
this._onPointerUp = (event) => this._trackPointerUp(event);
this._onWheel = (event) => this._handleWheel(event);
this.container.addEventListener('pointerdown', this._onPointerDown);
this.container.addEventListener('pointermove', this._onPointerMove);
this.container.addEventListener('pointerup', this._onPointerUp);
this.container.addEventListener('pointercancel', this._onPointerUp);
this.container.addEventListener('wheel', this._onWheel, { passive: false });
```

Методы:

```js
_pointerPoint(event) {
  const rect = this.container.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

isGesturing() {
  return Boolean(this.gesture);
}

_trackPointerDown(event) {
  if (event.pointerType !== 'touch') return;
  this.pointers.set(event.pointerId, this._pointerPoint(event));
  if (this.pointers.size === 2) this._startGesture();
}

_startGesture() {
  const [first, second] = [...this.pointers.values()];
  const mid = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
  this.gesture = {
    startZoom: this.zoom,
    startDistance: Math.max(1, Math.hypot(first.x - second.x, first.y - second.y)),
    world: {
      x: (mid.x - this.offsetX) / this.scale,
      y: (mid.y - this.offsetY) / this.scale,
    },
  };
  this.onGestureStart();
}

_trackPointerMove(event) {
  if (!this.pointers.has(event.pointerId)) return;
  this.pointers.set(event.pointerId, this._pointerPoint(event));
  if (this.pointers.size < 2 || !this.gesture) return;
  const [first, second] = [...this.pointers.values()];
  const mid = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
  const distance = Math.max(1, Math.hypot(first.x - second.x, first.y - second.y));
  const containerWidth = Math.max(1, this.container.clientWidth);
  const containerHeight = Math.max(1, this.container.clientHeight);
  this.zoom = clamp(
    this.gesture.startZoom * (distance / this.gesture.startDistance),
    MIN_ZOOM,
    MAX_ZOOM,
  );
  const scale = this.fitScale * this.zoom;
  this.panX = mid.x - this.gesture.world.x * scale - (containerWidth - this.width * scale) / 2;
  this.panY =
    mid.y - this.gesture.world.y * scale - (containerHeight - this.height * scale) / 2;
  this._clampView(containerWidth, containerHeight);
  this._applyView(containerWidth, containerHeight);
}

_trackPointerUp(event) {
  this.pointers.delete(event.pointerId);
  if (this.pointers.size < 2) this.gesture = null;
}

_handleWheel(event) {
  event.preventDefault();
  const point = this._pointerPoint(event);
  if (event.ctrlKey || event.metaKey) {
    this.zoomAt(Math.exp(-event.deltaY * 0.0015), point);
    return;
  }
  const dx = event.shiftKey ? -event.deltaY : -event.deltaX;
  const dy = event.shiftKey ? 0 : -event.deltaY;
  this.panBy(dx, dy);
}
```

В `destroy()` снять слушатели `pointerdown/pointermove/pointerup/pointercancel/wheel`.

- [ ] **Step 4: Защитить рисование от второго пальца**

`tools.js`:
- добавить `this.pendingTouch = null;` в конструктор.
- в `_handleDown` первой строкой: `if (this.board.isGesturing?.()) return;`
- для кисти на касании не начинать штрих сразу:

```js
const isTouch = event.evt?.pointerType === 'touch';
if (STROKE_TOOLS.has(this.tool) && isTouch) {
  this.pendingTouch = { point, tool: this.tool, color: this.color, width: this.width };
  return;
}
```

- в `_handleMove` первой строкой `if (this.board.isGesturing?.()) return;`, затем перед работой
  со штрихом:

```js
if (this.pendingTouch && !this.stroke) {
  const { x, y } = this.board.getPointer() ?? this.pendingTouch.point;
  if (Math.hypot(x - this.pendingTouch.point.x, y - this.pendingTouch.point.y) > 2) {
    const start = this.pendingTouch;
    this.pendingTouch = null;
    this._startStroke(start.point);
  }
}
```

- в `_handleUp` очищать `this.pendingTouch = null;`.
- добавить метод:

```js
cancelOrFinishStroke() {
  this.pendingTouch = null;
  this._cancelShape();
  if (!this.stroke) return;
  const stroke = this.stroke;
  if (stroke.points.length > 1) {
    this._finishStroke();
    return;
  }
  this.stroke = null;
  this.board.removeObject(stroke.id);
  this.onEvent({ type: 'object_delete', objectId: stroke.id });
}
```

Поле `strokeId` не нужно: id берётся из `stroke.id` до обнуления.

`main.js` в опции `new Board(...)` добавить:

```js
onGestureStart: () => state.tools?.cancelOrFinishStroke(),
```

- [ ] **Step 5: Прогнать тесты**

Run: `npx.cmd playwright test tests/zoom.spec.js --timeout=30000`
Expected: `7 passed`.

Run: `npx.cmd playwright test tests/mobile.spec.js`
Expected: `1 passed` (рисование одним пальцем не сломалось).

- [ ] **Step 6: Коммит**

```bash
git add frontend/js/board.js frontend/js/tools.js frontend/js/main.js e2e/tests/zoom.spec.js
git commit -m "feat: zoom the board with wheel and pinch"
```

---

### Task 3: Клавиши, презентации и документация

**Files:**
- Modify: `frontend/js/main.js`
- Modify: `e2e/tests/zoom.spec.js`
- Modify: `e2e/tests/presentations.spec.js`
- Modify: `README.md`, `plan.md`

**Interfaces:**
- Consumes: Task 1 `resetView`, `zoomAt`; Task 2 gesture handling.

- [ ] **Step 1: Написать падающие тесты**

В `zoom.spec.js`:

```js
test('keyboard zooms and resets', async ({ page, request }) => {
  await openTeacherRoom(page, request);
  await page.keyboard.press('=');
  await expect(page.locator('#zoom-reset')).toHaveText('125%');
  await page.keyboard.press('-');
  await expect(page.locator('#zoom-reset')).toHaveText('100%');
  await page.keyboard.press('-');
  await expect(page.locator('#zoom-reset')).toHaveText('80%');
  await page.keyboard.press('0');
  await expect(page.locator('#zoom-reset')).toHaveText('100%');
});
```

В `presentations.spec.js` после проверок ученика добавить:

```js
await student.click('#zoom-in');
await expect.poll(() => student.locator('#zoom-reset').textContent()).toBe('125%');
await expect(student.locator('#slide-next')).toBeHidden();
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `npx.cmd playwright test tests/zoom.spec.js tests/presentations.spec.js --timeout=30000`
Expected: FAIL — клавиши не работают; у ученика нет кнопки зума/она не меняет вид.

- [ ] **Step 3: Реализовать клавиши**

В `bindKeyboard()` после блока `isPresentation()` и до `TOOL_KEYS`:

```js
if (['+', '=', '-', '_', '0'].includes(event.key)) {
  event.preventDefault();
  if (!state.board) return;
  if (event.key === '0') {
    state.board.resetView();
    return;
  }
  const center = { x: els.board.clientWidth / 2, y: els.board.clientHeight / 2 };
  state.board.zoomAt(event.key === '-' || event.key === '_' ? 1 / 1.25 : 1.25, center);
  return;
}
```

- [ ] **Step 4: Прогнать тесты**

Run: `npx.cmd playwright test tests/zoom.spec.js tests/presentations.spec.js --timeout=30000`
Expected: `8 passed` и `1 passed` соответственно.

- [ ] **Step 5: Документация**

- `README.md`: в список возможностей добавить пункт про локальный масштаб 50–400%,
  кнопки `− 100% +`, `Ctrl+колесо`, два пальца и то, что вид не влияет на других.
- `plan.md`: раздел `### P10. Локальный масштаб доски ✅` с чекбоксами, строка в журнале,
  пункт 12 в критериях, блок «Проверка масштаба» и актуальные числа тестов
  (backend 213; E2E — по факту прогона, ожидается 48).

- [ ] **Step 6: Полная регрессия**

- `backend`: `..\.venv\Scripts\python.exe -m pytest -q -p no:warnings` → 213 passed.
- `backend`: `ruff check .`, `black --check .` → чисто.
- `e2e`: `npx.cmd playwright test` → все зелёные.
- `docker compose config --quiet` → 0.

- [ ] **Step 7: Коммит**

```bash
git add frontend/js/main.js e2e/tests/zoom.spec.js e2e/tests/presentations.spec.js README.md plan.md
git commit -m "feat: zoom shortcuts and presentation zoom docs"
```

---

## Self-Review

- **Спека:** состояние вида (Task 1), управление кнопками/колесом/жестами (Task 1–2),
  границы и центрирование (Task 1), презентации и клавиши (Task 3), документация (Task 3).
- **Review Focus → тесты:** координаты после зума (Task 1), второй палец и мусорные
  объекты (Task 2), resize (Task 1), `Ctrl+колесо` и экспорт (Task 1–2), ученик на
  презентации (Task 3).
- **Типы:** `zoom/pan/fitScale` согласованы между задачами; `anchor` — координаты
  контейнера; `onViewChange(percent)`, `onGestureStart()`, `cancelOrFinishStroke()`
  используются так, как объявлены.
- **Пропорция:** план задаёт сигнатуры, формулы клампа и тесты; тела методов,
  полностью определённые формулами, приведены только там, где без них есть выбор.
