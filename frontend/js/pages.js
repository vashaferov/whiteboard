/**
 * Панель страниц (workspaces): список, переключение и управление.
 * Управление (создание, переименование, удаление, порядок) показывается
 * только учителю (canManage) и блокируется, пока идёт переключение (busy).
 */

export class PagesPanel {
  constructor({
    container,
    onSelect,
    onCreate,
    onCreatePresentation,
    onRename,
    onDelete,
    onMove,
    onToggleCollapse,
  }) {
    this.container = container;
    this.onSelect = onSelect;
    this.onCreate = onCreate;
    this.onCreatePresentation = onCreatePresentation;
    this.onRename = onRename;
    this.onDelete = onDelete;
    this.onMove = onMove;
    this.onToggleCollapse = onToggleCollapse;
    this.openMenuId = null;

    document.addEventListener('click', (event) => {
      if (!this.openMenuId) return;
      if (!event.target.closest('.page')) {
        this.openMenuId = null;
        this.resyncMenu();
      }
    });
  }

  render(workspaces, activeId, { canManage = false, busy = false, collapsed = false } = {}) {
    this.container.replaceChildren();

    const items = workspaces ?? [];
    if (this.openMenuId && !items.some((workspace) => workspace.id === this.openMenuId)) {
      this.openMenuId = null;
    }

    const header = document.createElement('div');
    header.className = 'pages-panel__header';

    const title = document.createElement('h2');
    title.className = 'pages-panel__title';
    title.append('Страницы');
    const count = document.createElement('span');
    count.textContent = String(items.length);
    title.appendChild(count);
    header.appendChild(title);

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.id = 'pages-toggle';
    toggle.className = 'panel-toggle';
    toggle.textContent = collapsed ? '»' : '«';
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('aria-label', collapsed ? 'Развернуть страницы' : 'Свернуть страницы');
    toggle.addEventListener('click', () => this.onToggleCollapse?.());
    header.appendChild(toggle);

    this.container.appendChild(header);

    const list = document.createElement('ul');
    list.className = 'page-list';
    this.container.appendChild(list);

    items.forEach((workspace, index) => {
      const item = document.createElement('li');
      item.className = 'page';
      if (workspace.id === activeId) item.classList.add('is-active');
      if (workspace.id === this.openMenuId) item.classList.add('is-menu-open');

      const select = document.createElement('button');
      select.type = 'button';
      select.className = 'page__select';
      select.disabled = busy;
      select.addEventListener('click', () => {
        this.openMenuId = null;
        this.onSelect?.(workspace.id);
      });

      const number = document.createElement('span');
      number.className = 'page__num';
      number.textContent = String(index + 1);
      select.appendChild(number);

      const name = document.createElement('span');
      name.className = 'page__name';
      name.textContent = workspace.name;
      select.appendChild(name);

      if (workspace.kind === 'presentation') {
        item.classList.add('page--presentation');
        const kind = document.createElement('span');
        kind.className = 'page__kind';
        kind.textContent = 'PDF';
        kind.title = 'Презентация';
        select.appendChild(kind);
      }

      item.appendChild(select);

      if (canManage) {
        const menu = document.createElement('button');
        menu.type = 'button';
        menu.className = 'page__menu';
        menu.textContent = '⋯';
        menu.title = 'Действия со страницей';
        menu.setAttribute('aria-label', 'Действия со страницей');
        menu.setAttribute('aria-expanded', String(workspace.id === this.openMenuId));
        menu.disabled = busy;
        menu.addEventListener('click', () => {
          this.openMenuId = this.openMenuId === workspace.id ? null : workspace.id;
          this.render(workspaces, activeId, { canManage, busy, collapsed });
        });
        item.appendChild(menu);

        const actions = document.createElement('div');
        actions.className = 'page__actions';

        const up = this._actionButton('page__up', '↑', 'Вверх', () => this.onMove?.(workspace.id, 'up'));
        const down = this._actionButton('page__down', '↓', 'Вниз', () => this.onMove?.(workspace.id, 'down'));
        const rename = this._actionButton('page__rename', '✎', 'Переименовать', () => this.onRename?.(workspace));
        const del = this._actionButton('page__delete', '×', 'Удалить', () => this.onDelete?.(workspace));
        for (const button of [up, down, rename, del]) button.disabled = busy;
        up.disabled = up.disabled || index === 0;
        down.disabled = down.disabled || index === items.length - 1;
        del.disabled = del.disabled || items.length <= 1;

        actions.append(up, down, rename, del);
        item.appendChild(actions);
      }

      list.appendChild(item);
    });

    if (canManage) {
      const footer = document.createElement('div');
      footer.className = 'pages-panel__footer';

      const add = document.createElement('button');
      add.type = 'button';
      add.id = 'page-add';
      add.className = 'btn btn--ghost';
      add.textContent = '+ Страница';
      add.disabled = busy;
      add.addEventListener('click', () => this.onCreate?.());
      footer.appendChild(add);

      const presentation = document.createElement('button');
      presentation.type = 'button';
      presentation.id = 'page-presentation';
      presentation.className = 'btn btn--ghost';
      presentation.textContent = 'Загрузить презентацию';
      presentation.title = 'Загрузить PDF-презентацию';
      presentation.disabled = busy;
      presentation.addEventListener('click', () => this.onCreatePresentation?.());
      footer.appendChild(presentation);

      this.container.appendChild(footer);
    }
  }

  resyncMenu() {
    this.container.querySelectorAll('.page').forEach((item) => {
      item.classList.remove('is-menu-open');
    });
    this.container.querySelectorAll('.page__menu').forEach((button) => {
      button.setAttribute('aria-expanded', 'false');
    });
  }

  _actionButton(className, label, title, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.title = title;
    button.textContent = label;
    button.addEventListener('click', () => {
      this.openMenuId = null;
      this.resyncMenu();
      onClick();
    });
    return button;
  }
}
