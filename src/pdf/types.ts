/**
 * PDF から取り出した「文字と、その置かれている座標」。
 *
 * 表の読み取りをここで座標の問題に還元しておくと、パーサ本体が pdf.js に
 * 依存しなくなる。テストは固定の座標データを流し込むだけで書ける。
 */

/** 1つのテキスト片。x,y は PDF 座標系（左下原点）の左下角。 */
export interface TextItem {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly str: string;
}

export interface PageText {
  readonly width: number;
  readonly height: number;
  readonly items: readonly TextItem[];
}

/** 1人分の1日のセル。 */
export interface ShiftCell {
  readonly day: number;
  /** 勤務区分コード。解釈できなかったときは null。 */
  readonly code: string | null;
  /** セル内の業務メモ（「会議」「イベ」など）。 */
  readonly memo: string;
  /** 元の文字列。原本と見比べるときに出す。 */
  readonly raw: string;
  readonly weekday: string;
}

export interface ShiftRow {
  readonly rowNo: number;
  readonly name: string;
  readonly team: string;
  readonly job: string;
  readonly cells: readonly ShiftCell[];
}

/** 読めなかった箇所。人が直すまで確定させない。 */
export interface UnreadCell {
  readonly rowNo: number;
  readonly name: string;
  readonly day: number;
  readonly raw: string;
  readonly reason: string;
}

export interface ParsedShift {
  readonly year: number | null;
  readonly month: number | null;
  readonly days: readonly number[];
  readonly rows: readonly ShiftRow[];
  readonly unread: readonly UnreadCell[];
  readonly warnings: readonly string[];
}
