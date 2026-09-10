/**
 * Expand-to-fullscreen for mermaid diagrams.
 *
 * These diagrams do not fit a documentation column and cannot be made to. The
 * widest one here is 2850px of natural width against a 720px column, so fitting
 * it means a scale factor of 0.25 — its 16px labels land at an effective 4px.
 * Tightening mermaid's layout spacing was tried first and recovers 7–16% on the
 * flowcharts and nothing at all on the entity diagram, which is not the order of
 * magnitude the problem needs.
 *
 * So the page shows the whole diagram scaled to the column, which is the right
 * thing for a reader scanning past it, and this adds a way to actually read one:
 * open it full-screen at natural size, pan and zoom, close it again.
 *
 * Two constraints shaped the implementation.
 *
 * `astro-mermaid` re-renders every diagram on a theme change by assigning to
 * `pre.innerHTML`, which destroys anything placed inside the `pre`. The trigger
 * button therefore lives in a wrapping `<figure>`, as a sibling of the `pre`,
 * where a re-render cannot reach it.
 *
 * The dialog clones the rendered SVG at open time rather than holding a
 * reference, so it always shows the diagram in the theme that is current now,
 * not the one that was current when the page loaded.
 */

const ZOOM_MIN = 0.15;
const ZOOM_MAX = 5;
const ZOOM_STEP = 1.2;
const PAN_STEP = 60;
/** Breathing room between a fitted diagram and the dialog edge, in px. */
const FIT_PADDING = 64;

/** Natural size from the viewBox, which is the only place mermaid records it. */
function naturalSize(svg) {
  const [, , w, h] = (svg.getAttribute('viewBox') ?? '').split(/\s+/).map(Number);
  const rect = svg.getBoundingClientRect();
  return { height: h || rect.height, width: w || rect.width };
}

let viewer = null;

/** Builds the single dialog every diagram shares. Called at most once. */
function buildViewer() {
  const dialog = document.createElement('dialog');
  dialog.className = 'mermaid-viewer';
  dialog.setAttribute('aria-label', 'Diagram viewer');

  const stage = document.createElement('div');
  stage.className = 'mermaid-viewer__stage';

  const canvas = document.createElement('div');
  canvas.className = 'mermaid-viewer__canvas';
  stage.append(canvas);

  const bar = document.createElement('div');
  bar.className = 'mermaid-viewer__bar';

  const button = (label, text) => {
    const el = document.createElement('button');
    el.type = 'button';
    el.setAttribute('aria-label', label);
    el.textContent = text;
    return el;
  };

  const out = button('Zoom out', '−');
  const reset = button('Fit diagram to the window', 'Fit');
  const zin = button('Zoom in', '+');
  const close = button('Close diagram viewer', 'Close');
  close.className = 'mermaid-viewer__close';
  bar.append(out, reset, zin, close);

  dialog.append(bar, stage);
  document.body.append(dialog);

  const view = { canvas, dialog, scale: 1, stage, x: 0, y: 0 };

  const apply = () => {
    canvas.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
  };

  /** Scales the diagram to fit the stage and centres it. */
  const fit = () => {
    const svg = canvas.querySelector('svg');
    if (!svg) {
      return;
    }
    const { height, width } = naturalSize(svg);
    const box = stage.getBoundingClientRect();
    view.scale = Math.min(
      1,
      (box.width - FIT_PADDING) / width,
      (box.height - FIT_PADDING) / height
    );
    view.x = (box.width - width * view.scale) / 2;
    view.y = (box.height - height * view.scale) / 2;
    apply();
  };

  /** Zooms about a fixed point so the content under it stays put. */
  const zoomAt = (factor, clientX, clientY) => {
    const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, view.scale * factor));
    const box = stage.getBoundingClientRect();
    const px = clientX - box.left;
    const py = clientY - box.top;
    view.x = px - ((px - view.x) * next) / view.scale;
    view.y = py - ((py - view.y) * next) / view.scale;
    view.scale = next;
    apply();
  };

  const zoomCentre = (factor) => {
    const box = stage.getBoundingClientRect();
    zoomAt(factor, box.left + box.width / 2, box.top + box.height / 2);
  };

  out.addEventListener('click', () => zoomCentre(1 / ZOOM_STEP));
  zin.addEventListener('click', () => zoomCentre(ZOOM_STEP));
  reset.addEventListener('click', fit);
  close.addEventListener('click', () => dialog.close());

  stage.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      zoomAt(event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP, event.clientX, event.clientY);
    },
    { passive: false }
  );

  // Pointer events rather than mouse events, so a touch drag pans too.
  let dragging = null;
  stage.addEventListener('pointerdown', (event) => {
    dragging = { originX: view.x, originY: view.y, startX: event.clientX, startY: event.clientY };
    stage.setPointerCapture(event.pointerId);
    stage.classList.add('is-grabbing');
  });
  stage.addEventListener('pointermove', (event) => {
    if (!dragging) {
      return;
    }
    view.x = dragging.originX + (event.clientX - dragging.startX);
    view.y = dragging.originY + (event.clientY - dragging.startY);
    apply();
  });
  const endDrag = () => {
    dragging = null;
    stage.classList.remove('is-grabbing');
  };
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);

  // Everything the pointer can do, the keyboard can do. Escape is native to
  // <dialog>, so it is deliberately absent here.
  dialog.addEventListener('keydown', (event) => {
    const pan = { ArrowDown: [0, -1], ArrowLeft: [1, 0], ArrowRight: [-1, 0], ArrowUp: [0, 1] }[
      event.key
    ];
    if (pan) {
      event.preventDefault();
      view.x += pan[0] * PAN_STEP;
      view.y += pan[1] * PAN_STEP;
      apply();
      return;
    }
    if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      zoomCentre(ZOOM_STEP);
    } else if (event.key === '-' || event.key === '_') {
      event.preventDefault();
      zoomCentre(1 / ZOOM_STEP);
    } else if (event.key === '0') {
      event.preventDefault();
      fit();
    }
  });

  // Free the clone on close; a detached SVG of this size is not worth holding.
  dialog.addEventListener('close', () => {
    canvas.replaceChildren();
  });

  window.addEventListener('resize', () => {
    if (dialog.open) {
      fit();
    }
  });

  viewer = { canvas, dialog, fit };
  return viewer;
}

