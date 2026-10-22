'use strict';

const state = {
  me: null,
  board: null,        // datos del tablero abierto
  dragCardId: null,
  pollTimer: null,
};

const $app = document.getElementById('app');
const ROLE_LABEL = { owner: 'Dueño', editor: 'Editor', viewer: 'Lector' };
const COLORS = [
  { id: '', label: 'Sin color' },
  { id: 'blue', label: 'Azul' },
  { id: 'green', label: 'Verde' },
  { id: 'yellow', label: 'Amarillo' },
  { id: 'red', label: 'Rojo' },
  { id: 'purple', label: 'Morado' },
  { id: 'gray', label: 'Gris' },
];
const POLL_MS = 10000;

// ---------- utilidades ----------

/** Crea elementos sin usar innerHTML, para no inyectar texto de usuarios como HTML. */
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v; // CSSOM: permitido por la CSP (no usa atributos inline)
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'value') el.value = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'kanban' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  if (res.status !== 204) data = await res.json().catch(() => null);
  if (res.status === 401 && !url.startsWith('/api/auth/login')) {
    state.me = null;
    stopPolling();
    closeModal();
    renderLogin(data?.error);
    throw new Error(data?.error || 'Sesión expirada');
  }
  if (!res.ok) throw new Error(data?.error || `Error ${res.status}`);
  return data;
}

function toast(message, type = 'info') {
  const t = h('div', { class: `toast ${type}` }, message);
  document.getElementById('toasts').append(t);
  setTimeout(() => t.remove(), type === 'error' ? 6000 : 3000);
}

function fail(err) {
  if (err.message !== 'Sesión expirada') toast(err.message, 'error');
}

function initials(name = '') {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('') || '?';
}

function fmtDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('es-CL', { day: 'numeric', month: 'short' });
}

function dueState(iso) {
  if (!iso) return '';
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const [y, m, d] = iso.split('-').map(Number);
  const diff = (new Date(y, m - 1, d) - today) / 86400000;
  if (diff < 0) return 'late';
  if (diff <= 2) return 'soon';
  return '';
}

function canEdit() { return ['owner', 'editor'].includes(state.board?.my_role); }
function isOwner() { return state.board?.my_role === 'owner'; }

// ---------- modal ----------

let modalCleanup = null;

