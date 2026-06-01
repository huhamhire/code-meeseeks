import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { addCollection } from '@iconify/react';
import materialIconTheme from '@iconify-json/material-icon-theme/icons.json';
import './monaco-setup';
import App from './App';
import './App.scss';

// 预加载 PKief Material Icon Theme，让 <Icon icon="material-icon-theme:..." />
// 走 bundle 而非默认的 api.iconify.design CDN（CSP 不允许）
addCollection(materialIconTheme);

const container = document.getElementById('root');
if (!container) throw new Error('#root not found');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
