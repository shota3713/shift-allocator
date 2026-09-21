/**
 * 勤務表PDFの表を、座標から決定論的に組み立てる。
 *
 * この帳票はテキストレイヤ付きで、日付ヘッダも氏名列も同じ x に揃っている。
 * だから読み取りに推論は要らない。列は日付ヘッダの位置から、行は氏名の位置から
 * 決まる。形に合わないものは埋めずに「読めなかった」として人に返す。
 *
 * 1人分は縦に5本の文字行へ散る（コード上段・氏名・コード下段・メモ上段・メモ下段）。
 * 行単位で切ると壊れるので、氏名の位置を起点に「その人の帯」をまとめて扱う。
 */

import { splitCodeAndMemo } from './codeSplit';
import type { PageText, ParsedShift, ShiftCell, ShiftRow, TextItem, UnreadCell } from './types';

/** 同じ行とみなす y のずれ。 */
const Y_TOLERANCE = 0.8;

/** 日付列に引き寄せる最大距離（列ピッチに対する割合）。 */
const COLUMN_SNAP_RATIO = 0.6;

/** 氏名の行を基準にした、その人の帯の上端（行ピッチに対する割合）。 */
const BAND_TOP_RATIO = 0.25;

/** 行ピッチが1人分しか取れないときの既定値（この帳票の実測値）。 */
const DEFAULT_ROW_PITCH = 36;

const PERIOD_PATTERN = /(\d{4})\s*年\s*(\d{1,2})\s*月/u;

interface Band {
  readonly y: number;
  readonly items: TextItem[];
}

interface DayColumn {
  readonly day: number;
  readonly center: number;
}

interface PageLayout {
  readonly days: DayColumn[];
  readonly weekdays: Map<number, string>;
  readonly pitch: number;
  readonly teamX: number;
  readonly nameX: number;
  readonly jobX: number;
  readonly leftBoundary: number;
}

const centerOf = (it: TextItem): number => it.x + it.w / 2;

