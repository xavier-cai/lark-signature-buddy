import {
  createSignatureRecipe,
  encodeSignatureRecipe,
} from '@lark-signature-buddy/core/recipe';
import {
  fitCrop,
  MAX_GRID_COLS,
  MAX_GRID_ROWS,
  parseGrid,
  selectionAspect,
  tileRects,
} from '@lark-signature-buddy/core/grid';
import {
  frameToCanvas,
  openImageFrames,
} from '@lark-signature-buddy/core/animation';
import {
  DEFAULT_COLOR_MAPPING_GAMMA,
  preprocessLarkSignature,
  renderLarkMobile,
  renderLarkPc,
} from '@lark-signature-buddy/core/color-mapping';
import {
  FRAME_OPTION_GAP,
  FRAME_OPTION_STEP,
  FRAME_OPTION_WIDTH,
  visibleFrameRange,
} from './frame-window.js';
import { previewLayout } from './preview-layout.js';
import {
  movePreview,
  nextPreviewFrameIndex,
  zoomPreviewAtPoint,
} from './preview-transform.js';

const HANDLE_RADIUS = 9;
// Kept in the V1 recipe for wire compatibility. The bot derives the actual
// output dimensions from each crop and caps its longest edge at 50 px.
const LEGACY_OUTPUT_SIZE = 512;
const uploadButton = document.querySelector('#upload-button');
const fileInput = document.querySelector('#file-input');
const emptyStage = document.querySelector('#empty-stage');
const canvasStage = document.querySelector('#canvas-stage');
const editorCanvas = document.querySelector('#editor-canvas');
const editorContext = editorCanvas.getContext('2d');
const fileBar = document.querySelector('#file-bar');
const fileDetail = document.querySelector('#file-detail');
const resetGridButton = document.querySelector('#reset-grid');
const gridColsInput = document.querySelector('#grid-cols');
const gridRowsInput = document.querySelector('#grid-rows');
const frameSection = document.querySelector('#frame-section');
const frameCount = document.querySelector('#frame-count');
const framePicker = document.querySelector('#frame-picker');
const colorMappingInput = document.querySelector('#color-mapping');
const mappingGammaInput = document.querySelector('#mapping-gamma');
const mappingGammaOutput = document.querySelector('#mapping-gamma-output');
const previewGapRatioInput = document.querySelector('#preview-gap-ratio');
const previewGapOutput = document.querySelector('#preview-gap-output');
const precutGapRatioInput = document.querySelector('#precut-gap-ratio');
const precutGapOutput = document.querySelector('#precut-gap-output');
const outputPreview = document.querySelector('#output-preview');
const previewContent = document.querySelector('#preview-content');
const previewResetButton = document.querySelector('#preview-reset');
const previewPlatform = document.querySelector('.preview-platform');
const previewActualSizeInput = document.querySelector('#preview-actual-size');
const previewMaskInput = document.querySelector('#preview-mask');
const notice = document.querySelector('#notice');
const generateButton = document.querySelector('#generate-button');
const configOutput = document.querySelector('#config-output');
const configDetail = document.querySelector('#config-detail');
const configText = document.querySelector('#config-text');

const state = {
  file: null,
  image: null,
  imageUrl: null,
  animation: null,
  selectedFrame: 0,
  selectedFrameData: null,
  frameCanvas: null,
  mappedFrameCanvas: null,
  mappedFrameData: null,
  maskedFrameCanvas: null,
  maskedFrameData: null,
  preprocessedFrameData: null,
  previewTimer: null,
  previewGeneration: 0,
  framePickerGeneration: 0,
  framePickerRender: null,
  uploadGeneration: 0,
  colorMapping: true,
  colorMappingGamma: DEFAULT_COLOR_MAPPING_GAMMA,
  previewActualSize: true,
  previewMask: true,
  previewPlatform: 'pc',
  grid: '2x2',
  previewGapRatio: 0.58,
  previewTransform: { scale: 1, x: 0, y: 0 },
  previewDrag: null,
  precutGapRatio: 0.58,
  crop: null,
  display: null,
  drag: null,
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

function applyPreviewTransform() {
  const viewport = previewContent.querySelector('.preview-viewport');
  if (viewport) {
    const { scale, x, y } = state.previewTransform;
    viewport.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
  }
}

function resetPreviewTransform() {
  state.previewTransform = { scale: 1, x: 0, y: 0 };
  applyPreviewTransform();
}

function isSupported(file) {
  const extensions = /\.(jpe?g|png|webp|gif|apng|bmp|ico|tiff?|heic)$/i;
  return file.type.startsWith('image/') || extensions.test(file.name);
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('浏览器无法显示图片首帧'));
    image.src = url;
  });
}

