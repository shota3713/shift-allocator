import { defineConfig } from 'vitest/config';

// GitHub Pages は /<repo>/ 配下で配信されるため相対パスで出力する。
// 出力先を docs/ にしているのは Pages の「main ブランチ / docs」設定に合わせるため。
export default defineConfig({
  base: './',
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
