'use strict';

/* ============================== STATE ============================== */

const state = {
  modulo: 5,
  rowCount: 4096,

  residueData: null,      // typed array, length = rowCount*(rowCount+1)/2, regenerated on modulo/rowCount change only
  palette: [],             // hex strings, length === modulo
  paletteRGBA32: null,     // Uint32Array, length === modulo

  pan: { x: 0, y: 0 },      // physical pixels, screen position of world origin (row 0, col 0 centerline)
  zoom: 0.05,               // physical px per cell-unit
  yScale: 1,
  minZoom: 0.01,
  maxZoom: 48,

  dpr: 1,
  physW: 0,
  physH: 0,
  imageData: null,
  pixel32: null,
  bgColor32: 0,

  pointers: new Map(),      // pointerId -> {x,y} physical
  dragStart: null,          // {x,y,panX,panY}
  pinchLastDist: null,

  redrawScheduled: false,
};

/* ============================== GENERATION ============================== */

function triIndex(row, col) {
  return (row * (row + 1)) / 2 + col;
}

function pickTypedArrayCtor(modulo) {
  if (modulo <= 256) return Uint8Array;
  if (modulo <= 65536) return Uint16Array;
  return Uint32Array;
}

function generateTriangle(rowCount, modulo) {
  const Ctor = pickTypedArrayCtor(modulo);
  const total = triIndex(rowCount - 1, rowCount - 1) + 1;
  const data = new Ctor(total);
  const base = 1 % modulo;
  data[0] = base;
  for (let r = 1; r < rowCount; r++) {
    const rowStart = triIndex(r, 0);
    const prevRowStart = triIndex(r - 1, 0);
    data[rowStart] = base;
    data[rowStart + r] = base;
    for (let c = 1; c < r; c++) {
      data[rowStart + c] = (data[prevRowStart + c - 1] + data[prevRowStart + c]) % modulo;
    }
  }
  return data;
}

/* ============================== PALETTE ============================== */

const scratchBytes = new Uint8ClampedArray(4);
const scratchU32 = new Uint32Array(scratchBytes.buffer);

function packRGBA(r, g, b, a) {
  scratchBytes[0] = r;
  scratchBytes[1] = g;
  scratchBytes[2] = b;
  scratchBytes[3] = a;
  return scratchU32[0];
}

function hexToRgb(hex) {
  const v = parseInt(hex.slice(1), 16);
  return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 };
}

function hslToHex(h, s, l) {
  s /= 100;
  l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const toHex = (x) => Math.round(x * 255).toString(16).padStart(2, '0');
  return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
}

function buildDefaultPalette(modulo) {
  const palette = new Array(modulo);
  palette[0] = '#000000';
  const span = modulo - 2;
  for (let i = 1; i < modulo; i++) {
    const hue = span <= 0 ? 0 : Math.round(((i - 1) * 330) / span);
    palette[i] = hslToHex(hue, 70, 50);
  }
  return palette;
}

function buildPaletteRGBA32(hexArray) {
  const arr = new Uint32Array(hexArray.length);
  for (let i = 0; i < hexArray.length; i++) {
    const { r, g, b } = hexToRgb(hexArray[i]);
    arr[i] = packRGBA(r, g, b, 255);
  }
  return arr;
}

/* ============================== RENDER ============================== */

const canvas = document.getElementById('triangleCanvas');
const ctx = canvas.getContext('2d', { alpha: false });

state.bgColor32 = packRGBA(13, 13, 18, 255);

