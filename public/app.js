import {
  createImageRecipe,
  encodeImageRecipe,
} from './image-recipe.js';
import {
  compositionUnits,
  fitCrop,
  parseGrid,
  selectionAspect,
  tileRects,
} from './grid-core.js';
import {
  isAnimatedImageBytes,
  validateStaticImageSize,
} from './image-format.js';
import { embedRecipeInPng } from './png-recipe.js';

const MAX_BYTES = 10 * 1024 * 1024;
const HANDLE_RADIUS = 9;
const OUTPUT_SIZE = 512;

const uploadButton = document.querySelector('#upload-button');
const uploadButtonLabel = document.querySelector('#upload-button-label');
const fileInput = document.querySelector('#file-input');
const emptyStage = document.querySelector('#empty-stage');
const canvasStage = document.querySelector('#canvas-stage');
const editorCanvas = document.querySelector('#editor-canvas');
const editorContext = editorCanvas.getContext('2d');
const fileName = document.querySelector('#file-name');
const fileDetail = document.querySelector('#file-detail');
const resetGridButton = document.querySelector('#reset-grid');
const gridColsInput = document.querySelector('#grid-cols');
const gridRowsInput = document.querySelector('#grid-rows');
const tileCount = document.querySelector('#tile-count');
const modeOptions = document.querySelector('#mode-options');
const gapControl = document.querySelector('#gap-control');
const gapRatioInput = document.querySelector('#gap-ratio');
const gapOutput = document.querySelector('#gap-output');
const outputPreview = document.querySelector('#output-preview');
const notice = document.querySelector('#notice');
const generateButton = document.querySelector('#generate-button');
const generateLabel = document.querySelector('#generate-label');
const spinner = document.querySelector('#spinner');

const state = {
  file: null,
  image: null,
  imageUrl: null,
  grid: '2x2',
  mode: 'plain',
  gapRatio: 0.58,
  crop: null,
  display: null,
  drag: null,
};

function updateCopyLabel() {
  if (!state.image) {
    generateLabel.textContent = '选择图片后即可复制含参数原图';
    return;
  }
  generateLabel.textContent = '复制含参数原图 PNG';
}