function openModal({ title, body, footer, wide }) {
  closeModal();
  const close = () => closeModal();
  const modal = h('div', { class: `modal${wide ? ' wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'modal-head' },
      h('h2', {}, title),
      h('button', { class: 'btn ghost small', type: 'button', 'aria-label': 'Cerrar', onClick: close }, '✕')),
    body,
    footer ? h('div', { class: 'modal-foot' }, footer) : null);
  const overlay = h('div', { class: 'overlay', onMousedown: (e) => { if (e.target === overlay) close(); } }, modal);
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  const previous = document.activeElement;
  document.body.append(overlay);
  modalCleanup = () => {
    document.removeEventListener('keydown', onKey);
    overlay.remove();
    if (previous && previous.focus) previous.focus();
  };
  const first = modal.querySelector('input, textarea, select');
  (first || modal.querySelector('button')).focus();
  return close;
}

function closeModal() {
  if (modalCleanup) { const c = modalCleanup; modalCleanup = null; c(); }
}

function field(label, control) {
  return h('label', { class: 'field' }, h('span', {}, label), control);
}

// ---------- shell y rutas ----------

function topbar(active) {
  const me = state.me;
  return h('header', { class: 'topbar' },
    h('a', { class: 'brand', href: '#/' },
      h('span', { class: 'brand-mark', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')),
      'Tablero'),
    h('nav', { class: 'nav' },
      h('a', { href: '#/', 'aria-current': active === 'boards' ? 'page' : null }, 'Tableros'),
      me.role === 'admin' ? h('a', { href: '#/users', 'aria-current': active === 'users' ? 'page' : null }, 'Usuarios') : null),
    h('div', { class: 'user' },
      h('span', { class: 'avatar', 'aria-hidden': 'true' }, initials(me.display_name)),
      h('span', { class: 'name' }, me.display_name),
      h('button', { class: 'btn ghost small', onClick: openPasswordModal }, 'Contraseña'),
      h('button', { class: 'btn ghost small', onClick: logout }, 'Salir')));
}

function mount(active, ...content) {
  $app.replaceChildren(topbar(active), ...content);
}

function route() {
  stopPolling();
  closeModal();
  if (!state.me) return renderLogin();
  const hash = location.hash || '#/';
  let m;
  if ((m = hash.match(/^#\/board\/(\d+)$/))) return renderBoard(Number(m[1]));
  if (hash === '#/users') return state.me.role === 'admin' ? renderUsers() : (location.hash = '#/');
  return renderBoards();
}

window.addEventListener('hashchange', route);

async function logout() {
  await api('POST', '/api/auth/logout').catch(() => {});
  state.me = null;
  stopPolling();
  renderLogin();
}

// ---------- login ----------

function renderLogin(message) {
  document.title = 'Iniciar sesión · Tablero';
  const err = h('p', { class: 'error-text', role: 'alert' }, message && message !== 'Inicia sesión para continuar.' ? message : '');
  const user = h('input', { type: 'text', name: 'username', autocomplete: 'username', required: true });
  const pass = h('input', { type: 'password', name: 'password', autocomplete: 'current-password', required: true });
  const submit = h('button', { class: 'btn primary', type: 'submit' }, 'Iniciar sesión');

  const form = h('form', { class: 'login', onSubmit: async (e) => {
    e.preventDefault();
    submit.disabled = true; err.textContent = '';
    try {
      const { user: me } = await api('POST', '/api/auth/login', { username: user.value, password: pass.value });
      state.me = me;
      route();
    } catch (ex) {
      err.textContent = ex.message;
      pass.value = ''; pass.focus();
    } finally { submit.disabled = false; }
  } },
    h('div', { class: 'brand' }, h('span', { class: 'brand-mark', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')), 'Tablero'),
    field('Usuario', user),
    field('Contraseña', pass),
    err,
    submit);

  $app.replaceChildren(h('main', { class: 'login-wrap' }, form));
  user.focus();
}

function openPasswordModal() {
  const cur = h('input', { type: 'password', autocomplete: 'current-password' });
  const nw = h('input', { type: 'password', autocomplete: 'new-password', minlength: '8' });
  const rep = h('input', { type: 'password', autocomplete: 'new-password' });
  const err = h('p', { class: 'error-text' });
  const save = async () => {
    err.textContent = '';
    if (nw.value !== rep.value) { err.textContent = 'Las contraseñas nuevas no coinciden.'; return; }
    try {
      await api('POST', '/api/auth/password', { current_password: cur.value, new_password: nw.value });
      closeModal();
      toast('Contraseña actualizada. Se cerraron tus otras sesiones.');
    } catch (ex) { err.textContent = ex.message; }
  };
  openModal({
    title: 'Cambiar contraseña',
    body: h('form', { class: 'field', onSubmit: (e) => { e.preventDefault(); save(); } },
      field('Contraseña actual', cur),
      field('Nueva contraseña (mínimo 8 caracteres)', nw),
      field('Repite la nueva contraseña', rep),
      err,
      h('button', { type: 'submit', hidden: true })),
    footer: [
      h('button', { class: 'btn', onClick: closeModal }, 'Cancelar'),
      h('button', { class: 'btn primary', onClick: save }, 'Cambiar contraseña'),
    ],
  });
}

// ---------- lista de tableros ----------

async function renderBoards() {
  document.title = 'Tableros';
  const page = h('main', { class: 'page' }, h('p', { class: 'loading' }, 'Cargando tableros…'));
  mount('boards', page);
  let boards;
  try { ({ boards } = await api('GET', '/api/boards')); } catch (e) { return fail(e); }

  const head = h('div', { class: 'page-head' },
    h('h1', {}, 'Tableros'),
    h('button', { class: 'btn primary', onClick: openNewBoard }, 'Nuevo tablero'));

  const content = boards.length
    ? h('div', { class: 'board-list' }, boards.map((b) =>
      h('a', { class: 'board-tile', href: `#/board/${b.id}` },
        h('div', { class: 'row' }, h('h2', { class: 'grow' }, b.name),
          h('span', { class: `role-tag ${b.my_role}` }, ROLE_LABEL[b.my_role])),
        b.description ? h('p', { class: 'muted' }, b.description) : null,
        h('div', { class: 'meta' },
          h('span', {}, `${b.card_count} ${b.card_count === 1 ? 'tarjeta' : 'tarjetas'}`),
          h('span', {}, `${b.member_count} ${b.member_count === 1 ? 'miembro' : 'miembros'}`)))))
    : h('div', { class: 'empty' },
      h('h2', {}, 'Todavía no tienes tableros'),
      h('p', {}, 'Crea uno para tu equipo o pide a su dueño que te agregue a un tablero existente.'),
      h('button', { class: 'btn primary', onClick: openNewBoard }, 'Crear tablero'));

  page.replaceChildren(head, content);
}

