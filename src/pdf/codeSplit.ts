/**
 * セル内の文字列を「勤務区分コード」と「業務メモ」に切り分ける。
 *
 * セルは狭く、コードは折り返して2〜3行に散る。さらに折り返しの続きが
 * メモの行にまで食い込むため、行ごとに切ると壊れる。
 * そこでセル内の文字を読み順に全部つないでから、コードの形で切り出す。
 *
 *   "日/F" + "_032" + "DS" + "営業"  →  コード "日/F_032DS" / メモ "営業"
 *
 * 推測はしない。形に合わなければ code を null にして人に回す。
 */

/** 勤務区分コードの形。末尾の事業所コードが区切りの目印になる。 */
const CODE_PATTERN = /^(.+?_\d{3}(?:DS|SS))(.*)$/u;

/** コードを持たず、それ自体で意味が通る値。 */
const PLAIN_VALUES = new Set(['休', '有給', '特休', '欠勤', '公休', '希望休', '有休', '代休']);

export interface SplitResult {
  readonly code: string | null;
  readonly memo: string;
  readonly reason: string | null;
}

export function splitCodeAndMemo(joined: string): SplitResult {
  const text = joined.trim();
  if (text === '') return { code: '', memo: '', reason: null };
  if (PLAIN_VALUES.has(text)) return { code: text, memo: '', reason: null };

  const matched = CODE_PATTERN.exec(text);
  if (matched) {
    return { code: matched[1] as string, memo: (matched[2] as string).trim(), reason: null };
  }

  // 先頭が「休」などで、後ろにメモが続くだけの形も拾う。
  for (const plain of PLAIN_VALUES) {
    if (text.startsWith(plain)) {
      return { code: plain, memo: text.slice(plain.length).trim(), reason: null };
    }
  }

  return { code: null, memo: '', reason: `コードとして解釈できない: ${text}` };
}
