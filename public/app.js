import { fitCrop, parseGrid, selectionAspect, tileRects } from './grid-core.js';

const MAX_BYTES = 10 * 1024 * 1024;
const HANDLE_RADIUS = 9;
const OUTPUT_SIZE = 512;
const params = new URLSearchParams(window.location.search);
const configuredApiUrl =
  document.querySelector('meta[name="image-buddy-api"]')?.getAttribute('content') || '';
const configuredApi = configuredApiUrl ? new URL(configuredApiUrl) : null;
const token = configuredApi?.searchParams.get('token') || params.get('token') || '';

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
const gridOptions = document.querySelector('#grid-options');
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
const results = document.querySelector('#results');
const resultGrid = document.querySelector('#result-grid');
const copyAllButton = document.querySelector('#copy-all-button');

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
  previewCanvases: [],
  uploadedKeys: [],
};

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
  const extensions = /\.(jpe?g|png|webp|gif|bmp|ico|tiff?|heic)$/i;
  return file.type.startsWith('image/') || extensions.test(file.name);
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

function chooseFile(file) {
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

  if (state.imageUrl) URL.revokeObjectURL(state.imageUrl);
  const imageUrl = URL.createObjectURL(file);
  const image = new Image();
  image.onload = () => {
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
    generateLabel.textContent = `生成并上传 ${currentGrid().cols * currentGrid().rows} 张`;
    resetCrop();
    results.hidden = true;
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

function renderTileCanvases(size = OUTPUT_SIZE) {
  if (!state.image || !state.crop) return [];
  return sourceTileRects().map((tile) => {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext('2d');
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(
      state.image,
      tile.x,
      tile.y,
      tile.width,
      tile.height,
      0,
      0,
      size,
      size,
    );
    return canvas;
  });
}

function renderOutputPreview() {
  if (!state.image) {
    outputPreview.innerHTML = '<span>选择图片后显示</span>';
    return;
  }
  const { cols, rows } = currentGrid();
  const canvases = renderTileCanvases(256);
  const previewGrid = document.createElement('div');
  previewGrid.className = 'preview-grid';
  previewGrid.style.setProperty('--cols', cols);
  previewGrid.style.setProperty('--rows', rows);
  for (const canvas of canvases) previewGrid.append(canvas);
  outputPreview.replaceChildren(previewGrid);
  const width = Math.min(outputPreview.clientWidth - 28, 240);
  const gapRatio = state.mode === 'precut' ? state.gapRatio : 0;
  const tileSize = width / (cols + Math.max(0, cols - 1) * gapRatio);
  const gap = tileSize * gapRatio;
  const height = rows * tileSize + Math.max(0, rows - 1) * gap;
  previewGrid.style.width = `${width}px`;
  previewGrid.style.height = `${height}px`;
  previewGrid.style.gap = `${gap}px`;
  state.previewCanvases = canvases;
}

function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('无法生成 PNG'))),
      'image/png',
    );
  });
}

function uploadUrl() {
  const url = configuredApi
    ? new URL('/api/upload', configuredApi)
    : new URL('/api/upload', window.location.origin);
  url.searchParams.set('token', token);
  return url;
}

async function uploadBlob(blob, index) {
  const response = await fetch(uploadUrl(), {
    method: 'POST',
    headers: {
      'Content-Type': 'image/png',
      'X-File-Name': encodeURIComponent(`tile-${index + 1}.png`),
    },
    body: blob,
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.message || '上传失败');
  return result.imageKey;
}

async function generateAndUpload() {
  if (!state.image || generateButton.disabled) return;
  generateButton.disabled = true;
  spinner.hidden = false;
  results.hidden = true;
  setNotice();
  const canvases = renderTileCanvases();

  try {
    const uploaded = [];
    for (let index = 0; index < canvases.length; index += 1) {
      generateLabel.textContent = `正在上传 ${index + 1} / ${canvases.length}`;
      const blob = await canvasToBlob(canvases[index]);
      const imageKey = await uploadBlob(blob, index);
      uploaded.push({ canvas: canvases[index], blob, imageKey, index });
    }
    state.uploadedKeys = uploaded.map((item) => item.imageKey);
    renderResults(uploaded);
    setNotice(`已生成并上传 ${uploaded.length} 张图片`, 'success');
    results.hidden = false;
    results.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (error) {
    const message =
      error instanceof TypeError && error.message === 'Failed to fetch'
        ? '无法连接本机服务。请先打开文档下方备用入口，接受开发证书后返回重试。'
        : error.message || '生成失败，请稍后重试。';
    setNotice(message);
  } finally {
    spinner.hidden = true;
    generateButton.disabled = false;
    generateLabel.textContent = `生成并上传 ${canvases.length} 张`;
  }
}

function renderResults(uploaded) {
  resultGrid.innerHTML = '';
  for (const item of uploaded) {
    const card = document.createElement('article');
    card.className = 'result-card';
    const image = document.createElement('img');
    const url = URL.createObjectURL(item.blob);
    image.src = url;
    image.alt = `第 ${item.index + 1} 张切图`;
    image.onload = () => URL.revokeObjectURL(url);
    const header = document.createElement('div');
    header.className = 'result-card-header';
    const title = document.createElement('strong');
    title.textContent = `子图 ${item.index + 1}`;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'copy-key';
    button.textContent = '复制 Key';
    button.addEventListener('click', () => copyText(item.imageKey, button));
    const code = document.createElement('code');
    code.textContent = item.imageKey;
    header.append(title, button);
    card.append(image, header, code);
    resultGrid.append(card);
  }
}

async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const input = document.createElement('textarea');
    input.value = text;
    document.body.append(input);
    input.select();
    document.execCommand('copy');
    input.remove();
  }
  const original = button.textContent;
  button.textContent = '已复制';
  window.setTimeout(() => {
    button.textContent = original;
  }, 1200);
}

function setGrid(value) {
  state.grid = value;
  gridOptions.querySelectorAll('button').forEach((button) => {
    button.classList.toggle('selected', button.dataset.grid === value);
  });
  const { cols, rows } = currentGrid();
  tileCount.textContent = `${cols * rows} 张`;
  generateLabel.textContent = state.image ? `生成并上传 ${cols * rows} 张` : '选择图片后生成';
  if (state.image) resetCrop();
}

function setMode(value) {
  state.mode = value;
  gapControl.hidden = value !== 'precut';
  if (state.image) resetCrop();
}

uploadButton.addEventListener('click', () => fileInput.click());
emptyStage.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => chooseFile(fileInput.files?.[0]));
resetGridButton.addEventListener('click', resetCrop);
generateButton.addEventListener('click', generateAndUpload);
copyAllButton.addEventListener('click', () =>
  copyText(state.uploadedKeys.join('\n'), copyAllButton),
);

gridOptions.addEventListener('click', (event) => {
  const button = event.target.closest('[data-grid]');
  if (button) setGrid(button.dataset.grid);
});

modeOptions.addEventListener('change', (event) => {
  if (event.target.name === 'mode') setMode(event.target.value);
});

gapRatioInput.addEventListener('input', () => {
  state.gapRatio = Number(gapRatioInput.value) / 100;
  gapOutput.textContent = `${gapRatioInput.value}%`;
  if (state.image) resetCrop();
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

if (!token) {
  setNotice('当前链接缺少访问令牌，请使用服务启动时输出的完整 URL。');
  generateButton.disabled = true;
}