function render() {
  state.redrawScheduled = false;
  if (!state.residueData || !state.pixel32) return;

  const physW = state.physW;
  const physH = state.physH;
  const zoom = state.zoom;
  const yScale = state.yScale;
  const panX = state.pan.x;
  const panY = state.pan.y;
  const rowCount = state.rowCount;
  const residueData = state.residueData;
  const paletteRGBA32 = state.paletteRGBA32;
  const pixel32 = state.pixel32;
  const bgColor32 = state.bgColor32;

  for (let py = 0; py < physH; py++) {
    const worldY = (py - panY) / zoom;
    const rCont = worldY / yScale;
    const row = Math.round(rCont);
    const rowInRange = row >= 0 && row < rowCount;
    const rowBase = rowInRange ? triIndex(row, 0) : 0;
    const rowOffsetX = rCont / 2;
    const lineBase = py * physW;

    for (let px = 0; px < physW; px++) {
      const worldX = (px - panX) / zoom;
      const col = Math.round(worldX + rowOffsetX);
      let color = bgColor32;
      if (rowInRange && col >= 0 && col <= row) {
        color = paletteRGBA32[residueData[rowBase + col]];
      }
      pixel32[lineBase + px] = color;
    }
  }

  ctx.putImageData(state.imageData, 0, 0);
}

function scheduleRender() {
  if (state.redrawScheduled) return;
  state.redrawScheduled = true;
  requestAnimationFrame(render);
}

/* ============================== TRANSFORM + INPUT ============================== */

function computeFitZoom() {
  const rc = state.rowCount;
  return Math.min(state.physW / rc, state.physH / (rc * state.yScale)) * 0.9;
}

function computeFitView() {
  const zoom = computeFitZoom();
  return { zoom, panX: state.physW / 2, panY: state.physH * 0.02 };
}

function recomputeZoomBounds() {
  const fitZoom = computeFitZoom();
  state.minZoom = fitZoom * 0.5;
  state.zoom = Math.min(Math.max(state.zoom, state.minZoom), state.maxZoom);
}

function resetView() {
  const { zoom, panX, panY } = computeFitView();
  state.zoom = zoom;
  state.pan.x = panX;
  state.pan.y = panY;
  scheduleRender();
}

function applyZoomTo(newZoomRaw, anchorX, anchorY) {
  const newZoom = Math.min(Math.max(newZoomRaw, state.minZoom), state.maxZoom);
  const worldX = (anchorX - state.pan.x) / state.zoom;
  const worldY = (anchorY - state.pan.y) / state.zoom;
  state.pan.x = anchorX - worldX * newZoom;
  state.pan.y = anchorY - worldY * newZoom;
  state.zoom = newZoom;
}

function getPhysicalPos(e) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) * state.dpr,
    y: (e.clientY - rect.top) * state.dpr,
  };
}

function updateGestureAnchors() {
  if (state.pointers.size === 1) {
    const pos = state.pointers.values().next().value;
    state.dragStart = { x: pos.x, y: pos.y, panX: state.pan.x, panY: state.pan.y };
    state.pinchLastDist = null;
  } else if (state.pointers.size === 2) {
    state.dragStart = null;
    const pts = Array.from(state.pointers.values());
    state.pinchLastDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  } else {
    state.dragStart = null;
    state.pinchLastDist = null;
  }
}

function onPointerDown(e) {
  canvas.setPointerCapture(e.pointerId);
  state.pointers.set(e.pointerId, getPhysicalPos(e));
  canvas.classList.add('panning');
  updateGestureAnchors();
}

function onPointerMove(e) {
  if (!state.pointers.has(e.pointerId)) return;
  const pos = getPhysicalPos(e);
  state.pointers.set(e.pointerId, pos);

  if (state.pointers.size === 1 && state.dragStart) {
    state.pan.x = state.dragStart.panX + (pos.x - state.dragStart.x);
    state.pan.y = state.dragStart.panY + (pos.y - state.dragStart.y);
    scheduleRender();
  } else if (state.pointers.size === 2 && state.pinchLastDist) {
    const pts = Array.from(state.pointers.values());
    const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    const midX = (pts[0].x + pts[1].x) / 2;
    const midY = (pts[0].y + pts[1].y) / 2;
    applyZoomTo(state.zoom * (dist / state.pinchLastDist), midX, midY);
    state.pinchLastDist = dist;
    scheduleRender();
  }
}