function currentGrid() {
  return parseGrid(state.grid);
}

function currentAspect() {
  const { cols, rows } = currentGrid();
  return selectionAspect(cols, rows, 'precut', state.precutGapRatio);
}

function isAnimated() {
  return (state.animation?.frameCount || 0) > 1;
}

function sourceWidth() {
  return state.animation?.width || state.image?.naturalWidth || 0;
}

function sourceHeight() {
  return state.animation?.height || state.image?.naturalHeight || 0;
}

function sourceForFrame(index = state.selectedFrame, effect = 'original') {
  if (!state.animation) return state.image;
  const frame = index === state.selectedFrame
    ? state.selectedFrameData
    : state.animation.peekFrame(index);
  if (!frame) return null;
  const mapped = effect !== 'original';
  const targetCanvasKey = mapped ? 'maskedFrameCanvas' : 'frameCanvas';
  if (!state[targetCanvasKey]) {
    state[targetCanvasKey] = document.createElement('canvas');
    state[targetCanvasKey].width = state.animation.width;
    state[targetCanvasKey].height = state.animation.height;
  }
  let frameData = frame.data;
  if (mapped) {
    if (!state.preprocessedFrameData) {
      state.preprocessedFrameData = new Uint8ClampedArray(frame.data.length);
      state.maskedFrameData = new Uint8ClampedArray(frame.data.length);
    }
    const preprocessed = preprocessLarkSignature(
      frame.data,
      state.preprocessedFrameData,
      state.colorMappingGamma,
    );
    frameData = effect === 'mobile'
      ? renderLarkMobile(
        preprocessed,
        undefined,
        state.maskedFrameData,
      )
      : renderLarkPc(
        preprocessed,
        undefined,
        state.maskedFrameData,
      );
  }
  state[targetCanvasKey]
    .getContext('2d')
    .putImageData(
      new ImageData(
        frameData,
        state.animation.width,
        state.animation.height,
      ),
      0,
      0,
    );
  return state[targetCanvasKey];
}

function resetCrop() {
  if (!state.image) return;
  state.crop = fitCrop(
    sourceWidth(),
    sourceHeight(),
    currentAspect(),
  );
  drawEditor();
  renderOutputPreview();
}

async function selectFrame(index) {
  if (!state.animation || index < 0 || index >= state.animation.frameCount) return;
  const animation = state.animation;
  let frame;
  try {
    frame = await animation.getFrame(index);
  } catch (error) {
    setNotice(error.message || `无法读取第 ${index + 1} 帧。`);
    return;
  }
  if (state.animation !== animation) return;
  state.selectedFrame = index;
  state.selectedFrameData = frame;
  for (const button of framePicker.querySelectorAll('.frame-option')) {
    const selected = Number(button.dataset.frameIndex) === index;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-selected', String(selected));
  }
  drawEditor();
  renderOutputPreview();
}

