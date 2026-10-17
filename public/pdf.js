/* PDF.js 6.4.299 : Mozilla, licence Apache-2.0, fichiers locaux dans vendor/pdfjs. */
(() => {
  'use strict';
  const base = new URL('.', document.currentScript.src);
  let library;
  const loadLibrary = () => library ??= import(new URL('vendor/pdfjs/pdf.mjs', base).href).then(pdfjs => {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('vendor/pdfjs/pdf.worker.mjs', base).href;
    return pdfjs;
  }).catch(error => { library = null; throw error; });
  function create(panel, { canChange = () => true, onChange = () => {} } = {}) {
    panel.classList.add('pdf-panel');
    const toolbar = document.createElement('div');
    toolbar.className = 'pdf-controls';
    toolbar.setAttribute('role', 'group');
    toolbar.setAttribute('aria-label', 'Pages et zoom du PDF');
    const previous = document.createElement('button');
    previous.type = 'button'; previous.textContent = '‹'; previous.setAttribute('aria-label', 'Page précédente');
    const pageInput = document.createElement('input');
    pageInput.type = 'number'; pageInput.min = '1'; pageInput.value = '1'; pageInput.setAttribute('aria-label', 'Page du PDF');
    const total = document.createElement('span'); total.textContent = '/ …';
    const next = document.createElement('button');
    next.type = 'button'; next.textContent = '›'; next.setAttribute('aria-label', 'Page suivante');
    const zoomInput = document.createElement('select'); zoomInput.setAttribute('aria-label', 'Zoom du PDF');
    for (const [value, text] of [['fit', 'Ajuster'], ['0.5', '50 %'], ['0.75', '75 %'], ['1', '100 %'], ['1.25', '125 %'], ['1.5', '150 %'], ['2', '200 %'], ['3', '300 %']]) {
      const option = document.createElement('option'); option.value = value; option.textContent = text; zoomInput.append(option);
    }
    toolbar.append(previous, pageInput, total, next, zoomInput);
    const scroller = document.createElement('div'); scroller.className = 'pdf-scroll'; scroller.tabIndex = 0;
    scroller.setAttribute('aria-label', 'Document PDF');
    const canvas = document.createElement('canvas'); canvas.hidden = true;
    const status = document.createElement('p'); status.className = 'pdf-status'; status.setAttribute('role', 'status'); status.textContent = 'Chargement du PDF…';
    scroller.append(canvas, status); panel.append(scroller, toolbar);
    let pdf = null, loadingTask = null, renderTask = null, renderVersion = 0, loadVersion = 0, disposed = false;
    let page = 1, zoom = 'fit', frame = 0, active = true;
    function refreshControls() {
      pageInput.value = String(page); pageInput.max = String(pdf?.numPages ?? 100000);
      total.textContent = pdf ? '/ ' + pdf.numPages : '/ …';
      previous.disabled = !pdf || page <= 1; next.disabled = !pdf || page >= pdf.numPages;
      pageInput.disabled = zoomInput.disabled = !pdf;
      if (![...zoomInput.options].some(option => option.value === String(zoom))) {
        const option = document.createElement('option'); option.value = String(zoom); option.textContent = Math.round(zoom * 100) + ' %'; zoomInput.append(option);
      }
      zoomInput.value = String(zoom);
    }
    function schedule() { cancelAnimationFrame(frame); frame = requestAnimationFrame(render); }
    async function render() {
      if (!pdf || disposed || !active || panel.hidden || !scroller.clientWidth || !scroller.clientHeight) return;
      const version = ++renderVersion;
      renderTask?.cancel();
      try {
        const pdfPage = await pdf.getPage(page);
        if (version !== renderVersion || disposed) return;
        const initial = pdfPage.getViewport({ scale: 1 });
        const fit = Math.min((scroller.clientWidth - 24) / initial.width, (scroller.clientHeight - 28) / initial.height);
        const scale = zoom === 'fit' ? Math.max(.05, fit) : Number(zoom);
        const viewport = pdfPage.getViewport({ scale });
        // Limiter la mémoire d'affichage, même sur les écrans très denses.
        const density = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(16000000 / (viewport.width * viewport.height)));
        const nextCanvas = document.createElement('canvas');
        nextCanvas.width = Math.max(1, Math.floor(viewport.width * density));
        nextCanvas.height = Math.max(1, Math.floor(viewport.height * density));
        nextCanvas.style.width = Math.floor(viewport.width) + 'px'; nextCanvas.style.height = Math.floor(viewport.height) + 'px';
        renderTask = pdfPage.render({ canvasContext: nextCanvas.getContext('2d', { alpha: false }), viewport, transform: density === 1 ? null : [density, 0, 0, density, 0, 0] });
        await renderTask.promise;
        if (version !== renderVersion || disposed) return;
        canvas.width = nextCanvas.width; canvas.height = nextCanvas.height;
        canvas.style.width = nextCanvas.style.width; canvas.style.height = nextCanvas.style.height;
        canvas.getContext('2d', { alpha: false }).drawImage(nextCanvas, 0, 0);
        canvas.hidden = false; status.hidden = true; canvas.setAttribute('aria-label', 'Page ' + page + ' sur ' + pdf.numPages);
      } catch (error) {
        if (version !== renderVersion || disposed || error?.name === 'RenderingCancelledException') return;
        status.textContent = 'Cette page ne peut pas être affichée.'; status.hidden = false;
      }
    }
    function setState(state, local = false) {
      if (local && !canChange()) { refreshControls(); return; }
      const nextPage = Math.max(1, Math.min(pdf?.numPages ?? 100000, Math.round(Number(state.page) || 1)));
      const nextZoom = state.zoom === 'fit' ? 'fit' : Math.min(3, Math.max(.5, Number(state.zoom) || 1));
      const changed = nextPage !== page || nextZoom !== zoom;
      page = nextPage; zoom = nextZoom; refreshControls();
      if (changed) { scroller.scrollTop = scroller.scrollLeft = 0; schedule(); if (local) onChange({ page, zoom }); }
    }
    previous.onclick = () => setState({ page: page - 1, zoom }, true);
    next.onclick = () => setState({ page: page + 1, zoom }, true);
    pageInput.onchange = () => setState({ page: +pageInput.value, zoom }, true);
    zoomInput.onchange = () => setState({ page, zoom: zoomInput.value }, true);
    scroller.addEventListener('keydown', event => {
      if (event.key === 'PageDown' || event.key === 'PageUp') {
        event.preventDefault(); setState({ page: page + (event.key === 'PageDown' ? 1 : -1), zoom }, true);
      }
    });
    const observer = new ResizeObserver(schedule); observer.observe(scroller);
    refreshControls();
    return {
      getState: () => ({ page, zoom }),
      setState: state => setState(state),
      activate() { if (!active) { active = true; schedule(); } },
      deactivate() {
        if (!active) return;
        active = false; renderVersion++; cancelAnimationFrame(frame); renderTask?.cancel();
        canvas.width = canvas.height = 0; canvas.hidden = true;
      },
      async load(blob) {
        const version = ++loadVersion;
        loadingTask?.destroy(); pdf?.destroy(); pdf = null;
        canvas.hidden = true; status.hidden = false; status.textContent = 'Chargement du PDF…'; refreshControls();
        try {
          const [pdfjs, bytes] = await Promise.all([loadLibrary(), blob.arrayBuffer()]);
          if (version !== loadVersion || disposed) return;
          loadingTask = pdfjs.getDocument({ data: new Uint8Array(bytes), cMapUrl: new URL('vendor/pdfjs/cmaps/', base).href, cMapPacked: true, standardFontDataUrl: new URL('vendor/pdfjs/standard_fonts/', base).href, wasmUrl: new URL('vendor/pdfjs/wasm/', base).href, iccUrl: new URL('vendor/pdfjs/iccs/', base).href, isEvalSupported: false });
          const loaded = await loadingTask.promise;
          if (version !== loadVersion || disposed) { loaded.destroy(); return; }
          pdf = loaded;
          page = Math.min(page, pdf.numPages); refreshControls(); schedule();
        } catch (error) {
          if (version !== loadVersion || disposed) return;
          status.textContent = error?.name === 'PasswordException' ? 'PDF protégé : ouvrez une copie sans mot de passe.' : 'PDF illisible. Essayez un autre fichier.';
          status.hidden = false;
        }
      },
      error(message = 'PDF indisponible. Reconnectez cet écran.') { status.textContent = message; status.hidden = false; },
      destroy() { disposed = true; loadVersion++; renderVersion++; observer.disconnect(); cancelAnimationFrame(frame); renderTask?.cancel(); loadingTask?.destroy(); canvas.width = canvas.height = 0; }
    };
  }
  window.ClasseCalmePdf = { create };
})();