function openNewBoard() {
  const name = h('input', { type: 'text', maxlength: '100', placeholder: 'Ej. Soporte TI' });
  const desc = h('textarea', { maxlength: '500', rows: '3' });
  const err = h('p', { class: 'error-text' });
  const create = async () => {
    try {
      const { board } = await api('POST', '/api/boards', { name: name.value, description: desc.value });
      closeModal();
      location.hash = `#/board/${board.id}`;
    } catch (e) { err.textContent = e.message; }
  };
  openModal({
    title: 'Nuevo tablero',
    body: h('form', { class: 'field', onSubmit: (e) => { e.preventDefault(); create(); } },
      field('Nombre', name),
      field('Descripción (opcional)', desc),
      h('p', { class: 'muted' }, 'Se crea con las columnas Por hacer, En curso y Hecho. Puedes cambiarlas después.'),
      err),
    footer: [
      h('button', { class: 'btn', onClick: closeModal }, 'Cancelar'),
      h('button', { class: 'btn primary', onClick: create }, 'Crear tablero'),
    ],
  });
}

// ---------- tablero ----------

async function loadBoard(id) {
  state.board = await api('GET', `/api/boards/${id}`);
  return state.board;
}

async function renderBoard(id) {
  const wrap = h('main', { class: 'board-page' }, h('p', { class: 'loading' }, 'Cargando tablero…'));
  mount('boards', wrap);
  try { await loadBoard(id); } catch (e) {
    wrap.replaceChildren(h('div', { class: 'page' }, h('div', { class: 'empty' },
      h('h2', {}, e.message),
      h('a', { class: 'btn', href: '#/' }, 'Volver a tableros'))));
    return;
  }
  drawBoard();
  startPolling(id);
}

function drawBoard() {
  const wrap = $app.querySelector('.board-page');
  if (!wrap) return;
  const { board, columns, cards, my_role } = state.board;
  document.title = `${board.name} · Tablero`;
  const scroll = wrap.querySelector('.lanes')?.scrollLeft || 0;

  const head = h('div', { class: 'board-head' },
    h('div', { class: 'grow' },
      h('div', { class: 'row' }, h('h1', {}, board.name), h('span', { class: `role-tag ${my_role}` }, ROLE_LABEL[my_role])),
      board.description ? h('p', { class: 'desc' }, board.description) : null),
    h('div', { class: 'row' },
      h('button', { class: 'btn', onClick: openMembers }, isOwner() ? 'Miembros' : `${state.board.members.length} miembros`),
      isOwner() ? h('button', { class: 'btn', onClick: openBoardSettings }, 'Ajustes') : null));

  const lanes = h('div', { class: 'lanes' },
    columns.map((col) => drawLane(col, cards.filter((c) => c.column_id === col.id).sort((a, b) => a.position - b.position))),
    canEdit() ? drawAddLane() : null);

  wrap.replaceChildren(head, lanes);
  lanes.scrollLeft = scroll;
}

function drawLane(col, cards) {
  const limit = col.wip_limit;
  const over = limit && cards.length > limit;
  const ratio = limit ? Math.min(cards.length / limit, 1) : 0;

  const list = h('div', { class: 'cards', dataset: { columnId: col.id } }, cards.map(drawCard));
  if (canEdit()) wireDrop(list, col.id);

  return h('section', { class: `lane${over ? ' over' : ''}`, 'aria-label': col.name },
    h('div', { class: 'lane-head' },
      h('div', { class: 'lane-title' },
        h('h3', {}, col.name),
        h('span', { class: 'count', title: limit ? `Límite de trabajo en curso: ${limit}` : null },
          limit ? `${cards.length}/${limit}` : cards.length),
        canEdit() ? h('button', { class: 'btn ghost small', 'aria-label': `Opciones de ${col.name}`, onClick: () => openColumn(col) }, '⋯') : null),
      limit ? h('div', { class: `wip${ratio >= .8 && !over ? ' near' : ''}`, 'aria-hidden': 'true' },
        h('b', { style: `width:${ratio * 100}%` })) : null),
    list,
    canEdit() ? drawAddCard(col) : null);
}