function renderFramePicker() {
  state.framePickerGeneration += 1;
  const generation = state.framePickerGeneration;
  framePicker.replaceChildren();
  frameSection.hidden = !isAnimated();
  if (!isAnimated()) return;

  frameCount.textContent = `${state.animation.frameCount} 帧`;
  framePicker.scrollLeft = 0;
  const track = document.createElement('div');
  track.className = 'frame-picker-track';
  track.style.width =
    `${state.animation.frameCount * FRAME_OPTION_STEP - FRAME_OPTION_GAP}px`;
  framePicker.append(track);

  const paintWindow = () => {
    if (generation !== state.framePickerGeneration) return;
    const { start, end } = visibleFrameRange({
      scrollLeft: framePicker.scrollLeft,
      viewportWidth: framePicker.clientWidth,
      frameCount: state.animation.frameCount,
    });
    const fragment = document.createDocumentFragment();
    for (let index = start; index < end; index += 1) {
      const button = document.createElement('button');
      button.className = 'frame-option';
      button.style.left = `${index * FRAME_OPTION_STEP}px`;
      button.type = 'button';
      button.dataset.frameIndex = String(index);
      button.setAttribute('role', 'option');
      button.setAttribute('aria-label', `第 ${index + 1} 帧`);
      button.setAttribute('aria-selected', String(index === state.selectedFrame));
      if (index === state.selectedFrame) button.classList.add('selected');

      const thumbnail = document.createElement('canvas');
      thumbnail.width = FRAME_OPTION_WIDTH;
      thumbnail.height = 66;
      const label = document.createElement('span');
      label.textContent = `${index + 1}`;
      button.append(thumbnail, label);
      button.addEventListener('click', () => void selectFrame(index));
      fragment.append(button);

      const animation = state.animation;
      void animation.getFrame(index).then((frame) => {
        if (
          generation !== state.framePickerGeneration ||
          state.animation !== animation ||
          !button.isConnected
        ) return;
        button.setAttribute(
          'aria-label',
          `第 ${index + 1} 帧，停留 ${frame.delay} 毫秒`,
        );
        button.title = `第 ${index + 1} 帧 · ${frame.delay} ms`;
        const source = frameToCanvas(
          frame,
          animation.width,
          animation.height,
        );
        const context = thumbnail.getContext('2d');
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = 'high';
        const scale = Math.min(
          thumbnail.width / animation.width,
          thumbnail.height / animation.height,
        );
        const width = Math.max(1, Math.round(animation.width * scale));
        const height = Math.max(1, Math.round(animation.height * scale));
        context.drawImage(
          source,
          Math.round((thumbnail.width - width) / 2),
          Math.round((thumbnail.height - height) / 2),
          width,
          height,
        );
      }).catch(() => {});
    }
    track.replaceChildren(fragment);
  };
  state.framePickerRender = paintWindow;
  paintWindow();
}

async function chooseFile(file) {
  state.uploadGeneration += 1;
  const generation = state.uploadGeneration;
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
  setNotice('正在读取图片信息…', 'success');
  await new Promise((resolve) => requestAnimationFrame(resolve));
  let animation;
  try {
    animation = await openImageFrames(file);
  } catch (error) {
    setNotice(error.message || '无法读取图片内容，请换一张图片。');
    return;
  }

  if (generation !== state.uploadGeneration) {
    animation.close();
    return;
  }
  state.animation?.close();
  if (state.imageUrl?.startsWith('blob:')) URL.revokeObjectURL(state.imageUrl);
  let first;
  try {
    first = await animation.getFrame(0);
  } catch (error) {
    animation.close();
    setNotice(error.message || '无法读取图片首帧，请换一张图片。');
    return;
  }
  if (generation !== state.uploadGeneration) {
    animation.close();
    return;
  }
  const firstFrame = frameToCanvas(
    first,
    animation.width,
    animation.height,
  );
  const imageUrl = firstFrame.toDataURL('image/png');
  try {
    const image = await loadImage(imageUrl);
    if (generation !== state.uploadGeneration) {
      animation.close();
      return;
    }
    state.file = file;
    state.image = image;
    state.imageUrl = imageUrl;
    state.animation = animation;
    state.selectedFrame = 0;
    state.selectedFrameData = first;
    state.frameCanvas = null;
    state.mappedFrameCanvas = null;
    state.mappedFrameData = null;
    state.maskedFrameCanvas = null;
    state.maskedFrameData = null;
    state.preprocessedFrameData = null;
    state.previewTransform = { scale: 1, x: 0, y: 0 };
    state.previewDrag = null;
    fileDetail.textContent =
      `${image.naturalWidth} × ${image.naturalHeight} · ${animation.frameCount} 帧 · ${formatBytes(file.size)}`;
    emptyStage.hidden = true;
    canvasStage.hidden = false;
    fileBar.hidden = false;
    generateButton.disabled = false;
    configOutput.hidden = true;
    renderFramePicker();
    resetCrop();
    setNotice();
  } catch (error) {
    animation.close();
    setNotice(error.message);
  }
}