function formatBytes(size) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(2)} MB`;
}

function setNotice(message = '', type = 'error') {
  notice.textContent = message;
  notice.classList.toggle('success', type === 'success');
}

function isSupported(file) {
  const extensions = /\.(jpe?g|png|webp|bmp|ico|tiff?|heic)$/i;
  return file.type.startsWith('image/') || extensions.test(file.name);
}

async function isAnimatedImage(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return isAnimatedImageBytes(bytes);
}

function currentGrid() {
  return parseGrid(state.grid);
}

function currentAspect() {
  const { cols, rows } = currentGrid();
  return selectionAspect(cols, rows, state.mode, state.gapRatio);
}

function resetCrop() {
  if (!state.image) return;
  state.crop = fitCrop(
    state.image.naturalWidth,
    state.image.naturalHeight,
    currentAspect(),
  );
  drawEditor();
  renderOutputPreview();
}

async function chooseFile(file) {
  setNotice();
  if (!file) return;
  if (!isSupported(file)) {
    setNotice('不支持该文件格式，请换一张图片。');
    return;
  }
  if (file.size === 0) {
    setNotice('图片内容为空，请换一张图片。');
    return;
  }
  if (file.size > MAX_BYTES) {
    setNotice('图片超过 10 MB，请压缩后再上传。');
    return;
  }
  let animated;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    animated = isAnimatedImageBytes(bytes);
  } catch {
    setNotice('无法读取图片内容，请换一张图片。');
    return;
  }
  if (animated) {
    setNotice('当前 V1 暂不支持 GIF、APNG 或 Animated WebP 动图。');
    return;
  }

  if (state.imageUrl) URL.revokeObjectURL(state.imageUrl);
  const imageUrl = URL.createObjectURL(file);
  const image = new Image();
  image.onload = () => {
    try {
      validateStaticImageSize(image.naturalWidth, image.naturalHeight);
    } catch (error) {
      URL.revokeObjectURL(imageUrl);
      setNotice(error.message);
      return;
    }
    state.file = file;
    state.image = image;
    state.imageUrl = imageUrl;
    fileName.textContent = file.name || '粘贴的图片';
    fileDetail.textContent = `${image.naturalWidth} × ${image.naturalHeight} · ${formatBytes(file.size)}`;
    uploadButtonLabel.textContent = '换一张图片';
    emptyStage.hidden = true;
    canvasStage.hidden = false;
    resetGridButton.disabled = false;
    generateButton.disabled = false;
    updateCopyLabel();
    resetCrop();
  };
  image.onerror = () => {
    URL.revokeObjectURL(imageUrl);
    setNotice('浏览器无法解码该图片，请换成 JPG、PNG、WEBP 或 GIF。');
  };
  image.src = imageUrl;
}

function layoutCanvas() {
  if (!state.image) return null;
  const maxWidth = Math.max(320, canvasStage.clientWidth);
  const maxHeight = 550;
  const scale = Math.min(
    maxWidth / state.image.naturalWidth,
    maxHeight / state.image.naturalHeight,
  );
  const width = Math.max(1, Math.round(state.image.naturalWidth * scale));
  const height = Math.max(1, Math.round(state.image.naturalHeight * scale));
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  editorCanvas.width = Math.round(width * dpr);
  editorCanvas.height = Math.round(height * dpr);
  editorCanvas.style.width = `${width}px`;
  editorCanvas.style.height = `${height}px`;
  editorContext.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { width, height, dpr };
}

function cropToDisplay(crop = state.crop) {
  if (!state.display || !crop) return null;
  const imageAspect = state.image.naturalWidth / state.image.naturalHeight;
  return {
    x: crop.x * state.display.width,
    y: crop.y * state.display.height,
    width: crop.width * state.display.width,
    height: crop.height * state.display.height,
    imageAspect,
  };
}

function displayToCrop(rect) {
  return {
    x: rect.x / state.display.width,
    y: rect.y / state.display.height,
    width: rect.width / state.display.width,
    height: rect.height / state.display.height,
  };
}

function drawEditor() {
  if (!state.image || !state.crop) return;
  state.display = layoutCanvas();
  const { width, height } = state.display;
  editorContext.clearRect(0, 0, width, height);
  editorContext.drawImage(state.image, 0, 0, width, height);

  const rect = cropToDisplay();
  editorContext.save();
  editorContext.fillStyle = 'rgba(6, 9, 16, 0.62)';
  editorContext.fillRect(0, 0, width, height);
  editorContext.clearRect(rect.x, rect.y, rect.width, rect.height);
  editorContext.drawImage(
    state.image,
    state.crop.x * state.image.naturalWidth,
    state.crop.y * state.image.naturalHeight,
    state.crop.width * state.image.naturalWidth,
    state.crop.height * state.image.naturalHeight,
    rect.x,
    rect.y,
    rect.width,
    rect.height,
  );

  const { cols, rows } = currentGrid();
  const rects = tileRects(state.crop, cols, rows, state.mode, state.gapRatio);
  if (state.mode === 'precut') {
    editorContext.fillStyle = 'rgba(246, 247, 251, 0.94)';
    editorContext.fillRect(rect.x, rect.y, rect.width, rect.height);
    for (const tile of rects) {
      const displayTile = cropToDisplay(tile);
      editorContext.drawImage(
        state.image,
        tile.x * state.image.naturalWidth,
        tile.y * state.image.naturalHeight,
        tile.width * state.image.naturalWidth,
        tile.height * state.image.naturalHeight,
        displayTile.x,
        displayTile.y,
        displayTile.width,
        displayTile.height,
      );
    }
  }
  editorContext.strokeStyle = '#ffffff';
  editorContext.lineWidth = 2;
  editorContext.shadowColor = 'rgba(0, 0, 0, 0.55)';
  editorContext.shadowBlur = 5;
  for (const tile of rects) {
    const displayTile = cropToDisplay(tile);
    editorContext.strokeRect(
      displayTile.x,
      displayTile.y,
      displayTile.width,
      displayTile.height,
    );
  }
  editorContext.shadowBlur = 0;
  editorContext.strokeStyle = '#2f6cff';
  editorContext.lineWidth = 2.5;
  editorContext.strokeRect(rect.x, rect.y, rect.width, rect.height);

  for (const handle of handlePoints(rect)) {
    editorContext.beginPath();
    editorContext.arc(handle.x, handle.y, HANDLE_RADIUS, 0, Math.PI * 2);
    editorContext.fillStyle = '#ffffff';
    editorContext.fill();
    editorContext.strokeStyle = '#2f6cff';
    editorContext.lineWidth = 3;
    editorContext.stroke();
  }
  editorContext.restore();
}

function handlePoints(rect) {
  return [
    { name: 'nw', x: rect.x, y: rect.y },
    { name: 'ne', x: rect.x + rect.width, y: rect.y },
    { name: 'sw', x: rect.x, y: rect.y + rect.height },
    { name: 'se', x: rect.x + rect.width, y: rect.y + rect.height },
  ];
}

function canvasPoint(event) {
  const bounds = editorCanvas.getBoundingClientRect();
  return {
    x: ((event.clientX - bounds.left) / bounds.width) * state.display.width,
    y: ((event.clientY - bounds.top) / bounds.height) * state.display.height,
  };
}

function hitTest(point) {
  const rect = cropToDisplay();
  for (const handle of handlePoints(rect)) {
    if (Math.hypot(point.x - handle.x, point.y - handle.y) <= HANDLE_RADIUS * 2) {
      return { type: 'resize', handle: handle.name };
    }
  }
  if (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  ) {
    return { type: 'move' };
  }
  return null;
}

function resizeFromHandle(point, drag) {
  const start = drag.startRect;
  const aspectDisplay = start.width / start.height;
  const opposite = {
    nw: { x: start.x + start.width, y: start.y + start.height, sx: -1, sy: -1 },
    ne: { x: start.x, y: start.y + start.height, sx: 1, sy: -1 },
    sw: { x: start.x + start.width, y: start.y, sx: -1, sy: 1 },
    se: { x: start.x, y: start.y, sx: 1, sy: 1 },
  }[drag.handle];
  let width = Math.abs(point.x - opposite.x);
  let height = width / aspectDisplay;
  if (height > Math.abs(point.y - opposite.y)) {
    height = Math.abs(point.y - opposite.y);
    width = height * aspectDisplay;
  }
  const minWidth = Math.min(80, state.display.width * 0.2);
  width = Math.max(minWidth, width);
  height = width / aspectDisplay;
  width = Math.min(width, opposite.sx > 0 ? state.display.width - opposite.x : opposite.x);
  height = width / aspectDisplay;
  if (height > (opposite.sy > 0 ? state.display.height - opposite.y : opposite.y)) {
    height = opposite.sy > 0 ? state.display.height - opposite.y : opposite.y;
    width = height * aspectDisplay;
  }
  return {
    x: opposite.sx > 0 ? opposite.x : opposite.x - width,
    y: opposite.sy > 0 ? opposite.y : opposite.y - height,
    width,
    height,
  };
}

function updateDrag(event) {
  if (!state.drag) return;
  const point = canvasPoint(event);
  if (state.drag.type === 'move') {
    const dx = point.x - state.drag.startPoint.x;
    const dy = point.y - state.drag.startPoint.y;
    const rect = state.drag.startRect;
    state.crop = displayToCrop({
      ...rect,
      x: Math.max(0, Math.min(state.display.width - rect.width, rect.x + dx)),
      y: Math.max(0, Math.min(state.display.height - rect.height, rect.y + dy)),
    });
  } else {
    state.crop = displayToCrop(resizeFromHandle(point, state.drag));
  }
  drawEditor();
  renderOutputPreview();
}

function sourceTileRects() {
  const { cols, rows } = currentGrid();
  return tileRects(state.crop, cols, rows, state.mode, state.gapRatio).map((tile) => ({
    ...tile,
    x: tile.x * state.image.naturalWidth,
    y: tile.y * state.image.naturalHeight,
    width: tile.width * state.image.naturalWidth,
    height: tile.height * state.image.naturalHeight,
  }));
}

function renderOutputPreview() {
  if (!state.image) {
    outputPreview.innerHTML = '<span>选择图片后显示</span>';
    return;
  }
  const { cols, rows } = currentGrid();
  const width = Math.min(outputPreview.clientWidth - 28, 240);
  const { widthUnits, heightUnits } = compositionUnits(cols, rows, state.gapRatio);
  const tileSize = width / widthUnits;
  const gap = tileSize * state.gapRatio;
  const height = heightUnits * tileSize;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const preview = document.createElement('canvas');
  preview.className = 'preview-composite';
  preview.width = Math.round(width * dpr);
  preview.height = Math.round(height * dpr);
  preview.style.width = `${width}px`;
  preview.style.height = `${height}px`;
  const context = preview.getContext('2d');
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, width, height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  const tiles = sourceTileRects();
  for (const tile of tiles) {
    const x = tile.col * (tileSize + gap);
    const y = tile.row * (tileSize + gap);
    context.drawImage(
      state.image,
      tile.x,
      tile.y,
      tile.width,
      tile.height,
      x,
      y,
      tileSize,
      tileSize,
    );
  }
  outputPreview.replaceChildren(preview);
}

function currentRecipeToken() {
  const { cols, rows } = currentGrid();
  return encodeImageRecipe(
    createImageRecipe({
      sourceWidth: state.image.naturalWidth,
      sourceHeight: state.image.naturalHeight,
      cols,
      rows,
      crop: state.crop,
      mode: state.mode,
      gapRatio: state.gapRatio,
      outputSize: OUTPUT_SIZE,
    }),
  );
}

function dataUrlToBytes(dataUrl) {
  const encoded = dataUrl.slice(dataUrl.indexOf(',') + 1);
  return Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
}

function bytesToDataUrl(bytes) {
  const chunkSize = 32768;
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(
      String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)),
    );
  }
  return `data:image/png;base64,${btoa(chunks.join(''))}`;
}

function buildTransportImage() {
  const canvas = document.createElement('canvas');
  canvas.width = state.image.naturalWidth;
  canvas.height = state.image.naturalHeight;
  const context = canvas.getContext('2d');
  context.drawImage(state.image, 0, 0);
  const pngBytes = dataUrlToBytes(canvas.toDataURL('image/png'));
  if (pngBytes.length > 20 * 1024 * 1024) {
    throw new Error('转换后的 PNG 超过 20 MB，请缩小图片后重试');
  }
  const encoded = embedRecipeInPng(pngBytes, currentRecipeToken());
  const blob = new Blob([encoded], { type: 'image/png' });
  return {
    blob,
    dataUrl: bytesToDataUrl(encoded),
  };
}

function legacyCopyImage(imageUrl) {
  const container = document.createElement('div');
  container.contentEditable = 'true';
  container.setAttribute('aria-hidden', 'true');
  Object.assign(container.style, {
    position: 'fixed',
    left: '-10000px',
    top: '0',
    opacity: '0.01',
    pointerEvents: 'none',
  });
  const image = document.createElement('img');
  image.src = imageUrl;
  image.alt = '';
  container.append(image);
  document.body.append(container);
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(container);
  selection.removeAllRanges();
  selection.addRange(range);
  const copied = document.execCommand('copy');
  selection.removeAllRanges();
  container.remove();
  return copied;
}

function startAsyncCopyImage(blob) {
  if (!navigator.clipboard?.write || !window.ClipboardItem) return null;
  try {
    return navigator.clipboard
      .write([
        new ClipboardItem({ 'image/png': blob }),
      ])
      .then(
        () => true,
        () => false,
      );
  } catch {
    return null;
  }
}

async function copyImageRecipe() {
  if (!state.image || !state.file || !state.crop || generateButton.disabled) return;
  generateButton.disabled = true;
  spinner.hidden = false;
  setNotice();
  try {
    const { blob, dataUrl } = buildTransportImage();
    const legacyCopied = legacyCopyImage(dataUrl);
    const clipboardPromise = startAsyncCopyImage(blob);
    const copied = clipboardPromise
      ? (await clipboardPromise) || legacyCopied
      : legacyCopied;
    if (!copied) {
      throw new Error('当前飞书文档不允许复制图片');
    }
    setNotice('已复制含切图参数的原图 PNG，请粘贴发送给图片仔验证', 'success');
  } catch (error) {
    setNotice(error.message || '复制失败，请稍后重试。');
  } finally {
    spinner.hidden = true;
    generateButton.disabled = false;
    updateCopyLabel();
  }
}

function setGrid(cols, rows) {
  state.grid = `${cols}x${rows}`;
  const grid = currentGrid();
  tileCount.textContent = `${grid.cols * grid.rows} 张`;
  updateCopyLabel();
  if (state.image) resetCrop();
}

function setMode(value) {
  state.mode = value;
  if (state.image) resetCrop();
}

uploadButton.addEventListener('click', () => fileInput.click());
emptyStage.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => chooseFile(fileInput.files?.[0]));
resetGridButton.addEventListener('click', resetCrop);
generateButton.addEventListener('click', copyImageRecipe);

function updateGridFromInputs({ commit = false } = {}) {
  let cols = gridColsInput.valueAsNumber;
  let rows = gridRowsInput.valueAsNumber;
  if (commit) {
    cols = Math.max(1, Math.min(15, Number.isFinite(cols) ? Math.round(cols) : 1));
    rows = Math.max(1, Math.min(15, Number.isFinite(rows) ? Math.round(rows) : 1));
    gridColsInput.value = String(cols);
    gridRowsInput.value = String(rows);
  }
  if (!Number.isInteger(cols) || cols < 1 || cols > 15) return;
  if (!Number.isInteger(rows) || rows < 1 || rows > 15) return;
  setGrid(cols, rows);
}

for (const input of [gridColsInput, gridRowsInput]) {
  input.addEventListener('input', () => updateGridFromInputs());
  input.addEventListener('change', () => updateGridFromInputs({ commit: true }));
  input.addEventListener('blur', () => updateGridFromInputs({ commit: true }));
}

modeOptions.addEventListener('change', (event) => {
  if (event.target.name === 'mode') setMode(event.target.value);
});

gapRatioInput.addEventListener('input', () => {
  state.gapRatio = Number(gapRatioInput.value) / 100;
  gapOutput.textContent = `${gapRatioInput.value}%`;
  if (!state.image) return;
  if (state.mode === 'precut') {
    resetCrop();
  } else {
    drawEditor();
    renderOutputPreview();
  }
});

for (const target of [emptyStage, canvasStage]) {
  for (const eventName of ['dragenter', 'dragover']) {
    target.addEventListener(eventName, (event) => {
      event.preventDefault();
      emptyStage.classList.add('dragging');
    });
  }
  for (const eventName of ['dragleave', 'drop']) {
    target.addEventListener(eventName, (event) => {
      event.preventDefault();
      emptyStage.classList.remove('dragging');
    });
  }
  target.addEventListener('drop', (event) => chooseFile(event.dataTransfer?.files?.[0]));
}

editorCanvas.addEventListener('pointerdown', (event) => {
  if (!state.crop) return;
  const point = canvasPoint(event);
  const hit = hitTest(point);
  if (!hit) return;
  editorCanvas.setPointerCapture(event.pointerId);
  state.drag = {
    ...hit,
    startPoint: point,
    startRect: cropToDisplay(),
  };
});
editorCanvas.addEventListener('pointermove', updateDrag);
editorCanvas.addEventListener('pointerup', () => {
  state.drag = null;
});
editorCanvas.addEventListener('pointercancel', () => {
  state.drag = null;
});
editorCanvas.addEventListener('pointermove', (event) => {
  if (state.drag) return;
  const hit = hitTest(canvasPoint(event));
  editorCanvas.style.cursor = hit?.type === 'resize' ? 'nwse-resize' : hit ? 'move' : 'default';
});

window.addEventListener('paste', (event) => {
  const item = Array.from(event.clipboardData?.items || []).find((candidate) =>
    candidate.type.startsWith('image/'),
  );
  if (item) chooseFile(item.getAsFile());
});

window.addEventListener('resize', () => {
  if (state.image) drawEditor();
});
