/**
 * DOM を組むための最小の道具。
 *
 * フレームワークを入れない。画面は数枚で、状態も「今どの画面か」しかない。
 * 文字列HTMLを組み立てないのは、氏名や勤務区分をそのまま流し込むため
 * （textContent なら差し込みの事故が起きない）。
 */

type Child = Node | string | number | null | undefined | false;

interface Attributes {
  readonly class?: string;
  readonly text?: string | number;
  readonly html?: never;
  readonly [key: string]: unknown;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Attributes = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = String(value);
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'dataset') Object.assign(node.dataset, value as Record<string, string>);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }
  append(node, children);
  return node;
}

export function append(parent: Node, children: readonly Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(typeof child === 'object' ? child : document.createTextNode(String(child)));
  }
}

export function fragment(...children: Child[]): DocumentFragment {
  const frag = document.createDocumentFragment();
  append(frag, children);
  return frag;
}

export function clear(node: Node): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** 下から出るシート。確認と選択はすべてこれで出す。 */
export function openSheet(options: {
  readonly title: string;
  readonly lead?: string;
  readonly body: Node;
  readonly onClose?: () => void;
}): () => void {
  const close = (): void => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    options.onClose?.();
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') close();
  };

  const panel = el(
    'div',
    { class: 'sheet-dialog__panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': options.title },
    el('h2', { class: 'sheet-dialog__title', text: options.title }),
    options.lead ? el('p', { class: 'sheet-dialog__lead', text: options.lead }) : null,
    options.body,
  );

  const overlay = el(
    'div',
    {
      class: 'sheet-dialog',
      onclick: (event: MouseEvent) => {
        if (event.target === overlay) close();
      },
    },
    panel,
  );

  document.body.appendChild(overlay);
  document.addEventListener('keydown', onKey);
  panel.querySelector<HTMLElement>('button, input, select, textarea')?.focus();
  return close;
}

/** 画面下に短く出す知らせ。 */
export function toast(message: string, tone: 'settled' | 'blocked' = 'settled'): void {
  const node = el('div', {
    class: `notice notice--${tone}`,
    role: 'status',
    text: message,
    style: 'position:fixed;left:16px;right:16px;bottom:16px;z-index:60;box-shadow:var(--shadow-lift)',
  });
  document.body.appendChild(node);
  setTimeout(() => node.remove(), 3200);
}
