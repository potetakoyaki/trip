import { defineConfig } from 'vitest/config';

// 純粋なロジック（プランナー / パーサ）を Node 環境でテストする。
// Worker グローバル（HTMLRewriter / D1 等）はモジュール読み込み時には
// 評価されない構成にしてあるため、Workers プールなしでテストできる。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