function drawCard(card) {
  const due = dueState(card.due_date);
  const el = h('article', {
    class: 'card',
    tabindex: '0',
    draggable: canEdit() ? 'true' : null,
    dataset: { cardId: card.id, color: card.color || '' },
    onClick: () => openCard(card.id),
    onKeydown: (e) => { if (e.key === 'Enter') openCard(card.id); },
  },
    h('div', { class: 'title' }, card.title),
    (card.due_date || card.assignee_name || card.description)
      ? h('div', { class: 'foot' },
        card.description ? h('span', { class: 'has-desc', title: 'Tiene descripción' }) : null,
        card.due_date ? h('span', { class: `due ${due}`, title: `Vence: ${card.due_date}` }, fmtDate(card.due_date)) : null,
        card.assignee_name ? h('span', { class: 'avatar', title: card.assignee_name }, initials(card.assignee_name)) : null)
      : null);

  if (canEdit()) {
    el.addEventListener('dragstart', (e) => {
      state.dragCardId = card.id;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(card.id));
      requestAnimationFrame(() => el.classList.add('dragging'));
    });
    el.addEventListener('dragend', () => {
      state.dragCardId = null;
      el.classList.remove('dragging');
      document.querySelectorAll('.drop-marker').forEach((m) => m.remove());
      document.querySelectorAll('.drag-over').forEach((m) => m.classList.remove('drag-over'));
    });
  }
  return el;
}

/** Índice de inserción según la posición vertical del puntero, ignorando la tarjeta arrastrada. */
function dropIndex(list, clientY) {
  const items = [...list.querySelectorAll('.card')].filter((c) => Number(c.dataset.cardId) !== state.dragCardId);
  const idx = items.findIndex((c) => {
    const r = c.getBoundingClientRect();
    return clientY < r.top + r.height / 2;
  });
  return { index: idx === -1 ? items.length : idx, items };
}

function wireDrop(list, columnId) {
  list.addEventListener('dragover', (e) => {
    if (!state.dragCardId) return;
    e.preventDefault();
    list.classList.add('drag-over');
    const { index, items } = dropIndex(list, e.clientY);
    let marker = list.querySelector('.drop-marker');
    if (!marker) { document.querySelectorAll('.drop-marker').forEach((m) => m.remove()); marker = h('div', { class: 'drop-marker' }); }
    const ref = items[index] || null;
    if (ref) list.insertBefore(marker, ref); else list.append(marker);
  });
  list.addEventListener('dragleave', (e) => {
    if (!list.contains(e.relatedTarget)) {
      list.classList.remove('drag-over');
      list.querySelector('.drop-marker')?.remove();
    }
  });
  list.addEventListener('drop', (e) => {
    e.preventDefault();
    const cardId = state.dragCardId;
    if (!cardId) return;
    const { index } = dropIndex(list, e.clientY);
    moveCard(cardId, columnId, index);
  });
}

async function moveCard(cardId, columnId, index) {
  const cards = state.board.cards;
  const card = cards.find((c) => c.id === cardId);
  if (!card) return;

  // Actualización optimista: reordena localmente y luego confirma con el servidor.
  const fromCol = card.column_id;
  const others = (col) => cards.filter((c) => c.column_id === col && c.id !== cardId).sort((a, b) => a.position - b.position);
  const target = others(columnId);
  target.splice(Math.min(index, target.length), 0, card);
  if (fromCol !== columnId) others(fromCol).forEach((c, i) => { c.position = i; });
  card.column_id = columnId;
  target.forEach((c, i) => { c.position = i; });
  drawBoard();

  try {
    await api('POST', `/api/cards/${cardId}/move`, { column_id: columnId, position: index });
  } catch (e) {
    fail(e);
    await refreshBoard(true);
  }
}

