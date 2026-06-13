// Conductor mocks — minimal interactivity (tabs + canvas node selection)

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
