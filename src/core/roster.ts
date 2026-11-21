/**
 * 勤務予定と当日の実際の配置。
 *
 * 勤務表（confirmed）は「予定」としてそのまま残す。当日の欠勤・予定外の出勤・
 * OJTや応援の人は、差分（roster / guests）として別に持つ。予定を書き換えると、
 * 何が予定で何が当日の変更だったのかが後から分からなくなるため。
 */

import { normalizeName } from './resolve';
import type { Database } from '../store/db';

/** OJT・応援の人の職員ID。同じ名前なら同じ人として、月の中の負担を数える。 */
export function guestStaffId(name: string): string {
  return `guest_${normalizeName(name)}`;
}

export function isGuestStaffId(staffId: string): boolean {
  return staffId.startsWith('guest_');
}

export type DayStatus = 'planned' | 'changed' | 'added' | 'absent' | 'guest';

export interface DayEntry {
  readonly staffId: string;
  readonly day: number;
  /** 当日の区分コード。当日いない人は予定のコード。 */
  readonly code: string;
  readonly status: DayStatus;
  /** OJT・応援の別。guest のときだけ。 */
  readonly role: string;
}

/**
 * その月の 職員 × 日 の当日の区分。予定に当日の変更を重ねたもの。
 * attending は「そのコードで来ているか」の判定（休みの区分を除く）。
 */
export function actualEntries(
  db: Database,
  period: string,
  attending: (code: string) => boolean,
): DayEntry[] {
  const planned = new Map<string, string>();
  for (const c of db.confirmed) {
    if (c.period === period) planned.set(`${c.staffId}#${c.day}`, c.code);
  }
  const changes = new Map<string, string>();
  for (const r of db.roster) {
    if (r.period === period) changes.set(`${r.staffId}#${r.day}`, r.code);
  }

  const entries: DayEntry[] = [];
  for (const key of new Set([...planned.keys(), ...changes.keys()])) {
    const split = key.lastIndexOf('#');
    const staffId = key.slice(0, split);
    const day = Number(key.slice(split + 1));
    const plannedCode = planned.get(key) ?? '';
    const changed = changes.get(key);
    const plannedHere = plannedCode !== '' && attending(plannedCode);

    if (changed === undefined) {
      if (plannedHere) entries.push({ staffId, day, code: plannedCode, status: 'planned', role: '' });
    } else if (changed === '') {
      // 予定がもともと休みなら「当日いない」と書く意味がない。
      if (plannedHere) entries.push({ staffId, day, code: plannedCode, status: 'absent', role: '' });
    } else if (attending(changed)) {
      entries.push({ staffId, day, code: changed, status: plannedHere ? 'changed' : 'added', role: '' });
    }
  }

  for (const g of db.guests) {
    if (g.period !== period || !attending(g.code)) continue;
    entries.push({ staffId: guestStaffId(g.name), day: g.day, code: g.code, status: 'guest', role: g.role });
  }
  return entries.sort((a, b) => a.day - b.day || (a.staffId < b.staffId ? -1 : a.staffId > b.staffId ? 1 : 0));
}

/** 勤務表に、その日その人の予定があるか（休みを除く）。 */
export function plannedCodeOf(db: Database, period: string, day: number, staffId: string): string {
  return db.confirmed.find((c) => c.period === period && c.day === day && c.staffId === staffId)?.code ?? '';
}

/**
 * 予定外の人を足すときの区分の初期値。その月にいちばん多く出てくる区分にする。
 * 多くの日は日勤なので、たいていそのまま使える。
 */
export function defaultWorkCode(db: Database, period: string, attending: (code: string) => boolean): string {
  const counts = new Map<string, number>();
  for (const c of db.confirmed) {
    if (c.period !== period || !attending(c.code)) continue;
    counts.set(c.code, (counts.get(c.code) ?? 0) + 1);
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
  return best?.[0] ?? '日';
}
