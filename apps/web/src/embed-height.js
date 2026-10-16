export const EMBED_HEIGHT_MESSAGE_TYPE =
  'lark-signature-buddy:embed-height:v1';

export function createEmbedHeightMessage(height) {
  if (!Number.isFinite(height) || height <= 0) return null;
  return {
    type: EMBED_HEIGHT_MESSAGE_TYPE,
    height: Math.ceil(height),
  };
}

export function postEmbedHeight({
  root,
  currentWindow,
  parentWindow,
  previousHeight = 0,
}) {
  if (!root || currentWindow === parentWindow) return previousHeight;
  const message = createEmbedHeightMessage(
    root.getBoundingClientRect().height,
  );
  if (!message || message.height === previousHeight) return previousHeight;
  parentWindow.postMessage(message, '*');
  return message.height;
}

export function installEmbedHeightReporter({
  root,
  currentWindow = window,
  parentWindow = window.parent,
  ResizeObserverClass = globalThis.ResizeObserver,
}) {
  if (!root || currentWindow === parentWindow) return () => {};

  let frame = null;
  let previousHeight = 0;
  const report = () => {
    frame = null;
    previousHeight = postEmbedHeight({
      root,
      currentWindow,
      parentWindow,
      previousHeight,
    });
  };
  const schedule = () => {
    if (frame !== null) return;
    frame = currentWindow.requestAnimationFrame(report);
  };

  const observer = ResizeObserverClass
    ? new ResizeObserverClass(schedule)
    : null;
  observer?.observe(root);
  currentWindow.addEventListener('load', schedule);
  currentWindow.document?.fonts?.ready?.then(schedule, () => {});
  schedule();

  return () => {
    observer?.disconnect();
    currentWindow.removeEventListener('load', schedule);
    if (frame !== null) {
      currentWindow.cancelAnimationFrame(frame);
      frame = null;
    }
  };
}
