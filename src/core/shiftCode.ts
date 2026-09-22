/**
 * 勤務区分コードの読み解き。
 *
 * コードは「本体 + 事業所コード」でできている。事業所コード（_032DS など）は
 * 振り分けには関係しないので落とす。本体は「/」で午前と午後に分かれる。
 *
 *   日_032DS    → 1日 現場
 *   日/F_032DS  → 午前は現場、午後はフリー
 *   F/日_032DS  → 午前はフリー、午後は現場
 *   F_032DS     → 1日フリー（業務は割り振らない）
 *   清掃_032DS  → 清掃だけの勤務（他の業務は割り振らない）
 *
 * フリーの半日に業務を割り振らないのが要点。ここを「出勤しているか」だけで
 * 判断すると、1日フリーの人にリハ担当が乗る。
 *
 * 推測が入る余地は残るので、結果は設定画面で人が上書きできる（assumed）。
 */

import { normalizeText } from './resolve';

/** 半日の状態。work 以外には業務を割り振らない。 */
export const PRESENCE = { WORK: 'work', FREE: 'free', OFF: 'off' } as const;
export type Presence = (typeof PRESENCE)[keyof typeof PRESENCE];

export const PRESENCE_LABELS: Record<Presence, string> = {
  work: '現場', free: 'フリー', off: '休み',
};

/** 勤務の型。昼担当の優先順位などに使う。 */
export const SHIFT_KIND = {
  DAY: 'DAY',
  EARLY: 'EARLY',
  LATE: 'LATE',
  NURSE: 'NURSE',
  AM_ONLY: 'AM_ONLY',
  PM_ONLY: 'PM_ONLY',
  FREE: 'FREE',
  OFF: 'OFF',
} as const;
export type ShiftKind = (typeof SHIFT_KIND)[keyof typeof SHIFT_KIND];

export const SHIFT_KIND_LABELS: Record<ShiftKind, string> = {
  DAY: '日勤',
  EARLY: '早番',
  LATE: '遅番',
  NURSE: '看護',
  AM_ONLY: '午前のみ',
  PM_ONLY: '午後のみ',
  FREE: 'フリー',
  OFF: '休み',
};

/** 末尾の事業所コード。_032DS / _032SS の形。 */
const SITE_SUFFIX = /_\d{2,4}[A-Z]{2}$/u;

const FREE_TOKENS = new Set(['F', 'フ', 'フリー']);
const OFF_TOKENS = ['休', '公休', '有給', '有休', '特休', '代休', '希望休', '欠勤', '欠'];

type TokenKind = 'free' | 'off' | 'clean' | 'nurse' | 'early' | 'late' | 'day' | 'drive' | 'unknown';

const TOKEN_LABELS: Record<TokenKind, string> = {
  free: 'フリー',
  off: '休み',
  clean: '清掃',
  nurse: '看護',
  early: '早番',
  late: '遅番',
  day: '日勤',
  drive: '送迎',
  unknown: '不明',
};

/** 事業所コードを落とした本体を返す。 */
export function shiftCodeBase(code: string): string {
  return normalizeText(code).replace(SITE_SUFFIX, '');
}

function classify(token: string): TokenKind {
  if (token === '') return 'off';
  if (FREE_TOKENS.has(token)) return 'free';
  if (OFF_TOKENS.some((t) => token === t || token.startsWith(t))) return 'off';
  if (token.startsWith('清掃')) return 'clean';
  if (token.startsWith('看')) return 'nurse';
  if (token.startsWith('早')) return 'early';
  if (token.startsWith('遅')) return 'late';
  if (token.startsWith('日')) return 'day';
  if (token.startsWith('運') || token.startsWith('送')) return 'drive';
  return 'unknown';
}

/**
 * その半日に現場にいるか。
 * 清掃と送迎を work にしないのは、どちらも担当が別に決まっている勤務で、
 * ここで割り振る業務（リハ・入浴・昼・レク等）には入らないため。
 */
function presenceOf(kind: TokenKind): Presence {
  if (kind === 'free' || kind === 'clean' || kind === 'drive') return PRESENCE.FREE;
  if (kind === 'off') return PRESENCE.OFF;
  return PRESENCE.WORK;
}

