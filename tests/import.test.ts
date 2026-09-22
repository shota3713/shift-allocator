/**
 * 取り込みから確定まで。
 * 未解決を1件でも残したまま確定できないこと、実物のPDFから通しで確定まで
 * 到達できることを確かめる。
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildImportReview, commitImport, addStaff, upsertShiftTypes, periodKeyOf } from '../src/core/import';
import { planMasterChanges, staffIdFor, defaultTasks } from '../src/core/masters';
import { parseShiftTable } from '../src/pdf/shiftTable';
import { FLAG } from '../src/core/resolve';
import { buildPlan } from '../src/core/plan';
import { emptyDatabase, type Database } from '../src/store/db';
import type { PageText } from '../src/pdf/types';
import type { ShiftType, Staff } from '../src/core/types';

const fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures/shift-geometry.json'), 'utf8'),
) as PageText[];
const parsed = parseShiftTable(fixture);

describe('年月キー', () => {
  it('ゼロ詰めで揃える', () => {
    expect(periodKeyOf(2026, 9)).toBe('2026-09');
  });

  it('読めなければ空にする', () => {
    expect(periodKeyOf(null, null)).toBe('');
  });
});

describe('初回の取り込み', () => {
  const db = emptyDatabase();
  const changes = planMasterChanges(parsed, db.staff, db.aliases, db.shiftTypes);

  it('名簿をPDFから起こす', () => {
    expect(changes.newStaff.length).toBe(22);
    expect(changes.newStaff[0]?.name).toBe('東太郎');
    expect(changes.newStaff[0]?.job).toBe('介護職員');
  });

  it('出てきた勤務区分を洗い出す', () => {
    expect(changes.newCodes.length).toBeGreaterThan(3);
    const off = changes.newCodes.find((c) => c.code === '休');
    expect(off?.isWorking).toBe(false);
    const work = changes.newCodes.find((c) => c.code === '日_032DS');
    expect(work?.isWorking).toBe(true);
  });

  it('名簿が空なら全員が未解決になる', () => {
    const review = buildImportReview(parsed, db);
    expect(review.rows.every((r) => r.nameFlag === FLAG.BLOCK)).toBe(true);
    expect(review.blockCount).toBeGreaterThan(0);
  });

  it('未解決が残っていると確定できない', () => {
    const review = buildImportReview(parsed, db);
    expect(() => commitImport(db, review)).toThrow(/未解決/u);
  });
});

/** 提案をすべて受け入れてマスタを作る。実際の初回操作をなぞる。 */
function acceptAll(db: Database): Database {
  const changes = planMasterChanges(parsed, db.staff, db.aliases, db.shiftTypes);
  const additions: Staff[] = [];
  for (const proposal of changes.newStaff) {
    additions.push({
      staffId: staffIdFor(proposal.name, [...db.staff, ...additions]),
      name: proposal.name,
      job: proposal.job,
      active: true,
      note: '',
    });
  }
  const types: ShiftType[] = changes.newCodes.map((c) => ({
    code: c.code,
    label: c.code,
    isWorking: c.isWorking,
    hours: c.isWorking ? 8 : 0,
    aliases: [],
    am: c.am,
    pm: c.pm,
  }));
  return upsertShiftTypes(addStaff(db, additions), types);
}

describe('マスタを作ったあとの取り込み', () => {
  const db = acceptAll(emptyDatabase());
  const review = buildImportReview(parsed, db);

  it('未解決がひとつも残らない', () => {
    expect(review.blockCount).toBe(0);
    expect(review.reviewCount).toBe(0);
  });

  it('対象の年月を取れる', () => {
    expect(review.periodKey).toBe('2026-09');
  });

  it('確定すると全員ぶんの勤務日が入る', () => {
    const committed = commitImport(db, review);
    expect(committed.confirmed.length).toBe(22 * 30);
    expect(committed.confirmed.every((c) => c.period === '2026-09')).toBe(true);
  });

  it('同じ月を取り込み直しても重複しない', () => {
    const once = commitImport(db, review);
    const twice = commitImport(once, buildImportReview(parsed, once));
    expect(twice.confirmed.length).toBe(once.confirmed.length);
  });

  it('確定した勤務日から振り分けの前提を組める', () => {
    const committed = commitImport(db, review);
    const withTasks = { ...committed, tasks: defaultTasks(committed.settings.careJobs) };
    const plan = buildPlan(withTasks, '2026-09');
    expect(plan.staffIds.length).toBeGreaterThan(10);
    // 30日のうち、誰も出勤しない日（休業日）は枠が立たない。
    expect(plan.workingByDay.size).toBe(26);
    expect(plan.slots.length).toBeGreaterThan(0);
  });

  it('担当できる人の設定は、取り込み直しても残る', () => {
    // 名簿を毎月作り直さず、取り込みで起こしているので、設定が消えないことが要。
    const tasks = defaultTasks(db.settings.careJobs);
    const someone = db.staff[0]!;
    const configured: Database = {
      ...db,
      tasks,
      skills: [{ staffId: someone.staffId, taskIds: ['BATH'] }],
    };

    const again = acceptAll(commitImport(configured, buildImportReview(parsed, configured)));
    expect(again.skills).toEqual(configured.skills);

    const plan = buildPlan(again, '2026-09');
    expect(plan.capable.get('BATH')?.has(someone.staffId)).toBe(true);
    expect(plan.capable.get('REC_LEAD')?.has(someone.staffId)).toBe(false);
  });

  it('休みの日は出勤扱いにしない', () => {
    const committed = commitImport(db, review);
    const withTasks = { ...committed, tasks: defaultTasks(committed.settings.careJobs) };
    const plan = buildPlan(withTasks, '2026-09');
    const first = plan.staffIds[0]!;
    const workdays = plan.workingByStaff.get(first)!.size;
    expect(workdays).toBeGreaterThan(0);
    expect(workdays).toBeLessThan(30);
  });
});