function drawAddCard(col) {
  const box = h('div', { class: 'add-card' });
  const showButton = () => box.replaceChildren(
    h('button', { class: 'btn ghost', onClick: showForm }, '+ Añadir tarjeta'));
  const showForm = () => {
    const input = h('textarea', { rows: '2', maxlength: '200', placeholder: 'Título de la tarjeta', style: 'min-height:auto' });
    const submit = async () => {
      const title = input.value.trim();
      if (!title) return showButton();
      try {
        const { card } = await api('POST', `/api/columns/${col.id}/cards`, { title });
        state.board.cards.push(card);
        drawBoard();
        // Deja el formulario abierto para seguir agregando.
        const lane = [...document.querySelectorAll('.cards')].find((l) => Number(l.dataset.columnId) === col.id);
        lane?.parentElement.querySelector('.add-card .btn')?.click();
      } catch (e) { fail(e); }
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
      if (e.key === 'Escape') { e.stopPropagation(); showButton(); }
    });
    box.replaceChildren(h('form', { onSubmit: (e) => { e.preventDefault(); submit(); } },
      input,
      h('div', { class: 'row' },
        h('button', { class: 'btn primary small', type: 'submit' }, 'Añadir'),
        h('button', { class: 'btn ghost small', type: 'button', onClick: showButton }, 'Cancelar'))));
    input.focus();
  };
  showButton();
  return box;
}

function drawAddLane() {
  const input = h('input', { type: 'text', maxlength: '60', placeholder: 'Nueva columna' });
  return h('div', { class: 'add-lane' },
    h('form', { onSubmit: async (e) => {
      e.preventDefault();
      const name = input.value.trim();
      if (!name) return;
      try {
        const { column } = await api('POST', `/api/boards/${state.board.board.id}/columns`, { name });
        state.board.columns.push(column);
        drawBoard();
      } catch (ex) { fail(ex); }
    } }, input, h('button', { class: 'btn', type: 'submit' }, 'Añadir')));
}

// ---------- modal de tarjeta ----------

function openCard(cardId) {
  const card = state.board.cards.find((c) => c.id === cardId);
  if (!card) return;
  const { columns, members } = state.board;
  const columnName = columns.find((c) => c.id === card.column_id)?.name;

  if (!canEdit()) {
    openModal({
      title: card.title,
      body: h('div', { class: 'field' },
        h('p', { class: 'muted' }, `En ${columnName}`),
        card.description ? h('p', { style: 'white-space:pre-wrap' }, card.description) : h('p', { class: 'muted' }, 'Sin descripción.'),
        h('p', {}, `Asignada a: ${card.assignee_name || 'nadie'}`),
        card.due_date ? h('p', {}, `Vence: ${fmtDate(card.due_date)}`) : null),
      footer: [h('button', { class: 'btn', onClick: closeModal }, 'Cerrar')],
    });
    return;
  }

  let color = card.color || '';
  const title = h('input', { type: 'text', maxlength: '200', value: card.title });
  const desc = h('textarea', { maxlength: '5000', rows: '6', value: card.description });
  const column = h('select', {}, columns.map((c) => h('option', { value: c.id, selected: c.id === card.column_id }, c.name)));
  const assignee = h('select', {},
    h('option', { value: '' }, 'Sin asignar'),
    members.map((m) => h('option', { value: m.id, selected: m.id === card.assignee_id }, m.display_name)));
  const due = h('input', { type: 'date', value: card.due_date || '' });
  const swatches = h('div', { class: 'swatches', role: 'group', 'aria-label': 'Color' },
    COLORS.map((c) => h('button', {
      type: 'button',
      class: `swatch${c.id ? '' : ' none'}`,
      style: c.id ? `background: var(--c-${c.id})` : null,
      title: c.label, 'aria-label': c.label, 'aria-pressed': String(c.id === color),
      onClick: (e) => {
        color = c.id;
        swatches.querySelectorAll('.swatch').forEach((s) => s.setAttribute('aria-pressed', 'false'));
        e.currentTarget.setAttribute('aria-pressed', 'true');
      },
    })));
  const err = h('p', { class: 'error-text' });

  const save = async () => {
    err.textContent = '';
    try {
      const { card: updated } = await api('PATCH', `/api/cards/${card.id}`, {
        title: title.value,
        description: desc.value,
        color,
        due_date: due.value || null,
        assignee_id: assignee.value ? Number(assignee.value) : null,
      });
      Object.assign(card, updated);
      const toCol = Number(column.value);
      closeModal();
      if (toCol !== card.column_id) await moveCard(card.id, toCol, Number.MAX_SAFE_INTEGER);
      else drawBoard();
    } catch (e) { err.textContent = e.message; }
  };

  const remove = async () => {
    if (!confirm(`¿Eliminar la tarjeta "${card.title}"? No se puede deshacer.`)) return;
    try {
      await api('DELETE', `/api/cards/${card.id}`);
      state.board.cards = state.board.cards.filter((c) => c.id !== card.id);
      closeModal();
      drawBoard();
      toast('Tarjeta eliminada.');
    } catch (e) { err.textContent = e.message; }
  };

  openModal({
    title: 'Editar tarjeta',
    body: h('div', { class: 'field', style: 'gap:.85rem' },
      field('Título', title),
      field('Descripción', desc),
      h('div', { class: 'grid-2' },
        field('Columna', column),
        field('Asignada a', assignee),
        field('Fecha límite', due),
        h('div', { class: 'field' }, h('span', {}, 'Color'), swatches)),
      err),
    footer: [
      h('button', { class: 'btn danger left', onClick: remove }, 'Eliminar'),
      h('button', { class: 'btn', onClick: closeModal }, 'Cancelar'),
      h('button', { class: 'btn primary', onClick: save }, 'Guardar cambios'),
    ],
  });
}