function layoutCanvas() {
  if (!state.image) return null;
  const maxWidth = Math.max(320, canvasStage.clientWidth);
  const maxHeight = 550;
  const scale = Math.min(
    maxWidth / sourceWidth(),
    maxHeight / sourceHeight(),
  );
  const width = Math.max(1, Math.round(sourceWidth() * scale));
  const height = Math.max(1, Math.round(sourceHeight() * scale));
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
  const imageAspect = sourceWidth() / sourceHeight();
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
  const source = sourceForFrame();
  editorContext.clearRect(0, 0, width, height);
  editorContext.drawImage(source, 0, 0, width, height);

  const rect = cropToDisplay();
  editorContext.save();
  editorContext.fillStyle = 'rgba(6, 9, 16, 0.62)';
  editorContext.fillRect(0, 0, width, height);
  editorContext.clearRect(rect.x, rect.y, rect.width, rect.height);
  editorContext.drawImage(
    source,
    state.crop.x * sourceWidth(),
    state.crop.y * sourceHeight(),
    state.crop.width * sourceWidth(),
    state.crop.height * sourceHeight(),
    rect.x,
    rect.y,
    rect.width,
    rect.height,
  );

  const { cols, rows } = currentGrid();
  const rects = tileRects(
    state.crop,
    cols,
    rows,
    'precut',
    state.precutGapRatio,
  );
  editorContext.fillStyle = 'rgba(246, 247, 251, 0.94)';
  editorContext.fillRect(rect.x, rect.y, rect.width, rect.height);
  for (const tile of rects) {
    const displayTile = cropToDisplay(tile);
    editorContext.drawImage(
      source,
      tile.x * sourceWidth(),
      tile.y * sourceHeight(),
      tile.width * sourceWidth(),
      tile.height * sourceHeight(),
      displayTile.x,
      displayTile.y,
      displayTile.width,
      displayTile.height,
    );
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
  return tileRects(
    state.crop,
    cols,
    rows,
    'precut',
    state.precutGapRatio,
  ).map((tile) => ({
    ...tile,
    x: tile.x * sourceWidth(),
    y: tile.y * sourceHeight(),
    width: tile.width * sourceWidth(),
    height: tile.height * sourceHeight(),
  }));
}

function renderOutputPreview() {
  state.previewGeneration += 1;
  const generation = state.previewGeneration;
  if (state.previewTimer) {
    clearTimeout(state.previewTimer);
    state.previewTimer = null;
  }
  if (!state.image) {
    outputPreview.classList.remove('preview-ready');
    previewContent.innerHTML = '<span>选择图片后显示</span>';
    applyPreviewTransform();
    return;
  }
  outputPreview.classList.add('preview-ready');
  const { cols, rows } = currentGrid();
  const availableWidth = Math.max(188, outputPreview.clientWidth - 28);
  const {
    tileSize,
    gap,
    width,
    height,
  } = previewLayout({
    cols,
    rows,
    gapRatio: state.previewGapRatio,
    availableWidth,
    actualSize: state.previewActualSize,
  });
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const tiles = sourceTileRects();

  const preview = document.createElement('canvas');
  preview.className = 'preview-composite';
  preview.width = Math.round(width * dpr);
  preview.height = Math.round(height * dpr);
  preview.style.width = `${width}px`;
  preview.style.height = `${height}px`;
  const context = preview.getContext('2d');
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';

  const drawFrame = async (frameIndex) => {
    const animation = state.animation;
    const frame = await animation.getFrame(frameIndex);
    if (generation !== state.previewGeneration || state.animation !== animation) {
      return null;
    }
    context.clearRect(0, 0, width, height);
    if (state.previewMask) {
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, width, height);
    }
    const source = sourceForFrame(
      frameIndex,
      state.previewMask ? state.previewPlatform : 'original',
    );
    for (const tile of tiles) {
      const x = tile.col * (tileSize + gap);
      const y = tile.row * (tileSize + gap);
      context.drawImage(
        source,
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
    return frame;
  };
  const viewport = document.createElement('div');
  viewport.className = 'preview-viewport';
  viewport.append(preview);
  previewContent.replaceChildren(viewport);
  applyPreviewTransform();
  if (isAnimated() && state.previewPlatform !== 'mobile') {
    let frameIndex = state.selectedFrame;
    const scheduleNextFrame = async () => {
      const frame = await drawFrame(frameIndex);
      if (!frame) return;
      state.previewTimer = setTimeout(() => {
        if (generation !== state.previewGeneration) return;
        frameIndex = nextPreviewFrameIndex(
          frameIndex,
          state.animation.frameCount,
        );
        void scheduleNextFrame();
      }, frame.delay);
    };
    void scheduleNextFrame();
  } else {
    void drawFrame(0);
  }
}

function currentRecipeToken() {
  const { cols, rows } = currentGrid();
  return encodeSignatureRecipe(
    createSignatureRecipe({
      sourceWidth: sourceWidth(),
      sourceHeight: sourceHeight(),
      sourceFrames: state.animation.frameCount,
      cols,
      rows,
      crop: state.crop,
      mode: 'precut',
      gapRatio: state.precutGapRatio,
      colorMapping: state.colorMapping,
      colorMappingGamma: state.colorMappingGamma,
      outputSize: LEGACY_OUTPUT_SIZE,
      contentRect: {
        x: 0,
        y: 0,
        width: 1,
        height: 1,
      },
    }),
  );
}

async function copyConfigText(token) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(token);
    return true;
  }
  configText.select();
  return document.execCommand('copy');
}