/** 太字表現のために二重描画された文字を落とす。 */
function dedupe(items: readonly TextItem[]): TextItem[] {
  const seen = new Set<string>();
  const out: TextItem[] = [];
  for (const it of items) {
    if (it.str.trim() === '') continue;
    const key = `${Math.round(it.x)}:${Math.round(it.y)}:${it.str}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

/** y が近い文字をまとめ、上から下へ並べる。 */
function toBands(items: readonly TextItem[]): Band[] {
  const sorted = [...items].sort((a, b) => b.y - a.y);
  const bands: Band[] = [];
  let current: TextItem[] = [];
  let currentY = Number.NaN;
  for (const it of sorted) {
    if (current.length === 0) {
      currentY = it.y;
      current.push(it);
    } else if (Math.abs(it.y - currentY) <= Y_TOLERANCE) {
      current.push(it);
    } else {
      bands.push({ y: currentY, items: current.sort((a, b) => a.x - b.x) });
      current = [it];
      currentY = it.y;
    }
  }
  if (current.length > 0) bands.push({ y: currentY, items: current.sort((a, b) => a.x - b.x) });
  return bands;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
    : (sorted[mid] as number);
}

function snapToDay(x: number, days: readonly DayColumn[], pitch: number): number | null {
  let bestDay: number | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const col of days) {
    const dist = Math.abs(col.center - x);
    if (dist < bestDist) {
      bestDist = dist;
      bestDay = col.day;
    }
  }
  return bestDist <= pitch * COLUMN_SNAP_RATIO ? bestDay : null;
}

/** 日付ヘッダと氏名ヘッダの位置から、このページの列割りを決める。 */
function readLayout(bands: readonly Band[]): PageLayout | null {
  let headerIndex = -1;
  let best = 0;
  bands.forEach((band, i) => {
    const count = band.items.filter((it) => /^\d{1,2}$/u.test(it.str.trim())).length;
    if (count >= 5 && count > best) {
      best = count;
      headerIndex = i;
    }
  });
  if (headerIndex < 0) return null;

  const headerBand = bands[headerIndex] as Band;
  const days: DayColumn[] = headerBand.items
    .filter((it) => /^\d{1,2}$/u.test(it.str.trim()))
    .map((it) => ({ day: Number(it.str.trim()), center: centerOf(it) }));
  if (days.length < 5) return null;

  const gaps: number[] = [];
  for (let i = 1; i < days.length; i += 1) {
    gaps.push((days[i] as DayColumn).center - (days[i - 1] as DayColumn).center);
  }
  const pitch = median(gaps);

  const labelBand = bands.find((b) => b.items.some((it) => it.str.trim() === '氏名'));
  if (!labelBand) return null;
  const labelX = (text: string): number | null => {
    const found = labelBand.items.find((it) => it.str.trim() === text);
    return found ? found.x : null;
  };
  const nameX = labelX('氏名');
  const teamX = labelX('チーム名');
  const jobX = labelX('職種');
  if (nameX === null || teamX === null || jobX === null) return null;

  // 曜日はヘッダの下にあるが、間に氏名などの見出し帯が挟まる。
  // 日付列にきれいに乗る最初の帯を曜日とみなす。
  const weekdays = new Map<number, string>();
  for (let i = headerIndex + 1; i < bands.length; i += 1) {
    const band = bands[i] as Band;
    const onGrid = band.items.filter(
      (it) => snapToDay(centerOf(it), days, pitch) !== null,
    );
    if (onGrid.length < days.length * 0.8) continue;
    for (const it of onGrid) {
      const day = snapToDay(centerOf(it), days, pitch) as number;
      if (!weekdays.has(day)) weekdays.set(day, it.str.trim());
    }
    break;
  }

  return {
    days,
    weekdays,
    pitch,
    teamX,
    nameX,
    jobX,
    leftBoundary: (days[0] as DayColumn).center - pitch / 2,
  };
}

interface Anchor {
  readonly y: number;
  readonly name: string;
  readonly team: string;
  readonly job: string;
}

/** 氏名列に文字がある帯を「その人の行」とみなす。 */
function findAnchors(bands: readonly Band[], layout: PageLayout): Anchor[] {
  const inRange = (x: number, from: number, to: number): boolean => x >= from - 2 && x < to - 2;
  const anchors: Anchor[] = [];
  for (const band of bands) {
    const name = band.items
      .filter((it) => inRange(it.x, layout.nameX, layout.jobX))
      .map((it) => it.str.trim())
      .join('');
    if (name === '' || name === '氏名') continue;
    const team = band.items
      .filter((it) => inRange(it.x, layout.teamX, layout.nameX))
      .map((it) => it.str.trim())
      .join('');
    const job = band.items
      .filter((it) => inRange(it.x, layout.jobX, layout.leftBoundary))
      .map((it) => it.str.trim())
      .join('');
    anchors.push({ y: band.y, name, team, job });
  }
  return anchors.sort((a, b) => b.y - a.y);
}

interface PageResult {
  readonly rows: ShiftRow[];
  readonly unread: UnreadCell[];
  readonly warnings: string[];
}

/** 1ページ分の行を組む。 */
function parsePage(page: PageText, startRowNo: number): PageResult {
  const items = dedupe(page.items);
  const bands = toBands(items);
  const layout = readLayout(bands);
  if (!layout) {
    return {
      rows: [],
      unread: [],
      warnings: ['このページから日付ヘッダと氏名の列を見つけられませんでした。'],
    };
  }

  const anchors = findAnchors(bands, layout);
  const rowGaps: number[] = [];
  for (let i = 1; i < anchors.length; i += 1) {
    rowGaps.push((anchors[i - 1] as Anchor).y - (anchors[i] as Anchor).y);
  }
  const rowPitch = rowGaps.length > 0 ? median(rowGaps) : DEFAULT_ROW_PITCH;
  const bandTop = rowPitch * BAND_TOP_RATIO;

  const rows: ShiftRow[] = [];
  const unread: UnreadCell[] = [];
  const warnings: string[] = [];

  anchors.forEach((anchor, i) => {
    const rowNo = startRowNo + i;
    const top = anchor.y + bandTop;
    const next = anchors[i + 1];
    const bottom = next ? next.y + bandTop : anchor.y + bandTop - rowPitch;

    const byDay = new Map<number, TextItem[]>();
    for (const it of items) {
      if (it.y > top || it.y <= bottom) continue;
      const center = centerOf(it);
      if (center < layout.leftBoundary) continue;
      const day = snapToDay(center, layout.days, layout.pitch);
      if (day === null) continue;
      const bucket = byDay.get(day);
      if (bucket) bucket.push(it);
      else byDay.set(day, [it]);
    }

    const cells: ShiftCell[] = layout.days.map((col) => {
      const bucket = (byDay.get(col.day) ?? []).sort((a, b) => b.y - a.y || a.x - b.x);
      const joined = bucket.map((it) => it.str.trim()).join('');
      const split = splitCodeAndMemo(joined);
      if (split.reason !== null) {
        warnings.push(`${anchor.name} ${col.day}日: ${split.reason}`);
        unread.push({ rowNo, name: anchor.name, day: col.day, raw: joined, reason: split.reason });
      }
      return {
        day: col.day,
        code: split.code,
        memo: split.memo,
        raw: joined,
        weekday: layout.weekdays.get(col.day) ?? '',
      };
    });

    rows.push({ rowNo, name: anchor.name, team: anchor.team, job: anchor.job, cells });
  });

  return { rows, unread, warnings };
}

function readPeriod(pages: readonly PageText[]): { year: number | null; month: number | null } {
  for (const page of pages) {
    for (const it of page.items) {
      const matched = PERIOD_PATTERN.exec(it.str);
      if (matched) return { year: Number(matched[1]), month: Number(matched[2]) };
    }
  }
  return { year: null, month: null };
}

/** PDF 全体を読み取る。ページをまたいで人が続くので通し番号でつなぐ。 */
export function parseShiftTable(pages: readonly PageText[]): ParsedShift {
  const { year, month } = readPeriod(pages);
  const rows: ShiftRow[] = [];
  const unread: UnreadCell[] = [];
  const warnings: string[] = [];
  let days: number[] = [];

  for (const page of pages) {
    const result = parsePage(page, rows.length + 1);
    rows.push(...result.rows);
    unread.push(...result.unread);
    warnings.push(...result.warnings);
    const first = result.rows[0];
    if (days.length === 0 && first) days = first.cells.map((c) => c.day);
  }

  if (rows.length === 0) warnings.push('勤務表として読み取れる行がありませんでした。');

  return { year, month, days, rows, unread, warnings };
}
