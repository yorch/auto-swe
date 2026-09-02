// Conductor mocks — shell injection + interactivity

const ICONS = {
  dashboard: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  runs: 'M3 12h4l3 8 4-16 3 8h4',
  inbox: 'M3 13l2-7h14l2 7M3 13v6h18v-6M3 13h5l1 2h6l1-2h5',
  templates: 'M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5',
  canvas: 'M4 7h7M4 12h16M13 17h7',
  agents: 'M12 3a3.5 3.5 0 013.5 3.5V8a3.5 3.5 0 01-7 0V6.5A3.5 3.5 0 0112 3zM5 21v-1a7 7 0 0114 0v1',
  skills: 'M12 3l2.4 4.9 5.4.8-3.9 3.8.9 5.3L12 15.3 7.2 17.8l.9-5.3L4.2 8.7l5.4-.8z',
  connections: 'M9 15l6-6M10 6l1-1a4 4 0 016 6l-1 1M14 18l-1 1a4 4 0 01-6-6l1-1',
  analytics: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  memory: 'M12 3c4 0 8 1.3 8 3v12c0 1.7-4 3-8 3s-8-1.3-8-3V6c0-1.7 4-3 8-3zM4 6c0 1.7 4 3 8 3s8-1.3 8-3M4 12c0 1.7 4 3 8 3s8-1.3 8-3',
  security: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z',
  admin: 'M12 9a3 3 0 100 6 3 3 0 000-6zM5 12l-2 1 2 3 2-1M19 12l2 1-2 3-2-1M12 5V3M12 21v-2',
};

const NAV = [
  ['Operate', [
    ['dashboard', 'Dashboard', 'dashboard.html'],
    ['runs', 'Runs', 'runs.html'],
    ['inbox', 'Inbox', 'inbox.html', '4'],
  ]],
  ['Build', [
    ['templates', 'Templates', 'templates.html'],
    ['canvas', 'Canvas', 'canvas.html'],
  ]],
  ['Libraries', [
    ['agents', 'Agents', 'agents.html'],
    ['skills', 'Skills', 'skills.html'],
    ['connections', 'Connections', 'connections.html'],
  ]],
  ['Insights', [
    ['analytics', 'Analytics', 'analytics.html'],
    ['memory', 'Memory', 'memory.html'],
    ['security', 'Security', 'security.html'],
  ]],
  ['Settings', [
    ['admin', 'Admin', 'admin.html'],
  ]],
];

function icon(name) {
  return `<svg class="si" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="${ICONS[name] || ''}"/></svg>`;
}

function renderShell() {
  const app = document.querySelector('.app');
  if (!app) return;
  const active = document.body.dataset.page;
  let links = '';
  for (const [group, items] of NAV) {
    links += `<div class="side-group">${group}</div>`;
    for (const [key, label, href, badge] of items) {
      links += `<a class="side-link ${key === active ? 'active' : ''}" href="${href}">${icon(key)}<span>${label}</span>${badge ? `<span class="badge">${badge}</span>` : ''}</a>`;
    }
  }
  const aside = document.createElement('aside');
  aside.className = 'side';
  aside.innerHTML = `
    <a class="side-brand" href="index.html">
      <span class="logo"><svg viewBox="0 0 24 24" fill="none"><path d="M4 7h7M4 12h16M13 17h7" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/><circle cx="17" cy="7" r="2.4" fill="#fff"/><circle cx="7" cy="17" r="2.4" fill="#fff"/></svg></span>
      Conductor
    </a>
    <div class="ctx"><span class="av">A</span><div><div style="font-weight:600;">Acme</div><div class="note" style="font-size:10.5px;">team · payments</div></div><span class="chev">⌄</span></div>
    ${links}
    <div class="side-foot"><a class="side-link" href="index.html" style="padding:6px 0;">${icon('canvas')}<span>Overview</span></a></div>
  `;
  app.prepend(aside);
}

document.addEventListener('DOMContentLoaded', renderShell);

// Tabs
document.addEventListener('click', (e) => {
  const tab = e.target.closest('[data-tab]');
  if (!tab) return;
  const group = tab.closest('[data-tabs]');
  const id = tab.getAttribute('data-tab');
  group.querySelectorAll('[data-tab]').forEach((t) => t.classList.toggle('active', t === tab));
  group.querySelectorAll('[data-pane]').forEach((p) =>
    p.classList.toggle('active', p.getAttribute('data-pane') === id)
  );
});

// Canvas node selection -> swap inspector content
document.addEventListener('click', (e) => {
  const node = e.target.closest('[data-node]');
  if (!node) return;
  const canvas = node.closest('[data-canvas]');
  if (!canvas) return;
  canvas.querySelectorAll('[data-node]').forEach((n) => n.classList.toggle('selected', n === node));
  const id = node.getAttribute('data-node');
  document.querySelectorAll('[data-inspect]').forEach((p) =>
    p.classList.toggle('active', p.getAttribute('data-inspect') === id)
  );
});
