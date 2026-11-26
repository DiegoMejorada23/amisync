// Self-contained lightweight overlay launcher for https://amis.uplb.edu.ph/*
// Must remain dependency-free so Rollup emits a classic script without top-level ES imports.
(() => {
  const CONTAINER_ID = 'amisync-overlay-root';
  const EXTENSION_ORIGIN = chrome.runtime.getURL('').replace(/\/$/, '');

  function closeOverlay(): void {
    const existing = document.getElementById(CONTAINER_ID);
    if (existing) {
      existing.remove();
    }
  }

  function openOverlay(): void {
    if (document.getElementById(CONTAINER_ID)) {
      return;
    }

    const backdrop = document.createElement('div');
    backdrop.id = CONTAINER_ID;
    Object.assign(backdrop.style, {
      position: 'fixed',
      inset: '0',
      zIndex: '2147483647',
      backgroundColor: 'rgba(15, 23, 42, 0.42)',
      backdropFilter: 'blur(6px)',
      WebkitBackdropFilter: 'blur(6px)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '16px',
      boxSizing: 'border-box',
    });

    const iframe = document.createElement('iframe');
    iframe.src = chrome.runtime.getURL('index.html');
    iframe.title = 'AMISync Schedule Optimizer';
    Object.assign(iframe.style, {
      width: '94vw',
      maxWidth: '1360px',
      height: '90vh',
      maxHeight: '860px',
      border: 'none',
      borderRadius: '12px',
      boxShadow: '0 24px 54px rgba(15, 23, 42, 0.34), 0 8px 20px rgba(15, 23, 42, 0.16)',
      backgroundColor: '#F2F2F7',
    });

    backdrop.addEventListener('click', (event: MouseEvent) => {
      if (event.target === backdrop) {
        closeOverlay();
      }
    });

    backdrop.appendChild(iframe);
    document.documentElement.appendChild(backdrop);
  }

  function toggleOverlay(): void {
    if (document.getElementById(CONTAINER_ID)) {
      closeOverlay();
    } else {
      openOverlay();
    }
  }

  chrome.runtime.onMessage.addListener((message: { type?: string }) => {
    if (message?.type === 'AMISYNC_TOGGLE_OVERLAY') {
      toggleOverlay();
    } else if (message?.type === 'AMISYNC_CLOSE_OVERLAY') {
      closeOverlay();
    }
  });

  window.addEventListener('message', (event: MessageEvent<{ type?: string }>) => {
    if (event.origin === EXTENSION_ORIGIN && event.data?.type === 'AMISYNC_DISMISS_OVERLAY') {
      closeOverlay();
    }
  });

  window.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Escape' && document.getElementById(CONTAINER_ID)) {
      closeOverlay();
    }
  });
})();