// ---------- columnas ----------

function openColumn(col) {
  const { columns } = state.board;
  const idx = columns.findIndex((c) => c.id === col.id);
  const name = h('input', { type: 'text', maxlength: '60', value: col.name });
  const wip = h('input', { type: 'number', min: '1', max: '999', value: col.wip_limit ?? '', placeholder: 'Sin límite' });
  const err = h('p', { class: 'error-text' });

  const reorder = async (delta) => {
    const ids = columns.map((c) => c.id);
    const j = idx + delta;
    [ids[idx], ids[j]] = [ids[j], ids[idx]];
    try {
      await api('POST', `/api/boards/${state.board.board.id}/columns/reorder`, { ids });
      closeModal();
      await refreshBoard(true);
    } catch (e) { err.textContent = e.message; }
  };

  const save = async () => {
    err.textContent = '';
    try {
      const { column } = await api('PATCH', `/api/columns/${col.id}`, {
        name: name.value,
        wip_limit: wip.value ? Number(wip.value) : null,
      });
      Object.assign(col, column);
      closeModal();
      drawBoard();
    } catch (e) { err.textContent = e.message; }
  };

  const remove = async () => {
    if (!confirm(`¿Eliminar la columna "${col.name}"?`)) return;
    try {
      await api('DELETE', `/api/columns/${col.id}`);
      state.board.columns = columns.filter((c) => c.id !== col.id);
      closeModal();
      drawBoard();
    } catch (e) { err.textContent = e.message; }
  };

  openModal({
    title: 'Columna',
    body: h('form', { class: 'field', style: 'gap:.85rem', onSubmit: (e) => { e.preventDefault(); save(); } },
      field('Nombre', name),
      field('Límite de tarjetas en curso (opcional)', wip),
      h('div', { class: 'row' },
        h('span', { class: 'muted grow' }, 'Posición en el tablero'),
        h('button', { class: 'btn small', type: 'button', disabled: idx === 0, onClick: () => reorder(-1) }, '← Mover a la izquierda'),
        h('button', { class: 'btn small', type: 'button', disabled: idx === columns.length - 1, onClick: () => reorder(1) }, 'Mover a la derecha →')),
      err,
      h('button', { type: 'submit', hidden: true })),
    footer: [
      h('button', { class: 'btn danger left', onClick: remove }, 'Eliminar columna'),
      h('button', { class: 'btn', onClick: closeModal }, 'Cancelar'),
      h('button', { class: 'btn primary', onClick: save }, 'Guardar cambios'),
    ],
  });
}

// ---------- miembros y ajustes ----------

