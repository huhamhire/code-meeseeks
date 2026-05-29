import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './monaco-setup';
import App from './App';
import './App.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root not found');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
