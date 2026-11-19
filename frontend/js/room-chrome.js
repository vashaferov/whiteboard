/** Верхняя панель и поповеры комнаты: «Стиль», «Ещё» и мобильные участники. */

const $ = (selector, root = document) => root.querySelector(selector);
const isMobile = () => window.matchMedia('(max-width: 900px)').matches;

export function initRoomChrome() {
  const styleButton = $('#style-btn');
  const stylePopover = $('#style-popover');
  const moreButton = $('#room-more-btn');
  const moreMenu = $('#room-more-menu');
  const usersTopButton = $('#users-top-btn');
  const usersPanel = $('#users-panel');
  const usersToggle = $('#users-toggle');
  const backdrop = $('#room-sheet-backdrop');
  if (!styleButton || !stylePopover || !moreButton || !moreMenu) return;

  const closeStyle = () => {
    stylePopover.hidden = true;
    styleButton.setAttribute('aria-expanded', 'false');
  };

  const closeMore = () => {
    moreMenu.hidden = true;
    moreButton.setAttribute('aria-expanded', 'false');
  };

  const closeUsers = () => {
    if (!usersPanel) return;
    usersPanel.classList.remove('is-open');
    usersTopButton?.setAttribute('aria-expanded', 'false');
    if (backdrop) backdrop.hidden = true;
  };

  const openUsers = () => {
    if (!usersPanel) return;
    closeStyle();
    closeMore();
    usersPanel.style.width = '';
    usersPanel.classList.remove('is-collapsed');
    usersPanel.classList.add('is-open');
    usersTopButton?.setAttribute('aria-expanded', 'true');
    if (backdrop) backdrop.hidden = false;
  };

  styleButton.addEventListener('click', () => {
    const open = stylePopover.hidden;
    stylePopover.hidden = !open;
    styleButton.setAttribute('aria-expanded', String(open));
    if (open) closeMore();
  });

  moreButton.addEventListener('click', () => {
    const open = moreMenu.hidden;
    moreMenu.hidden = !open;
    moreButton.setAttribute('aria-expanded', String(open));
    if (open) closeStyle();
  });

  usersTopButton?.addEventListener('click', () => {
    if (!isMobile()) return;
    if (usersPanel?.classList.contains('is-open')) closeUsers();
    else openUsers();
  });

  usersToggle?.addEventListener(
    'click',
    (event) => {
      if (!isMobile() || !usersPanel?.classList.contains('is-open')) return;
      event.stopImmediatePropagation();
      event.preventDefault();
      closeUsers();
    },
    true,
  );

  backdrop?.addEventListener('click', closeUsers);

  document.addEventListener('click', (event) => {
    if (!event.target.closest('.style-wrap')) closeStyle();
    if (!event.target.closest('.room-more-wrap')) closeMore();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    closeStyle();
    closeMore();
    closeUsers();
  });

  window.addEventListener('resize', () => {
    if (!isMobile()) closeUsers();
  });

  // «Очистить доску» подтверждается confirm; после клика меню можно закрыть.
  $('#clear-btn')?.addEventListener('click', () => {
    window.setTimeout(closeMore, 0);
  });
}