async function openMembers() {
  const boardId = state.board.board.id;
  const owner = isOwner();
  const list = h('div', { class: 'member-list' });
  const err = h('p', { class: 'error-text' });
  const addRow = h('div', { class: 'row' });

  const drawMembers = async () => {
    await refreshBoard(true);
    const members = state.board.members;
    list.replaceChildren(...members.map((m) => h('div', { class: 'member' },
      h('span', { class: 'avatar', 'aria-hidden': 'true' }, initials(m.display_name)),
      h('div', { class: 'grow' }, h('div', {}, m.display_name), h('div', { class: 'muted', style: 'font-size:.85rem' }, m.username)),
      owner
        ? h('select', { 'aria-label': `Rol de ${m.display_name}`, onChange: (e) => setRole(m.id, e.target.value) },
          ['owner', 'editor', 'viewer'].map((r) => h('option', { value: r, selected: r === m.role }, ROLE_LABEL[r])))
        : h('span', { class: `role-tag ${m.role}` }, ROLE_LABEL[m.role]),
      owner ? h('button', { class: 'btn ghost small', 'aria-label': `Quitar a ${m.display_name}`, onClick: () => removeMember(m) }, 'Quitar') : null)));

    if (!owner) return;
    const { users } = await api('GET', '/api/users/directory');
    const candidates = users.filter((u) => !members.some((m) => m.id === u.id));
    if (!candidates.length) {
      addRow.replaceChildren(h('p', { class: 'muted' }, 'Todas las personas activas ya son miembros.'));
      return;
    }
    const who = h('select', { class: 'grow', 'aria-label': 'Persona' },
      candidates.map((u) => h('option', { value: u.id }, `${u.display_name} (${u.username})`)));
    const role = h('select', { style: 'width:auto', 'aria-label': 'Rol' },
      ['editor', 'viewer', 'owner'].map((r) => h('option', { value: r }, ROLE_LABEL[r])));
    addRow.replaceChildren(who, role, h('button', { class: 'btn primary', onClick: () => setRole(Number(who.value), role.value) }, 'Agregar'));
  };

  const setRole = async (userId, role) => {
    err.textContent = '';
    try { await api('PUT', `/api/boards/${boardId}/members/${userId}`, { role }); } catch (e) { err.textContent = e.message; }
    await drawMembers();
  };

  const removeMember = async (m) => {
    if (!confirm(`¿Quitar a ${m.display_name} del tablero?`)) return;
    err.textContent = '';
    try { await api('DELETE', `/api/boards/${boardId}/members/${m.id}`); } catch (e) { err.textContent = e.message; }
    await drawMembers();
  };

  openModal({
    title: 'Miembros del tablero',
    body: h('div', { class: 'field', style: 'gap:1rem' },
      owner ? h('p', { class: 'muted' }, 'Dueño: administra miembros y ajustes. Editor: crea y mueve tarjetas y columnas. Lector: solo mira.') : null,
      list,
      owner ? h('div', { class: 'panel' }, h('h3', {}, 'Agregar persona'), addRow) : null,
      err),
    footer: [h('button', { class: 'btn', onClick: () => { closeModal(); drawBoard(); } }, 'Listo')],
  });
  drawMembers().catch(fail);
}

function openBoardSettings() {
  const { board } = state.board;
  const name = h('input', { type: 'text', maxlength: '100', value: board.name });
  const desc = h('textarea', { maxlength: '500', rows: '3', value: board.description });
  const err = h('p', { class: 'error-text' });

  const save = async () => {
    try {
      const { board: b } = await api('PATCH', `/api/boards/${board.id}`, { name: name.value, description: desc.value });
      state.board.board = b;
      closeModal();
      drawBoard();
    } catch (e) { err.textContent = e.message; }
  };
  const remove = async () => {
    const typed = prompt(`Esto elimina el tablero con todas sus columnas y tarjetas.\nEscribe el nombre del tablero para confirmar:`);
    if (typed === null) return;
    if (typed.trim() !== board.name) { err.textContent = 'El nombre no coincide; no se eliminó nada.'; return; }
    try {
      await api('DELETE', `/api/boards/${board.id}`);
      closeModal();
      toast('Tablero eliminado.');
      location.hash = '#/';
    } catch (e) { err.textContent = e.message; }
  };

  openModal({
    title: 'Ajustes del tablero',
    body: h('form', { class: 'field', style: 'gap:.85rem', onSubmit: (e) => { e.preventDefault(); save(); } },
      field('Nombre', name), field('Descripción', desc), err, h('button', { type: 'submit', hidden: true })),
    footer: [
      h('button', { class: 'btn danger left', onClick: remove }, 'Eliminar tablero'),
      h('button', { class: 'btn', onClick: closeModal }, 'Cancelar'),
      h('button', { class: 'btn primary', onClick: save }, 'Guardar cambios'),
    ],
  });
}

// ---------- sincronización ----------

async function refreshBoard(force = false) {
  if (!state.board) return;
  const id = state.board.board.id;
  const typing = document.activeElement?.closest?.('.lanes form');
  if (!force && (state.dragCardId || modalCleanup || typing)) return;
  const before = JSON.stringify(state.board);
  try { await loadBoard(id); } catch (e) {
    if (e.message !== 'Sesión expirada') { toast(e.message, 'error'); location.hash = '#/'; }
    return;
  }
  if (force || JSON.stringify(state.board) !== before) drawBoard();
}

