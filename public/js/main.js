// エントリポイント。ロビー（CPU対戦 / オンライン）を起動するだけ。
import { start } from './app.js';

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start);
} else {
  start();
}
