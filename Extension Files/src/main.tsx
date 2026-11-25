import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/index.css';

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  const isInIframe = window.parent !== window;
  document.documentElement.classList.toggle('amisync-overlay', isInIframe);
  document.documentElement.classList.toggle('amisync-popup', !isInIframe);
}

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('Root mount element #root not found.');
}

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>
);