function startPolling() {
  stopPolling();
  state.pollTimer = setInterval(() => {
    if (document.visibilityState === 'visible') refreshBoard();
  }, POLL_MS);
}

function stopPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = null;
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.pollTimer) refreshBoard();
});

// ---------- administración de usuarios ----------

async function renderUsers() {
  document.title = 'Usuarios';
  const page = h('main', { class: 'page' }, h('p', { class: 'loading' }, 'Cargando usuarios…'));
  mount('users', page);
  let users;
  try { ({ users } = await api('GET', '/api/users')); } catch (e) { return fail(e); }

  const table = h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, h('th', {}, 'Nombre'), h('th', {}, 'Usuario'), h('th', {}, 'Rol'), h('th', {}, 'Estado'), h('th', {}, ''))),
    h('tbody', {}, users.map((u) => h('tr', { class: u.active ? '' : 'inactive' },
      h('td', {}, h('div', { class: 'row' }, h('span', { class: 'avatar', 'aria-hidden': 'true' }, initials(u.display_name)), u.display_name)),
      h('td', {}, u.username),
      h('td', {}, u.role === 'admin' ? 'Administrador' : 'Usuario'),
      h('td', {}, h('span', { class: 'status-dot' }), u.active ? 'Activo' : 'Desactivado'),
      h('td', { style: 'text-align:right' }, h('button', { class: 'btn small', onClick: () => openUser(u) }, 'Editar')))))));

  page.replaceChildren(
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, 'Usuarios'), h('p', { class: 'muted' }, 'Solo los administradores crean cuentas. Desactivar una cuenta cierra sus sesiones.')),
      h('button', { class: 'btn primary', onClick: () => openUser(null) }, 'Crear usuario')),
    table);
}

function openUser(u) {
  const isNew = !u;
  const username = h('input', { type: 'text', maxlength: '50', value: u?.username || '', disabled: !isNew, autocomplete: 'off' });
  const display = h('input', { type: 'text', maxlength: '100', value: u?.display_name || '' });
  const role = h('select', {},
    h('option', { value: 'user', selected: u?.role !== 'admin' }, 'Usuario'),
    h('option', { value: 'admin', selected: u?.role === 'admin' }, 'Administrador'));
  const password = h('input', { type: 'password', autocomplete: 'new-password', placeholder: isNew ? '' : 'Déjala vacía para no cambiarla' });
  const active = h('input', { type: 'checkbox', checked: u ? u.active : true });
  const err = h('p', { class: 'error-text' });

  const save = async () => {
    err.textContent = '';
    try {
      if (isNew) {
        await api('POST', '/api/users', { username: username.value, display_name: display.value, password: password.value, role: role.value });
        toast('Usuario creado.');
      } else {
        const body = { display_name: display.value, role: role.value, active: active.checked };
        if (password.value) body.password = password.value;
        await api('PATCH', `/api/users/${u.id}`, body);
        toast('Cambios guardados.');
        if (u.id === state.me.id) state.me = (await api('GET', '/api/auth/me')).user;
      }
      closeModal();
      renderUsers();
    } catch (e) { err.textContent = e.message; }
  };

  openModal({
    title: isNew ? 'Crear usuario' : `Editar a ${u.display_name}`,
    body: h('form', { class: 'field', style: 'gap:.85rem', onSubmit: (e) => { e.preventDefault(); save(); } },
      h('div', { class: 'grid-2' }, field('Usuario', username), field('Nombre visible', display)),
      h('div', { class: 'grid-2' },
        field('Rol', role),
        field(isNew ? 'Contraseña (mínimo 8 caracteres)' : 'Nueva contraseña', password)),
      isNew ? null : h('label', { class: 'row' }, active, 'Cuenta activa'),
      err,
      h('button', { type: 'submit', hidden: true })),
    footer: [
      h('button', { class: 'btn', onClick: closeModal }, 'Cancelar'),
      h('button', { class: 'btn primary', onClick: save }, isNew ? 'Crear usuario' : 'Guardar cambios'),
    ],
  });
}

// ---------- arranque ----------

(async function boot() {
  try {
    const { user } = await api('GET', '/api/auth/me');
    state.me = user;
    route();
  } catch { /* api() ya mostró el login */ }
})();
