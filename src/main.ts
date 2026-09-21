/**
 * 入口。画面の土台を起動するだけ。
 */

import './styles/tokens.css';
import './styles/app.css';
import { startApp } from './ui/app';

const root = document.getElementById('app');
if (!root) throw new Error('#app が見つかりません');
startApp(root);
