// boot-guard must be the FIRST import: its side effect arms the last-resort watchdog before any other module runs, so a
// module that throws while initializing (i18n / theme / App below) still ends with a readable screen instead of a
// permanently blank window. Anything imported above it would be outside the guard.
import './boot-guard';
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
import { AppCrashScreen, ErrorBoundary } from './components/common';
import './App.scss';

// Preload the PKief Material Icon Theme so that <Icon icon="material-icon-theme:..." />
// goes through the bundle instead of the default api.iconify.design CDN (disallowed by CSP)
addCollection(materialIconTheme);

const container = document.getElementById('root');
if (!container) throw new Error('#root not found');

createRoot(container).render(
  <StrictMode>
    {/* Root boundary: without one, any error thrown while rendering unmounts the entire tree and leaves an empty
        #root — an all-black window with no way back short of restarting the app. Here the user gets what broke plus
        a retry / reload, and the boundary relays the stack to main so the crash is on disk in meebox.log. */}
    <ErrorBoundary
      label="App"
      fallback={(err, reset) => <AppCrashScreen err={err} onRetry={reset} />}
    >
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
