# Экран комнаты «Студия» — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Перестроить `#app` по макету «Студия»: верхняя панель, сгруппированный док, аккуратные панели страниц и участников, презентационный режим и мобильный док — без изменения Konva, WebSocket, прав и API.

**Architecture:** Новый каркас в `frontend/index.html`, стили в `frontend/css/room.css` (скоуп `#app`), небольшая `frontend/js/room-chrome.js` для поповеров «Стиль»/«Ещё». `pages.js` рендерит новые строки страниц с меню действий; `main.js` сохраняет все обработчики и ID, добавляет роль/контекст, аватары участников и мобильные состояния. Существующие тесты обновляются только там, где действия переехали в меню.

**Tech Stack:** HTML/CSS/vanilla JS, Konva, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-18-room-redesign-design.md`

## Global Constraints

- Не менять `board.js`, `tools.js`, `sync.js`, протокол WS, API и права.
- Сохранить ID: `#app`, `#board`, `#board-stage`, `#tools`, `#colors`, `#width-range`, `#width-value`, `#font-select`, `#undo-btn`, `#lock-btn`, `#image-btn`, `#pdf-btn`, `#clear-btn`, `#board-size-btn`, `#board-size-panel`, `#frame-panel`, `#status`, `#room-title`, `#leave-btn`, `#pages-panel`, `#users-panel`, `#users-resizer`, `#user-list`, `#users-toggle`, `#invisible-toggle`, `#pull-actions`, `#pull-selected`, `#pull-all`, `#slide-controls`, `#slide-prev`, `#slide-next`, `#slide-counter`, `#zoom-controls`, `#file-input`, `#presentation-input`, `#text-editor`.
- Страницы: сохранить `.page-list`, `.page`, `.page.is-active`, `.page__select`, `.page__name`, `#page-add`, `#page-presentation`, `#pages-toggle`, классы `.page__up/down/rename/delete`.
- Участники: сохранить `.user`, `.user__name`, `.user__kick`, `.user__pull-check`, `#user-count`.
- Русские тексты; новые подписи короткие.
- Все новые стили — только `#app ...` в `room.css`.
- Полный E2E-набор должен остаться зелёным.

## Review Focus

- **Konva-геометрия.** Смена ширины сайдбаров/высоты дока не должна сбивать мировые координаты, зум и PDF.
- **Права.** Ученик не видит очистку/PDF/размер холста/управление страницами; учитель и админ — видят.
- **Панели.** Сворачивание страниц/участников не сбрасывает зум; ресайзер участников работает.
- **Страницы.** Меню действий не теряет блокировку busy, порядок, переименование, удаление и презентацию.
- **Мобильный док.** `#tools`, `[data-tool=select/rect/text]` остаются доступны; страницы сворачиваются; горизонтального скролла нет.
- **Презентация.** У учителя только кисть/ластик, у ученика — просмотр; слайды и счётчик не ломаются.

---

### Task 1: Каркас и стили

**Files:**
- Modify: `frontend/index.html` — блок `#app`.
- Create: `frontend/css/room.css`, link after `style.css`.
- Create: `frontend/js/room-chrome.js`; import/init in `main.js`.

- [ ] **Step 1:** Перестроить `#app`: `.room-topbar` (назад, логотип, `#room-title`, `#room-role`, `#room-context`, `#status`, `#pdf-btn`, `#room-more-btn`/`#room-more-menu`, `#leave-btn`), `.room-tools` с доком и группами `#tools`, поповером `#style-popover`, `#frame-panel`; ниже существующий `.workspace`.
- [ ] **Step 2:** Добавить `room.css` с токенами, верхней панелью, доком, панелями, доской, адаптивом; не менять `style.css` комнаты.
- [ ] **Step 3:** `room-chrome.js` — открытие/закрытие `#style-popover` и `#room-more-menu`, авто-открытие стиля для текста, закрытие по клику вне и `Esc`, обновление `aria-expanded`.
- [ ] **Step 4:** `main.js`: закэшировать `#room-role`, `#room-context`, `#style-dot`, `#style-width`, `#room-more-btn`; выставлять роль и контекст; обновлять точку/толщину. `applyWorkspaceMode` ставит `#app[data-presentation][data-role]`.
- [ ] **Step 5:** Проверить `auth`/`lesson`/`zoom` E2E; снять скриншоты 1440/1120.

### Task 2: Панель страниц

**Files:** `frontend/js/pages.js`, `frontend/css/room.css`, `e2e/helpers.js`, `e2e/tests/workspaces.spec.js`.

- [ ] **Step 1:** Переписать разметку `PagesPanel`: заголовок + счётчик, `#page-add`/`#page-presentation` как компактные кнопки, строки с номером, `.page__select/.page__name`, бейдж PDF; `.page__menu` открывает строку `.page__actions` с `.page__up/down/rename/delete`.
- [ ] **Step 2:** Сохранить prompt-поведение и all callbacks/disabled/busy; свернуть меню при клике вне.
- [ ] **Step 3:** Обновить `helpers.js` (`openPageMenu`) и прямой тест в `workspaces.spec.js`; прогнать `workspaces`, `presentations`, `ui-polish`.
- [ ] **Step 4:** Проверить collapsed 52 px и мобильную горизонтальную полосу.

### Task 3: Панель участников

**Files:** `frontend/main.js` (`renderUsers`), `frontend/index.html`, `frontend/css/room.css`.

- [ ] **Step 1:** Строки: цветной аватар с инициалом, имя, роль, «Вы», чекбокс/кик; сохранить `.user__name`, `.user__kick`, `.user__pull-check`.
- [ ] **Step 2:** `#user-count` без скобок; заголовок «Участники N»; низ — «К себе/Всех к себе», подсказка, `details` «Горячие клавиши».
- [ ] **Step 3:** Свернуть в рельс 52 px; глаз админа; стили; проверить `ui-polish`, `invisibility`.

### Task 4: Док, «Ещё» и перенос действий

**Files:** `frontend/index.html`, `frontend/css/room.css`, `frontend/js/main.js`, `e2e/tests/board-size.spec.js`, `permissions.spec.js`, `clipboard-pdf.spec.js`.

- [ ] **Step 1:** Группы дока: выбор, кисть/ластик, фигуры, схемы, фрейм/текст, картинка; стиль-поповер (палитра + толщина), шрифт рядом при тексте; undo/lock.
- [ ] **Step 2:** PDF — иконка в верхней панели; «Холст» и «Очистить» — в `#room-more-menu`; сохранить ID/права.
- [ ] **Step 3:** Обновить тесты: открыть `#room-more-btn` перед `#board-size-btn`/`#clear-btn`; PDF остаётся видимым.
- [ ] **Step 4:** Прогнать `board-size`, `permissions`, `clipboard-pdf`, `text-fonts`, `lesson`.

### Task 5: Презентация и мобильный режим

**Files:** `frontend/css/room.css`, `frontend/js/main.js`.

- [ ] **Step 1:** Контекст комнаты: имя страницы; в презентации — «Презентация · Слайд N из M»; обновлять в `renderPages`/`updateSlideControls`.
- [ ] **Step 2:** В презентации у ученика скрыть док; у учителя оставить кисть/ластик/стиль/undo; стили слайд-бара.
- [ ] **Step 3:** Мобильный: компактная верхняя панель, док снизу с горизонтальной прокруткой, страницы — прежняя полоса, users скрыт; стиль-поповер фиксированный над доком; зум/слайд-бар выше дока.
- [ ] **Step 4:** Полный E2E + скриншоты 1440/1120/390; консоль без ошибок.
