import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { addCollection } from '@iconify/react';
import materialIconTheme from '@iconify-json/material-icon-theme/icons.json';
// 注意：Monaco（~10MB）不在入口加载。monaco-setup 已移进 DiffView / InlineCodeContext
// 两个懒模块，仅在首次看 diff / 行内代码上下文时才拉取，避免阻塞窗口首帧。
// i18n 必须在 App 之前 import：副作用里同步 init i18next，保证首帧渲染前 t() 可用。
import './i18n';
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