async function createSignatureConfig() {
  if (!state.image || !state.file || !state.crop || generateButton.disabled) return;
  generateButton.disabled = true;
  setNotice();
  try {
    const token = currentRecipeToken();
    configText.value = token;
    configDetail.textContent = `${token.length} 字符`;
    configOutput.hidden = false;
    const copied = await copyConfigText(token);
    setNotice(
      copied
        ? '配置字符串已复制；请将原图片和配置字符串发送给 Buddy Bot。'
        : '配置字符串已生成；请从下方文本框复制后与原图片一起发送给 Buddy Bot。',
      'success',
    );
  } catch (error) {
    configText.select();
    setNotice(
      configText.value
        ? '配置字符串已生成；自动复制失败，请从下方文本框手动复制。'
        : error.message || '配置字符串生成失败，请稍后重试。',
    );
  } finally {
    generateButton.disabled = false;
  }
}

function setGrid(cols, rows) {
  state.grid = `${cols}x${rows}`;
  if (state.image) resetCrop();
}

uploadButton.addEventListener('click', () => fileInput.click());
emptyStage.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => chooseFile(fileInput.files?.[0]));
resetGridButton.addEventListener('click', resetCrop);
generateButton.addEventListener('click', createSignatureConfig);
colorMappingInput.addEventListener('change', () => {
  state.colorMapping = colorMappingInput.checked;
  colorMappingInput
    .closest('.switch-control')
    .querySelector('em').textContent = state.colorMapping ? '开启' : '关闭';
  if (state.image) renderOutputPreview();
});
mappingGammaInput.addEventListener('input', () => {
  state.colorMappingGamma = Number(mappingGammaInput.value) / 100;
  mappingGammaOutput.textContent = state.colorMappingGamma.toFixed(2);
  if (state.image) renderOutputPreview();
});
previewMaskInput.addEventListener('change', () => {
  state.previewMask = previewMaskInput.checked;
  if (state.image) renderOutputPreview();
});
previewPlatform.addEventListener('click', (event) => {
  const button = event.target.closest('[data-platform]');
  if (!button) return;
  state.previewPlatform = button.dataset.platform;
  for (const candidate of previewPlatform.querySelectorAll('[data-platform]')) {
    candidate.classList.toggle('active', candidate === button);
  }
  if (state.image) renderOutputPreview();
});
previewActualSizeInput.addEventListener('change', () => {
  state.previewActualSize = previewActualSizeInput.checked;
  if (state.image) renderOutputPreview();
});

