/**
 * 画面の土台。
 *
 * 覚えることを減らすため、タブではなく「今月やること」を上から並べる。
 * 毎月やるのは 読み込む → 確認する → 割り振る の3つだけ。
 */

import { clear, el } from './dom';
import { loadDatabase, updateDatabase, type Database } from '../store/db';
import type { ImportReview } from '../core/import';
import { renderHome } from './views/home';
import { renderImport } from './views/import';
import { renderReview } from './views/review';
import { renderAssign } from './views/assign';
import { renderSettings } from './views/settings';

export type ViewName = 'home' | 'import' | 'review' | 'assign' | 'settings';

export interface AppState {
  view: ViewName;
  /** 'YYYY-MM' */
  period: string;
  /** 取り込み中の確認データ。確定するまで端末には保存しない。 */
  review: ImportReview | null;
  runId: string | null;
}

export interface Ctx {
  readonly db: Database;
  readonly state: AppState;
  go(view: ViewName, patch?: Partial<AppState>): void;
  /** 今の画面を描き直す。 */
  refresh(): void;
  /** 保存データを書き換えて描き直す。 */
  update(change: (db: Database) => Database): void;
  setReview(review: ImportReview | null): void;
}

const TITLES: Record<ViewName, string> = {
  home: 'シフト振り分け',
  import: '勤務表を読み込む',
  review: '読み取りの確認',
  assign: '業務の割り振り',
  settings: '設定',
};

function currentPeriod(db: Database): string {
  const periods = [...new Set(db.confirmed.map((c) => c.period))].sort();
  const latest = periods[periods.length - 1];
  if (latest) return latest;
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

export function startApp(root: HTMLElement): void {
  const state: AppState = {
    view: 'home',
    period: currentPeriod(loadDatabase()),
    review: null,
    runId: null,
  };

  const ctx: Ctx = {
    get db() {
      return loadDatabase();
    },
    state,
    go(view, patch) {
      Object.assign(state, patch ?? {});
      state.view = view;
      render();
      window.scrollTo({ top: 0 });
    },
    refresh() {
      render();
    },
    update(change) {
      updateDatabase(change);
      render();
    },
    setReview(review) {
      state.review = review;
    },
  };

  function render(): void {
    clear(root);
    root.removeAttribute('aria-busy');

    const body = el('main', { class: state.view === 'review' ? 'view view--wide' : 'view' });

    const shell = el(
      'div',
      { class: 'shell' },
      el(
        'header',
        { class: 'topbar' },
        state.view === 'home'
          ? null
          : el(
              'button',
              {
                class: 'topbar__back',
                type: 'button',
                'aria-label': '戻る',
                onclick: () => ctx.go('home'),
              },
              backIcon(),
            ),
        el('h1', { class: 'topbar__title', text: TITLES[state.view] }),
        el('div', { class: 'topbar__spacer' }),
        state.view === 'home'
          ? el(
              'button',
              {
                class: 'topbar__back',
                type: 'button',
                'aria-label': '設定',
                onclick: () => ctx.go('settings'),
              },
              gearIcon(),
            )
          : null,
      ),
      body,
    );

    switch (state.view) {
      case 'home': renderHome(body, ctx); break;
      case 'import': renderImport(body, ctx); break;
      case 'review': renderReview(body, ctx); break;
      case 'assign': renderAssign(body, ctx); break;
      case 'settings': renderSettings(body, ctx); break;
    }

    root.appendChild(shell);
  }

  render();
}

function icon(path: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '22');
  svg.setAttribute('height', '22');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  node.setAttribute('d', path);
  svg.appendChild(node);
  return svg;
}

const backIcon = (): SVGSVGElement => icon('M15 18l-6-6 6-6');
const gearIcon = (): SVGSVGElement =>
  icon('M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.7 1.7 0 00.3 1.9l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-2.9 1.2V21a2 2 0 11-4 0v-.1A1.7 1.7 0 007.1 19l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00-1.2-2.9H3a2 2 0 110-4h.1A1.7 1.7 0 004.3 7l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.9.3h.1A1.7 1.7 0 0010 3.1V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.9-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.9v.1a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z');
export const chevronIcon = (): SVGSVGElement => icon('M9 18l6-6-6-6');
