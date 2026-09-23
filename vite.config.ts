import { defineConfig } from 'vitest/config';

// GitHub Pages は /<repo>/ 配下で配信されるため相対パスで出力する。
// 出力先を docs/ にしているのは Pages の「main ブランチ / docs」設定に合わせるため。
// 画面の隅に出す版。どの版が動いているかを口頭で確かめられるようにする。
const buildStamp = new Date().toISOString().replace(/[-:T]/gu, '').slice(2, 12);

export default defineConfig({
  base: './',
  define: { __BUILD__: JSON.stringify(buildStamp) },
  build: {
    outDir: 'docs',
    emptyOutDir: true,
    target: 'es2022',
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'local/**/*.test.ts'],
  },
});
