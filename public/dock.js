(() => {
  'use strict';
  const dock = document.getElementById('dock');
  const key = 'classe-calme.dock.v1';
  const handle = document.createElement('button');
  handle.id = 'dockDragHandle';
  handle.type = 'button';
  handle.textContent = '⠿';
  handle.title = 'Déplacer la barre';
  handle.setAttribute('aria-label', 'Déplacer la barre, avec la souris ou les flèches');
  const collapse = document.createElement('button');
  collapse.id = 'toggleDock';
  collapse.type = 'button';
  dock.prepend(handle);
  dock.append(collapse);
  let position = null, compact = false, drag = null, frame = null;
  const panels = ['settings', 'tabPicker', 'toolsPopup', 'activitySummary'];
  const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));
  function save() {
    try { localStorage.setItem(key, JSON.stringify({ position, compact })); } catch {}
  }
  function closePanels() {
    window.settings?.(false);
    window.tabPicker?.(false);
    window.ClasseCalmeTools?.closePanel();
    document.dispatchEvent(new Event('classe-calme:close-connections'));
  }
  function positionPanels() {
    const box = dock.getBoundingClientRect();
    for (const id of panels) {
      const panel = document.getElementById(id);
      if (!panel || panel.hidden) continue;
      const above = box.top - 20, below = innerHeight - box.bottom - 20;
      const putAbove = above >= below;
      panel.style.maxHeight = Math.max(80, Math.min(innerHeight - 24, putAbove ? above : below)) + 'px';
      panel.style.maxWidth = 'calc(100vw - 24px)';
      panel.style.overflowY = 'auto';
      panel.style.bottom = panel.style.right = 'auto';
      panel.style.transform = 'none';
      const height = panel.offsetHeight, width = panel.offsetWidth;
      panel.style.left = clamp(box.left + box.width / 2 - width / 2, 12, innerWidth - width - 12) + 'px';
      panel.style.top = clamp(putAbove ? box.top - height - 10 : box.bottom + 10, 12, innerHeight - height - 12) + 'px';
    }
  }
  function layout() {
    frame = null;
    if (position) {
      const box = dock.getBoundingClientRect();
      dock.style.transform = 'none';
      dock.style.bottom = 'auto';
      dock.style.left = (8 + position.x * Math.max(0, innerWidth - box.width - 16)) + 'px';
      dock.style.top = (8 + position.y * Math.max(0, innerHeight - box.height - 16)) + 'px';
    }
    positionPanels();
  }
  function schedule() { if (frame === null) frame = requestAnimationFrame(layout); }
  function move(left, top) {
    const box = dock.getBoundingClientRect();
    const maxX = Math.max(0, innerWidth - box.width - 16), maxY = Math.max(0, innerHeight - box.height - 16);
    position = { x: maxX ? clamp(left - 8, 0, maxX) / maxX : 0, y: maxY ? clamp(top - 8, 0, maxY) / maxY : 0 };
    layout();
  }
  function updateCompact() {
    dock.classList.toggle('dock-compact', compact);
    collapse.textContent = compact ? '＋' : '−';
    collapse.title = compact ? 'Agrandir la barre' : 'Réduire la barre';
    collapse.setAttribute('aria-label', collapse.title);
    collapse.setAttribute('aria-expanded', String(!compact));
    schedule();
  }
  collapse.onclick = () => { compact = !compact; closePanels(); updateCompact(); save(); };
  handle.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0) return;
    event.preventDefault();
    const box = dock.getBoundingClientRect();
    drag = { x: event.clientX - box.left, y: event.clientY - box.top };
    handle.setPointerCapture(event.pointerId);
    handle.classList.add('dragging');
  });
  handle.addEventListener('pointermove', event => {
    if (!drag) return;
    move(event.clientX - drag.x, event.clientY - drag.y);
  });
  function stopDrag() { if (!drag) return; drag = null; handle.classList.remove('dragging'); save(); }
  handle.addEventListener('pointerup', stopDrag);
  handle.addEventListener('pointercancel', stopDrag);
  handle.addEventListener('lostpointercapture', stopDrag);
  handle.addEventListener('keydown', event => {
    const shifts = { ArrowLeft: [-20, 0], ArrowRight: [20, 0], ArrowUp: [0, -20], ArrowDown: [0, 20] };
    const shift = shifts[event.key];
    if (!shift) return;
    event.preventDefault();
    const box = dock.getBoundingClientRect();
    move(box.left + shift[0], box.top + shift[1]); save();
  });
  try {
    const stored = JSON.parse(localStorage.getItem(key));
    if (stored?.position && Number.isFinite(stored.position.x) && Number.isFinite(stored.position.y)) position = { x: clamp(stored.position.x, 0, 1), y: clamp(stored.position.y, 0, 1) };
    compact = stored?.compact === true;
  } catch {}
  for (const id of panels) {
    const panel = document.getElementById(id);
    if (panel) {
      new MutationObserver(schedule).observe(panel, { attributes: true, attributeFilter: ['hidden'] });
      new ResizeObserver(schedule).observe(panel);
    }
  }
  new ResizeObserver(schedule).observe(dock);
  document.addEventListener('click', schedule);
  document.addEventListener('fullscreenchange', schedule);
  window.addEventListener('resize', schedule);
  updateCompact();
})();