function openViewer(svg) {
  const { canvas, dialog, fit } = viewer ?? buildViewer();
  const clone = svg.cloneNode(true);
  // The page copy is scaled to the column by inline width/height and an id that
  // mermaid's injected <style> selects on. Strip both so the clone renders at
  // its natural size and does not fight the page copy's styles.
  clone.removeAttribute('style');
  clone.removeAttribute('width');
  clone.removeAttribute('height');
  const { height, width } = naturalSize(svg);
  clone.style.width = `${width}px`;
  clone.style.height = `${height}px`;
  canvas.replaceChildren(clone);
  dialog.showModal();
  fit();
}

/**
 * Wraps one rendered diagram in a figure and gives it an expand control.
 * Idempotent: a diagram already wrapped is left alone.
 */
function enhance(pre) {
  if (pre.parentElement?.classList.contains('mermaid-figure')) {
    return;
  }
  const svg = pre.querySelector('svg');
  if (!svg) {
    return;
  }

  // A diagram that already renders at full size has nothing to expand into.
  const { width } = naturalSize(svg);
  if (svg.getBoundingClientRect().width >= width - 1) {
    return;
  }

  const figure = document.createElement('figure');
  figure.className = 'mermaid-figure';
  pre.replaceWith(figure);
  figure.append(pre);

  const expand = document.createElement('button');
  expand.type = 'button';
  expand.className = 'mermaid-figure__expand';
  expand.textContent = 'Expand';
  expand.setAttribute('aria-label', 'Expand diagram to full screen');
  expand.addEventListener('click', () => openViewer(pre.querySelector('svg')));
  figure.append(expand);
}

function enhanceAll() {
  for (const pre of document.querySelectorAll('pre.mermaid[data-processed]')) {
    enhance(pre);
  }
}

if (document.querySelector('pre.mermaid')) {
  // The diagrams render asynchronously — mermaid is a lazy import — so watch for
  // `data-processed` rather than guessing at a delay.
  new MutationObserver(enhanceAll).observe(document.body, {
    attributeFilter: ['data-processed'],
    attributes: true,
    subtree: true,
  });
  enhanceAll();
}