export interface ShiftMeaning {
  /** 事業所コードを落とした本体。 */
  readonly base: string;
  readonly am: Presence;
  readonly pm: Presence;
  readonly kind: ShiftKind;
  /** 午前だけ現場にいる（昼担当の優先対象）。 */
  readonly amOnly: boolean;
  readonly pmOnly: boolean;
  /** 人が読む説明。 */
  readonly label: string;
  /** 形から判断できず、現場ありと仮定した。設定で確認させる。 */
  readonly assumed: boolean;
}

function kindOf(am: Presence, pm: Presence, amKind: TokenKind, pmKind: TokenKind): ShiftKind {
  const working = am === PRESENCE.WORK || pm === PRESENCE.WORK;
  if (!working) {
    return am === PRESENCE.FREE || pm === PRESENCE.FREE ? SHIFT_KIND.FREE : SHIFT_KIND.OFF;
  }
  const kinds = [am === PRESENCE.WORK ? amKind : null, pm === PRESENCE.WORK ? pmKind : null];
  if (kinds.includes('late')) return SHIFT_KIND.LATE;
  if (kinds.includes('nurse')) return SHIFT_KIND.NURSE;
  if (kinds.includes('early')) return SHIFT_KIND.EARLY;
  if (am === PRESENCE.WORK && pm !== PRESENCE.WORK) return SHIFT_KIND.AM_ONLY;
  if (pm === PRESENCE.WORK && am !== PRESENCE.WORK) return SHIFT_KIND.PM_ONLY;
  return SHIFT_KIND.DAY;
}

/** コードから午前・午後の在所を読む。 */
export function readShiftCode(code: string): ShiftMeaning {
  const base = shiftCodeBase(code);
  const halves = base.split('/');
  const amToken = (halves[0] ?? '').trim();
  const pmToken = (halves.length > 1 ? halves[1] ?? '' : amToken).trim();

  const amKind = classify(amToken);
  const pmKind = classify(pmToken);
  const am = presenceOf(amKind);
  const pm = presenceOf(pmKind);

  const label = halves.length > 1
    ? `午前 ${TOKEN_LABELS[amKind]} / 午後 ${TOKEN_LABELS[pmKind]}`
    : TOKEN_LABELS[amKind];

  return {
    base,
    am,
    pm,
    kind: kindOf(am, pm, amKind, pmKind),
    amOnly: am === PRESENCE.WORK && pm !== PRESENCE.WORK,
    pmOnly: pm === PRESENCE.WORK && am !== PRESENCE.WORK,
    label,
    assumed: amKind === 'unknown' || pmKind === 'unknown',
  };
}

/** 設定画面で選ばせる在所の型。(am, pm) の組に名前を付けたもの。 */
export const PRESENCE_PRESETS = [
  { value: 'full', label: '1日 現場', am: PRESENCE.WORK, pm: PRESENCE.WORK },
  { value: 'am', label: '午前だけ現場', am: PRESENCE.WORK, pm: PRESENCE.FREE },
  { value: 'pm', label: '午後だけ現場', am: PRESENCE.FREE, pm: PRESENCE.WORK },
  { value: 'free', label: 'フリー（割り振らない）', am: PRESENCE.FREE, pm: PRESENCE.FREE },
  { value: 'off', label: '休み', am: PRESENCE.OFF, pm: PRESENCE.OFF },
] as const;

export type PresencePreset = (typeof PRESENCE_PRESETS)[number]['value'];

export function presetOf(am: Presence, pm: Presence): PresencePreset {
  const hit = PRESENCE_PRESETS.find((p) => p.am === am && p.pm === pm);
  if (hit) return hit.value;
  if (am === PRESENCE.WORK) return 'am';
  if (pm === PRESENCE.WORK) return 'pm';
  return 'off';
}

export function presetPresence(value: string): { am: Presence; pm: Presence } {
  const hit = PRESENCE_PRESETS.find((p) => p.value === value);
  return hit ? { am: hit.am, pm: hit.pm } : { am: PRESENCE.OFF, pm: PRESENCE.OFF };
}
