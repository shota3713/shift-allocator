/**
 * 表記ゆれの解決。
 *
 * PDF から読んだ文字は「見たまま」なので、名寄せと記号の解釈はここに集める。
 * 推測で通してよいのは完全一致と別名辞書だけ。似ているだけのものは
 * 必ず人に確認させる（自動採用すると、誰も気づかないまま別人に割り振られる）。
 */

import type { ShiftType, Staff } from './types';

/** 取り込みの状態。確認画面の色分けに直結する。 */
export const FLAG = {
  OK: 'ok',
  REVIEW: 'review',
  BLOCK: 'block',
} as const;
export type Flag = (typeof FLAG)[keyof typeof FLAG];

/** 似ていると判断する下限。これ未満は候補として出すだけ。 */
export const NAME_MATCH_THRESHOLD = 0.72;

/**
 * 値の比較用の正規化。全角半角と空白のゆれだけを潰す。
 * 小数点・コロン・ハイフンは意味を持つので落とさない。
 */
export function normalizeText(text: string | null | undefined): string {
  if (text === null || text === undefined) return '';
  return String(text).normalize('NFKC').replace(/[\s　]/gu, '').toUpperCase();
}

/**
 * 氏名の比較用の正規化。区切り記号も落とす。
 * 「田中・太郎」「田中.太郎」「田中 太郎」を同一視するため。
 * 数値には使わないこと（小数点が消える）。
 */
export function normalizeName(text: string | null | undefined): string {
  return normalizeText(text).replace(/[・.．,，]/gu, '');
}

function levenshtein(a: string, b: string): number {
  let prev: number[] = [];
  for (let j = 0; j <= b.length; j += 1) prev[j] = j;

  for (let i = 1; i <= a.length; i += 1) {
    const curr: number[] = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        (curr[j - 1] as number) + 1,
        (prev[j] as number) + 1,
        (prev[j - 1] as number) + cost,
      );
    }
    prev = curr;
  }
  return prev[b.length] as number;
}

function levenshteinRatio(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
}

function diceSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const bigrams = (s: string): string[] => {
    if (s.length < 2) return [s];
    const out: string[] = [];
    for (let i = 0; i < s.length - 1; i += 1) out.push(s.slice(i, i + 2));
    return out;
  };
  const ga = bigrams(a);
  const gb = bigrams(b);
  const pool = new Map<string, number>();
  for (const g of ga) pool.set(g, (pool.get(g) ?? 0) + 1);
  let hit = 0;
  for (const g of gb) {
    const left = pool.get(g) ?? 0;
    if (left > 0) {
      pool.set(g, left - 1);
      hit += 1;
    }
  }
  return (2 * hit) / (ga.length + gb.length);
}

/**
 * 氏名の類似度。
 *
 * bigram の Dice 係数だけでは日本語の短い氏名に弱い。
 * 「田仲太郎 / 田中太郎」は1文字違いでも共通bigramが1個しかなく 0.33 に沈み、
 * 典型的な1文字違いを拾えない。編集距離ベースと併用して高い方を採る。
 */
export function nameSimilarity(a: string, b: string): number {
  return Math.max(diceSimilarity(a, b), levenshteinRatio(a, b));
}

export interface NameCandidate {
  readonly staff: Staff;
  readonly score: number;
}

/** 近い順に在籍者を返す。確認画面で候補として見せる。 */
export function rankNameCandidates(
  rawName: string,
  staffList: readonly Staff[],
  limit = 5,
): NameCandidate[] {
  const key = normalizeName(rawName);
  return staffList
    .map((staff) => ({ staff, score: nameSimilarity(key, normalizeName(staff.name)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export interface ResolveContext {
  readonly staffList: readonly Staff[];
  readonly staffByKey: ReadonlyMap<string, Staff>;
  readonly aliasByKey: ReadonlyMap<string, string>;
  readonly shiftByAlias: ReadonlyMap<string, ShiftType>;
}

export interface NameResolution {
  readonly staffId: string | null;
  readonly flag: Flag;
  readonly reason: string;
  readonly candidates: readonly NameCandidate[];
}

/** 氏名を職員に結びつける。似ているだけのものは REVIEW で止める。 */
export function resolveName(rawName: string, context: ResolveContext): NameResolution {
  const key = normalizeName(rawName);
  if (!key) return { staffId: null, flag: FLAG.BLOCK, reason: '氏名が空', candidates: [] };

  const exact = context.staffByKey.get(key);
  if (exact) return { staffId: exact.staffId, flag: FLAG.OK, reason: '', candidates: [] };

  const alias = context.aliasByKey.get(key);
  if (alias) return { staffId: alias, flag: FLAG.OK, reason: '別名辞書で解決', candidates: [] };

  const candidates = rankNameCandidates(rawName, context.staffList);
  const best = candidates[0];
  if (best && best.score >= NAME_MATCH_THRESHOLD) {
    return {
      staffId: best.staff.staffId,
      flag: FLAG.REVIEW,
      reason: `「${best.staff.name}」と推定（類似度 ${Math.round(best.score * 100)}%）。確認してください`,
      candidates,
    };
  }

  return {
    staffId: null,
    flag: FLAG.BLOCK,
    reason: `名簿に該当なし${best ? `（最も近いのは「${best.staff.name}」）` : ''}`,
    candidates,
  };
}

export interface ShiftResolution {
  readonly code: string | null;
  readonly flag: Flag;
  readonly reason: string;
}

/** セルの値を勤務区分に結びつける。未登録の記号は止める。 */
export function resolveShiftValue(
  rawValue: string | null,
  context: ResolveContext,
): ShiftResolution {
  if (rawValue === null) return { code: null, flag: FLAG.BLOCK, reason: '読み取れなかったセル' };

  const key = normalizeText(rawValue);
  if (key === '') return { code: 'OFF', flag: FLAG.OK, reason: '空欄は休みとして扱う' };

  const hit = context.shiftByAlias.get(key);
  if (hit) return { code: hit.code, flag: FLAG.OK, reason: '' };

  return {
    code: null,
    flag: FLAG.BLOCK,
    reason: `未登録の勤務区分「${rawValue}」。出勤か休みかを決めてください`,
  };
}

export function buildResolveContext(
  staff: readonly Staff[],
  aliases: readonly { rawText: string; staffId: string }[],
  shiftTypes: readonly ShiftType[],
): ResolveContext {
  const staffList = staff.filter((s) => s.active && s.staffId);
  const staffByKey = new Map<string, Staff>();
  for (const s of staffList) staffByKey.set(normalizeName(s.name), s);

  const aliasByKey = new Map<string, string>();
  for (const a of aliases) {
    if (a.rawText) aliasByKey.set(normalizeName(a.rawText), a.staffId);
  }

  const shiftByAlias = new Map<string, ShiftType>();
  for (const t of shiftTypes) {
    if (!t.code) continue;
    shiftByAlias.set(normalizeText(t.code), t);
    if (t.label) shiftByAlias.set(normalizeText(t.label), t);
    for (const a of t.aliases) {
      const k = normalizeText(a);
      if (k) shiftByAlias.set(k, t);
    }
  }

  return { staffList, staffByKey, aliasByKey, shiftByAlias };
}
