import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { addCollection } from '@iconify/react';
import materialIconTheme from '@iconify-json/material-icon-theme/icons.json';
// Note: Monaco (~10MB) is not loaded at the entry. monaco-setup has been moved into the two
// lazy modules DiffView / InlineCodeContext, pulled only on first viewing a diff / inline code context, avoiding blocking the window's first frame.
// i18n must be imported before App: its side effect synchronously inits i18next, ensuring t() is available before the first-frame render.
import './i18n';
// theme is likewise imported before App: its side effect synchronously pins the first-frame theme from the localStorage cache (writing data-theme),
// avoiding a light-mode user flashing a frame of dark on startup.
import './theme';
import App from './App';
import './App.scss';

// Preload the PKief Material Icon Theme so that <Icon icon="material-icon-theme:..." />
// goes through the bundle instead of the default api.iconify.design CDN (disallowed by CSP)
addCollection(materialIconTheme);

const container = document.getElementById('root');
if (!container) throw new Error('#root not found');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
