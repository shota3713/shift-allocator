/**
 * 業務の難易度。
 *
 * 数値を直接入れさせない。「1.5」と「2.0」の差を毎回考えるのは無理があるし、
 * 人によって基準がずれる。5段階から選ばせて、計算に使う重みはこちらで決める。
 *
 * 重みは「1日あたりの負担」を測るための係数。難しい業務ほど大きくすることで、
 * リーダー業務が同じ人に続けて当たらなくなる。
 */

export type DifficultyLevel = 1 | 2 | 3 | 4 | 5;

export interface DifficultySpec {
  readonly level: DifficultyLevel;
  readonly label: string;
  /** 公平さの計算に使う係数。 */
  readonly weight: number;
  readonly hint: string;
}

/**
 * 5段階。重みは 0.5 / 1.0 / 1.5 / 2.0 / 3.0。
 * 最上段だけ間隔を空けてあるのは、リーダー業務を他とはっきり分けるため。
 */
export const DIFFICULTY_LEVELS: readonly DifficultySpec[] = [
  { level: 1, label: 'とても軽い', weight: 0.5, hint: '短時間で終わる。誰が入っても変わらない' },
  { level: 2, label: '軽い', weight: 1.0, hint: '手順が決まっていて、負担が少ない' },
  { level: 3, label: 'ふつう', weight: 1.5, hint: '標準的な業務' },
  { level: 4, label: '重い', weight: 2.0, hint: '手間がかかる、または気を張る' },
  { level: 5, label: 'とても重い', weight: 3.0, hint: 'リーダー業務。続けて当てたくない' },
];

export const DEFAULT_DIFFICULTY: DifficultyLevel = 3;

function specOf(level: DifficultyLevel): DifficultySpec {
  return DIFFICULTY_LEVELS.find((d) => d.level === level)
    ?? (DIFFICULTY_LEVELS[DEFAULT_DIFFICULTY - 1] as DifficultySpec);
}

/** 難易度から計算に使う重みを出す。 */
export function weightOf(difficulty: DifficultyLevel): number {
  return specOf(difficulty).weight;
}

export function labelOf(difficulty: DifficultyLevel): string {
  return specOf(difficulty).label;
}

/** 選択肢の並び。上が軽い。 */
export function isDifficultyLevel(value: unknown): value is DifficultyLevel {
  return value === 1 || value === 2 || value === 3 || value === 4 || value === 5;
}

/**
 * 古い保存データの数値を段階に寄せる。
 * 重みを直接持っていた頃のデータを読み直すときに使う。
 */
export function difficultyFromWeight(weight: unknown): DifficultyLevel {
  const value = Number(weight);
  if (!Number.isFinite(value)) return DEFAULT_DIFFICULTY;

  let best = DIFFICULTY_LEVELS[0] as DifficultySpec;
  for (const spec of DIFFICULTY_LEVELS) {
    if (Math.abs(spec.weight - value) < Math.abs(best.weight - value)) best = spec;
  }
  return best.level;
}