function onPointerUp(e) {
  state.pointers.delete(e.pointerId);
  if (canvas.hasPointerCapture && canvas.hasPointerCapture(e.pointerId)) {
    canvas.releasePointerCapture(e.pointerId);
  }
  if (state.pointers.size === 0) canvas.classList.remove('panning');
  updateGestureAnchors();
}

function onWheel(e) {
  e.preventDefault();
  const pos = getPhysicalPos(e);
  const rawFactor = Math.pow(1.0015, -e.deltaY);
  const scaleFactor = Math.min(Math.max(rawFactor, 0.8), 1.25);
  applyZoomTo(state.zoom * scaleFactor, pos.x, pos.y);
  scheduleRender();
}

/* ============================== DOM + INIT ============================== */

const moduloInput = document.getElementById('moduloInput');
const rowCountInput = document.getElementById('rowCountInput');
const memEstimateEl = document.getElementById('memEstimate');
const swatchesEl = document.getElementById('swatches');
const resetViewBtn = document.getElementById('resetViewBtn');

function clampInt(n, min, max) {
  if (!Number.isFinite(n)) return min;
  return Math.min(Math.max(Math.round(n), min), max);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function updateMemEstimate() {
  const bytes = state.residueData.length * state.residueData.BYTES_PER_ELEMENT;
  memEstimateEl.textContent = `~${formatBytes(bytes)} stored (${state.residueData.length.toLocaleString()} cells)`;
}

function rebuildColorPanel() {
  swatchesEl.innerHTML = '';
  for (let i = 0; i < state.palette.length; i++) {
    const row = document.createElement('div');
    row.className = 'swatch-row';

    const label = document.createElement('span');
    label.textContent = `mod → ${i}`;

    const input = document.createElement('input');
    input.type = 'color';
    input.value = state.palette[i];
    input.addEventListener('input', () => onSwatchInput(i, input.value));

    row.appendChild(label);
    row.appendChild(input);
    swatchesEl.appendChild(row);
  }
}

function onSwatchInput(index, hex) {
  state.palette[index] = hex;
  const { r, g, b } = hexToRgb(hex);
  state.paletteRGBA32[index] = packRGBA(r, g, b, 255);
  scheduleRender();
}

function regenerateData(modulo, rowCount) {
  const moduloChanged = modulo !== state.modulo || state.palette.length !== modulo;
  state.modulo = modulo;
  state.rowCount = rowCount;
  state.residueData = generateTriangle(rowCount, modulo);

  if (moduloChanged) {
    state.palette = buildDefaultPalette(modulo);
    state.paletteRGBA32 = buildPaletteRGBA32(state.palette);
    rebuildColorPanel();
  }

  recomputeZoomBounds();
  updateMemEstimate();
  scheduleRender();
}

function onModuloOrRowCountChange() {
  const modulo = clampInt(parseInt(moduloInput.value, 10), 1, 1000);
  const rowCount = clampInt(parseInt(rowCountInput.value, 10), 1, 20000);
  moduloInput.value = modulo;
  rowCountInput.value = rowCount;
  regenerateData(modulo, rowCount);
}

function resizeCanvasToViewport() {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const physW = Math.max(1, Math.round(rect.width * dpr));
  const physH = Math.max(1, Math.round(rect.height * dpr));

  state.dpr = dpr;
  state.physW = physW;
  state.physH = physH;

  canvas.width = physW;
  canvas.height = physH;
  canvas.style.width = `${rect.width}px`;
  canvas.style.height = `${rect.height}px`;

  state.imageData = ctx.createImageData(physW, physH);
  state.pixel32 = new Uint32Array(state.imageData.data.buffer);

  recomputeZoomBounds();
  scheduleRender();
}

function init() {
  resizeCanvasToViewport();
  onModuloOrRowCountChange();
  resetView();

  new ResizeObserver(() => resizeCanvasToViewport()).observe(canvas);

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });

  moduloInput.addEventListener('change', onModuloOrRowCountChange);
  rowCountInput.addEventListener('change', onModuloOrRowCountChange);
  resetViewBtn.addEventListener('click', resetView);
}

init();
