/**
 * Панель страниц (workspaces): список, переключение и управление.
 * Управление (создание, переименование, удаление, порядок) показывается
 * только учителю (canManage) и блокируется, пока идёт переключение (busy).
 */

export class PagesPanel {
  constructor({ container, onSelect, onCreate, onCreatePresentation, onRename, onDelete, onMove }) {
    this.container = container;
    this.onSelect = onSelect;
    this.onCreate = onCreate;
    this.onCreatePresentation = onCreatePresentation;
    this.onRename = onRename;
    this.onDelete = onDelete;
    this.onMove = onMove;
  }

  render(workspaces, activeId, { canManage = false, busy = false } = {}) {
    this.container.replaceChildren();

    const header = document.createElement('div');
    header.className = 'pages-panel__header';

    const title = document.createElement('h2');
    title.className = 'pages-panel__title';
    title.textContent = 'Страницы';
    header.appendChild(title);

    if (canManage) {
      const adds = document.createElement('div');
      adds.className = 'pages-panel__adds';

      const add = document.createElement('button');
      add.type = 'button';
      add.id = 'page-add';
      add.className = 'btn btn--ghost pages-panel__add';
      add.textContent = '+ Страница';
      add.disabled = busy;
      add.addEventListener('click', () => this.onCreate?.());
      adds.appendChild(add);

      const addPresentation = document.createElement('button');
      addPresentation.type = 'button';
      addPresentation.id = 'page-presentation';
      addPresentation.className = 'btn btn--ghost pages-panel__add';
      addPresentation.textContent = '+ Презентация';
      addPresentation.title = 'Загрузить PDF-презентацию';
      addPresentation.disabled = busy;
      addPresentation.addEventListener('click', () => this.onCreatePresentation?.());
      adds.appendChild(addPresentation);

      header.appendChild(adds);
    }

    this.container.appendChild(header);

    const list = document.createElement('ul');
    list.className = 'page-list';
    this.container.appendChild(list);

    const items = workspaces ?? [];
    items.forEach((workspace, index) => {
      const item = document.createElement('li');
      item.className = 'page';
      if (workspace.id === activeId) item.classList.add('is-active');

      const select = document.createElement('button');
      select.type = 'button';
      select.className = 'page__select';
      select.disabled = busy;
      select.addEventListener('click', () => this.onSelect?.(workspace.id));

      const name = document.createElement('span');
      name.className = 'page__name';
      name.textContent = workspace.name;
      if (workspace.kind === 'presentation') {
        item.classList.add('page--presentation');
        const kind = document.createElement('span');
        kind.className = 'page__kind';
        kind.textContent = 'PDF';
        kind.title = 'Презентация';
        select.appendChild(kind);
      }
      select.appendChild(name);

      item.appendChild(select);

      if (canManage) {
        const actions = document.createElement('div');
        actions.className = 'page__actions';

        const up = this._actionButton('page__up', '▲', 'Вверх', () => this.onMove?.(workspace.id, 'up'));
        const down = this._actionButton('page__down', '▼', 'Вниз', () => this.onMove?.(workspace.id, 'down'));
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
  }

  _actionButton(className, label, title, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.title = title;
    button.textContent = label;
    button.addEventListener('click', onClick);
    return button;
  }
}
