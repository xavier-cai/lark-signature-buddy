const MAX_BYTES = 10 * 1024 * 1024;
const params = new URLSearchParams(window.location.search);
const token = params.get('token') || '';

const dropZone = document.querySelector('#drop-zone');
const fileInput = document.querySelector('#file-input');
const previewCard = document.querySelector('#preview-card');
const previewImage = document.querySelector('#preview-image');
const fileName = document.querySelector('#file-name');
const fileDetail = document.querySelector('#file-detail');
const replaceButton = document.querySelector('#replace-button');
const uploadButton = document.querySelector('#upload-button');
const uploadLabel = document.querySelector('#upload-label');
const spinner = document.querySelector('#spinner');
const notice = document.querySelector('#notice');
const resultEmpty = document.querySelector('#result-empty');
const resultContent = document.querySelector('#result-content');
const imageKeyField = document.querySelector('#image-key');
const linkTitle = document.querySelector('#link-title');
const targetUrl = document.querySelector('#target-url');
const magicLink = document.querySelector('#magic-link');

let selectedFile = null;
let previewUrl = null;

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

  if (previewUrl) URL.revokeObjectURL(previewUrl);
  selectedFile = file;
  previewUrl = URL.createObjectURL(file);
  previewImage.src = previewUrl;
  fileName.textContent = file.name || '粘贴的图片';
  fileDetail.textContent = `${file.type || '图片'} · ${formatBytes(file.size)}`;
  dropZone.hidden = true;
  previewCard.hidden = false;
  uploadButton.disabled = false;
  uploadLabel.textContent = '上传到飞书';
}

function resetFile() {
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null;
  selectedFile = null;
  fileInput.value = '';
  previewCard.hidden = true;
  dropZone.hidden = false;
  uploadButton.disabled = true;
  uploadLabel.textContent = '选择图片后上传';
  setNotice();
}

function updateMagicLink() {
  const key = imageKeyField.value;
  if (!key) {
    magicLink.value = '';
    return;
  }
  const magicUrl = new URL('https://magic.solutionsuite.cn/r');
  if (linkTitle.value.trim()) magicUrl.searchParams.set('t', linkTitle.value.trim());
  magicUrl.searchParams.set('k', key);
  if (targetUrl.value.trim()) magicUrl.searchParams.set('u', targetUrl.value.trim());
  magicLink.value = magicUrl.toString();
}

async function copyField(targetId, button) {
  const field = document.querySelector(`#${targetId}`);
  try {
    await navigator.clipboard.writeText(field.value);
  } catch {
    field.focus();
    field.select();
    document.execCommand('copy');
  }
  const original = button.textContent;
  button.textContent = '已复制';
  window.setTimeout(() => {
    button.textContent = original;
  }, 1200);
}

async function upload() {
  if (!selectedFile || uploadButton.disabled) return;
  uploadButton.disabled = true;
  spinner.hidden = false;
  uploadLabel.textContent = '正在上传…';
  setNotice();

  try {
    const response = await fetch(`/api/upload?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: {
        'Content-Type': selectedFile.type || 'application/octet-stream',
        'X-File-Name': encodeURIComponent(selectedFile.name || 'image'),
      },
      body: selectedFile,
    });
    const result = await response.json();
    if (!response.ok || !result.ok) {
      throw new Error(result.message || '上传失败');
    }
    imageKeyField.value = result.imageKey;
    resultEmpty.hidden = true;
    resultContent.hidden = false;
    updateMagicLink();
    setNotice(`上传成功 · ${formatBytes(result.size)}`, 'success');
    uploadLabel.textContent = '重新上传';
  } catch (error) {
    setNotice(error.message || '上传失败，请稍后重试。');
    uploadLabel.textContent = '重试上传';
  } finally {
    spinner.hidden = true;
    uploadButton.disabled = false;
  }
}

dropZone.addEventListener('click', () => fileInput.click());
replaceButton.addEventListener('click', () => {
  resetFile();
  fileInput.click();
});
fileInput.addEventListener('change', () => chooseFile(fileInput.files?.[0]));
uploadButton.addEventListener('click', upload);
linkTitle.addEventListener('input', updateMagicLink);
targetUrl.addEventListener('input', updateMagicLink);

for (const eventName of ['dragenter', 'dragover']) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.add('dragging');
  });
}

for (const eventName of ['dragleave', 'drop']) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.remove('dragging');
  });
}

dropZone.addEventListener('drop', (event) => {
  chooseFile(event.dataTransfer?.files?.[0]);
});

window.addEventListener('paste', (event) => {
  const item = Array.from(event.clipboardData?.items || []).find((candidate) =>
    candidate.type.startsWith('image/'),
  );
  if (item) chooseFile(item.getAsFile());
});

document.querySelectorAll('[data-copy-target]').forEach((button) => {
  button.addEventListener('click', () => copyField(button.dataset.copyTarget, button));
});

if (!token) {
  setNotice('当前链接缺少访问令牌，请使用服务启动时输出的完整 URL。');
  dropZone.disabled = true;
}
