// エントリポイント。UI を起動するだけ。
import { start } from './ui.js';

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start);
} else {
  start();
}