function updateGridFromInputs({ commit = false } = {}) {
  let cols = gridColsInput.valueAsNumber;
  let rows = gridRowsInput.valueAsNumber;
  if (commit) {
    cols = Math.max(
      1,
      Math.min(MAX_GRID_COLS, Number.isFinite(cols) ? Math.round(cols) : 1),
    );
    rows = Math.max(
      1,
      Math.min(MAX_GRID_ROWS, Number.isFinite(rows) ? Math.round(rows) : 1),
    );
    gridColsInput.value = String(cols);
    gridRowsInput.value = String(rows);
  }
  if (!Number.isInteger(cols) || cols < 1 || cols > MAX_GRID_COLS) return;
  if (!Number.isInteger(rows) || rows < 1 || rows > MAX_GRID_ROWS) return;
  setGrid(cols, rows);
}

for (const input of [gridColsInput, gridRowsInput]) {
  input.addEventListener('input', () => updateGridFromInputs());
  input.addEventListener('change', () => updateGridFromInputs({ commit: true }));
  input.addEventListener('blur', () => updateGridFromInputs({ commit: true }));
}

previewGapRatioInput.addEventListener('input', () => {
  state.previewGapRatio = Number(previewGapRatioInput.value) / 100;
  previewGapOutput.textContent = `${previewGapRatioInput.value}%`;
  if (state.image) renderOutputPreview();
});

outputPreview.addEventListener('wheel', (event) => {
  if (!state.image) return;
  event.preventDefault();
  const bounds = outputPreview.getBoundingClientRect();
  state.previewTransform = zoomPreviewAtPoint(
    state.previewTransform,
    event.deltaY < 0 ? 1.1 : 1 / 1.1,
    {
      x: event.clientX - bounds.left - bounds.width / 2,
      y: event.clientY - bounds.top - bounds.height / 2,
    },
  );
  applyPreviewTransform();
}, { passive: false });

outputPreview.addEventListener('pointerdown', (event) => {
  if (!state.image || event.button !== 0 || event.target.closest('#preview-reset')) {
    return;
  }
  outputPreview.setPointerCapture(event.pointerId);
  state.previewDrag = { x: event.clientX, y: event.clientY };
  outputPreview.classList.add('dragging');
});

outputPreview.addEventListener('pointermove', (event) => {
  if (!state.previewDrag) return;
  state.previewTransform = movePreview(state.previewTransform, {
    x: event.clientX - state.previewDrag.x,
    y: event.clientY - state.previewDrag.y,
  });
  state.previewDrag = { x: event.clientX, y: event.clientY };
  applyPreviewTransform();
});

function finishPreviewDrag(event) {
  if (!state.previewDrag) return;
  state.previewDrag = null;
  outputPreview.classList.remove('dragging');
  if (outputPreview.hasPointerCapture(event.pointerId)) {
    outputPreview.releasePointerCapture(event.pointerId);
  }
}

outputPreview.addEventListener('pointerup', finishPreviewDrag);
outputPreview.addEventListener('pointercancel', finishPreviewDrag);
previewResetButton.addEventListener('click', resetPreviewTransform);

precutGapRatioInput.addEventListener('input', () => {
  state.precutGapRatio = Number(precutGapRatioInput.value) / 100;
  precutGapOutput.textContent = `${precutGapRatioInput.value}%`;
  if (state.image) {
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
  if (!state.image) return;
  drawEditor();
  renderOutputPreview();
  state.framePickerRender?.();
});

let framePickerFrame = null;
framePicker.addEventListener('scroll', () => {
  if (framePickerFrame !== null) return;
  framePickerFrame = requestAnimationFrame(() => {
    framePickerFrame = null;
    state.framePickerRender?.();
  });
});
