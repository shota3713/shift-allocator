/**
 * 現場から届いた改修要望の決まり。
 *   - SS（ショートステイ）の人はヘルプに行くのでデイの割り振りに入れない
 *   - 当日の配置（欠勤・予定外の出勤・OJT/応援）は予定とは別に持ち、割り振りは当日の配置で組む
 *   - 朝の受け入れは 食事・飲み物を割り振り、連絡帳はその日の連絡帳係、洗面は残り全員
 *   - 夕方清掃は決まった人が来た日に入る
 *   - 短縮名があれば表にはそちらを出す
 */

import { describe, expect, test } from 'vitest';
import { runAssignment } from '../src/core/assign';
import { deriveAssignments } from '../src/core/derived';
import { defaultTasks } from '../src/core/masters';
import { buildPlan } from '../src/core/plan';
import { guestStaffId } from '../src/core/roster';
import { PRESENCE, SHIFT_KIND, readShiftCode } from '../src/core/shiftCode';
import { DEFAULT_SETTINGS, SLOT, type Task } from '../src/core/types';
import { staleRun } from '../src/core/stale';
import { buildWeeklySheets, formatHours } from '../src/core/weekly';
import { importBackup, setRosterChange, type Database } from '../src/store/db';
import { EARLY, databaseWith, staff, task } from './helpers';

const period = '2026-09';
const CARE = '介護職員';

const BATH = task({ taskId: 'BATH', name: '入浴担当', slot: SLOT.AM, eligibleJob: [CARE] });

function run(db: Database) {
  const plan = buildPlan(db, period);
  const result = runAssignment(plan, { ...DEFAULT_SETTINGS, improvementPasses: 200 }, 1);
  return { plan, assignments: result.assignments };
}

describe('SS（ショートステイ）へのヘルプ', () => {
  test('SS の区分はデイにいない（フリー扱い）と読む', () => {
    const meaning = readShiftCode('日_032SS');
    expect(meaning.kind).toBe(SHIFT_KIND.SS_HELP);
    expect(meaning.am).toBe(PRESENCE.FREE);
    expect(meaning.pm).toBe(PRESENCE.FREE);
    expect(readShiftCode('日_032DS').kind).toBe(SHIFT_KIND.DAY);
  });

  test('SS の日の人は割り振りの対象にも人数にも入らないが、出勤の一覧には SSヘルプで出る', () => {
    const db = databaseWith({
      period,
      staff: [staff('a', '甲', CARE), staff('b', '乙', CARE)],
      tasks: [BATH],
      days: [1, 2],
      codes: { b: { 1: '日_032SS' } },
    });
    // 古い保存データは SS も「1日 現場」で登録している。それでもデイには数えない。
    const withOldType: Database = {
      ...db,
      shiftTypes: [...db.shiftTypes, {
        code: '日_032SS', label: '日', isWorking: true, hours: 8, aliases: [],
        am: PRESENCE.WORK, pm: PRESENCE.WORK,
      }],
    };
    const { plan, assignments } = run(withOldType);

    expect(plan.workingByDay.get(1)).toEqual(['a']);
    expect(plan.workingByDay.get(2)).toEqual(['a', 'b']);
    expect(assignments.filter((a) => a.day === 1).map((a) => a.staffId)).toEqual(['a']);
    const helper = plan.attendance.get(1)?.find((e) => e.staffId === 'b');
    expect(helper?.kind).toBe(SHIFT_KIND.SS_HELP);
  });
});

describe('当日の実際の配置', () => {
  const base = (): Database => databaseWith({
    period,
    staff: [staff('a', '甲', CARE), staff('b', '乙', CARE), staff('c', '丙', CARE)],
    tasks: [BATH],
    days: [1],
    off: { c: [1] },
  });

  test('予定はあったが当日いない人は割り振りから外れ、一覧では「当日不在」になる', () => {
    const db = setRosterChange(base(), period, 1, 'a', '');
    const plan = buildPlan(db, period);

    expect(plan.workingByDay.get(1)).toEqual(['b']);
    expect(plan.attendance.get(1)?.find((e) => e.staffId === 'a')?.status).toBe('absent');
    // 予定（勤務表）は書き換えない。
    expect(db.confirmed.find((c) => c.staffId === 'a' && c.day === 1)?.code).toBe('日勤');
  });

  test('予定にない人を当日の配置に足すと、ほかの人と同じように割り振られる', () => {
    const db = setRosterChange(setRosterChange(base(), period, 1, 'a', ''), period, 1, 'b', '');
    const added = setRosterChange(db, period, 1, 'c', '日勤');
    const { plan, assignments } = run(added);

    expect(plan.workingByDay.get(1)).toEqual(['c']);
    expect(plan.attendance.get(1)?.find((e) => e.staffId === 'c')?.status).toBe('added');
    expect(assignments.map((a) => a.staffId)).toEqual(['c']);
  });

  test('予定どおりに戻すと差分が消える', () => {
    const changed = setRosterChange(base(), period, 1, 'a', '');
    expect(setRosterChange(changed, period, 1, 'a', null).roster).toHaveLength(0);
  });

  test('OJT・応援の人は日ごとに何人でも足せて、職種の初期値で業務を担当する', () => {
    const db: Database = {
      ...setRosterChange(setRosterChange(base(), period, 1, 'a', ''), period, 1, 'b', ''),
      guests: [
        { guestId: 'g1', period, day: 1, name: '応援 太郎', role: '応援', job: CARE, code: '日勤' },
        { guestId: 'g2', period, day: 1, name: '研修 花子', role: 'OJT', job: CARE, code: '日勤' },
        { guestId: 'g3', period, day: 2, name: '研修 花子', role: 'OJT', job: CARE, code: '日勤' },
      ],
    };
    const plan = buildPlan(db, period);
    const trainee = guestStaffId('研修 花子');

    expect(plan.workingByDay.get(1)).toHaveLength(2);
    // 同じ名前は同じ人として数える（負担の公平さを月で見るため）。
    expect(plan.workingByStaff.get(trainee)).toEqual(new Set([1, 2]));
    expect(plan.staffNames.get(trainee)).toBe('研修 花子（OJT）');
    expect(plan.capable.get('BATH')?.has(trainee)).toBe(true);
    expect(plan.attendance.get(1)?.filter((e) => e.status === 'guest')).toHaveLength(2);
  });
});

describe('朝の受け入れ', () => {
  const NURSE = '看護職員';
  const tasks: Task[] = defaultTasks([CARE]).filter((t) =>
    t.slot === SLOT.MORNING || t.taskId === 'RENRAKU');
  const everyone = ['a', 'b', 'c', 'd', 'e', 'n1', 'n2'];

  function morning() {
    const db = databaseWith({
      period,
      staff: [
        ...['a', 'b', 'c', 'd', 'e'].map((id) => staff(id, id.toUpperCase(), CARE)),
        staff('n1', '看護一', NURSE),
        staff('n2', '看護二', NURSE),
      ],
      tasks,
      days: [1, 2, 3],
      off: { n2: [3] },
    });
    return run(db);
  }

  const seatsOf = (assignments: readonly { day: number; taskId: string; staffId: string }[], day: number, taskId: string) =>
    assignments.filter((a) => a.day === day && a.taskId === taskId).map((a) => a.staffId);

  test('食事・飲み物・バイタルを割り振り、朝の連絡帳と洗面は計算に乗せない', () => {
    const { plan } = morning();
    expect(new Set(plan.slots.map((s) => s.taskId)))
      .toEqual(new Set(['MORNING_MEAL', 'MORNING_DRINK', 'MORNING_VITAL', 'RENRAKU']));
    expect(plan.derivedTasks.map((t) => t.taskId)).toEqual(['MORNING_RENRAKU', 'MORNING_WASH']);
  });

  test('バイタルは看護師2人。看護師が1人の日は1人にして、空きは出さない', () => {
    const { assignments } = morning();
    expect(new Set(seatsOf(assignments, 1, 'MORNING_VITAL'))).toEqual(new Set(['n1', 'n2']));
    expect(seatsOf(assignments, 3, 'MORNING_VITAL')).toEqual(['n1']);
  });

  test('連絡帳係には朝のほかの業務を持たせない', () => {
    const { assignments } = morning();
    for (const day of [1, 2, 3]) {
      const renraku = assignments.find((a) => a.day === day && a.taskId === 'RENRAKU')?.staffId;
      const morningTasks = assignments.filter((a) => a.day === day && a.taskId.startsWith('MORNING_'));
      expect(renraku).toBeTruthy();
      expect(morningTasks.map((a) => a.staffId)).not.toContain(renraku);
    }
  });

  test('朝の連絡帳はその日の連絡帳係、洗面は朝にいて何も持たない人全員', () => {
    const { plan, assignments } = morning();
    const all = [...assignments, ...deriveAssignments(plan, assignments)];

    for (const day of [1, 2, 3]) {
      const here = day === 3 ? everyone.filter((id) => id !== 'n2') : everyone;
      expect(seatsOf(all, day, 'MORNING_RENRAKU')).toEqual(seatsOf(all, day, 'RENRAKU'));
      const busy = ['MORNING_MEAL', 'MORNING_DRINK', 'MORNING_VITAL', 'MORNING_RENRAKU']
        .flatMap((taskId) => seatsOf(all, day, taskId));
      const wash = seatsOf(all, day, 'MORNING_WASH');
      expect(new Set([...busy, ...wash])).toEqual(new Set(here));
      expect(wash.filter((id) => busy.includes(id))).toEqual([]);
    }
  });

  test('連絡帳係を手で替えると朝の連絡帳もついて来る', () => {
    const { plan, assignments } = morning();
    const swapped = assignments.map((a) => (a.day === 1 && a.taskId === 'RENRAKU' ? { ...a, staffId: 'e' } : a));
    const derived = deriveAssignments(plan, swapped);
    expect(derived.find((a) => a.day === 1 && a.taskId === 'MORNING_RENRAKU')?.staffId).toBe('e');
  });

  test('表には設定の並び順で 食事・飲み物・連絡帳・洗面・BP（バイタル） と並ぶ', () => {
    const { plan, assignments } = morning();
    const names = buildWeeklySheets(plan, assignments)[0]?.rows
      .filter((r) => r.slot === SLOT.MORNING).map((r) => r.name);
    expect(names).toEqual(['食事', '飲み物', '連絡帳（朝）', '洗面', 'BP（バイタル）']);
  });
});

describe('午前フリー・午後フリー', () => {
  const NURSE = '看護職員';
  const tasks: Task[] = defaultTasks([CARE]).filter((t) => t.slot === SLOT.AM || t.taskId === 'FREE_PM');

  function withCare(count: number) {
    const db = databaseWith({
      period,
      staff: [
        staff('n1', '看護一', NURSE),
        ...Array.from({ length: count }, (_, i) => staff(`c${i}`, `介護${i}`, CARE)),
      ],
      tasks,
      days: [1, 2, 3],
    });
    return run(db);
  }

  const countOn = (slots: readonly { day: number; taskId: string }[], taskId: string) =>
    slots.filter((s) => s.day === 1 && s.taskId === taskId).length;

  test('ほかの業務でちょうど埋まる日は、午前フリーを立てない', () => {
    // 入浴3・リハ2・看護1 で6人。
    const { plan } = withCare(5);
    expect(countOn(plan.slots, 'FREE_AM')).toBe(0);
    expect(countOn(plan.slots, 'REHA_AM')).toBe(2);
  });

  test('人が足りない日は、リハより先にフリーを落とす', () => {
    const { plan } = withCare(4);
    expect(countOn(plan.slots, 'FREE_AM')).toBe(0);
    expect(countOn(plan.slots, 'REHA_AM')).toBe(1);
  });

  test('フリーはほかの業務より後に当てる。埋められなければ空きにせず立てない', () => {
    // 看護師はバイタルで朝が埋まり、朝の連絡帳と重なるので午後の連絡帳を持てない。
    // 人数だけ見れば午後の3枠は埋まるが、実際には連絡帳を介護職員で埋めるとフリーの人が残らない。
    const picked = defaultTasks([CARE]).filter((t) =>
      ['MORNING_VITAL', 'MORNING_RENRAKU', 'RENRAKU', 'FREE_PM', 'REHA_PM'].includes(t.taskId));
    const db = databaseWith({
      period,
      staff: [staff('n1', '看護一', NURSE), staff('c0', '介護0', CARE), staff('c1', '介護1', CARE)],
      tasks: picked,
      days: [1],
    });
    const { assignments } = run(db);

    expect(assignments.find((a) => a.taskId === 'RENRAKU')?.staffId).toMatch(/^c/);
    expect(assignments.find((a) => a.taskId === 'REHA_PM')?.staffId).toMatch(/^c/);
    expect(assignments.filter((a) => a.taskId === 'FREE_PM')).toEqual([]);
  });

  test('先に入れた人を入れ替えてでも、決まった業務の空きを埋めてからフリーを立てる', () => {
    // 看護師はバイタルで連絡帳を持てず、入浴リーダーとレクリーダーも連絡帳を持てない（同じ日にリーダーは1つ）。
    // 担当できる人の数の順に当てると、手作業が連絡帳を書ける人を先に取ってしまう。
    const picked = defaultTasks([CARE]).filter((t) =>
      ['MORNING_VITAL', 'MORNING_RENRAKU', 'BATH_LEAD', 'RENRAKU', 'REC_LEAD', 'REHA_PM', 'HANDWORK', 'FREE_PM']
        .includes(t.taskId));
    const db = databaseWith({
      period,
      staff: [staff('n1', '看護一', NURSE), ...['c0', 'c1', 'c2', 'c3', 'c4'].map((id) => staff(id, id, CARE))],
      tasks: picked,
      days: [1, 2, 3, 4, 5],
    });
    const { assignments } = run(db);

    for (const day of [1, 2, 3, 4, 5]) {
      const onDay = assignments.filter((a) => a.day === day && a.taskId !== 'FREE_PM');
      expect(onDay.filter((a) => !a.staffId).map((a) => a.taskId)).toEqual([]);
    }
  });

  test('人が余った日だけ立てて、午前と午後は別の人にする', () => {
    const { plan, assignments } = withCare(6);
    expect(countOn(plan.slots, 'FREE_AM')).toBe(1);
    for (const day of [1, 2, 3]) {
      const am = assignments.find((a) => a.day === day && a.taskId === 'FREE_AM')?.staffId;
      const pm = assignments.find((a) => a.day === day && a.taskId === 'FREE_PM')?.staffId;
      expect(am).toBeTruthy();
      expect(pm).toBeTruthy();
      expect(am).not.toBe(pm);
    }
  });
});

describe('夕方清掃', () => {
  const clean = defaultTasks([CARE]).find((t) => t.taskId === 'EVENING_CLEAN') as Task;

  test('決まった人が来た日だけ入る。清掃だけの勤務でも入る', () => {
    const db = databaseWith({
      period,
      staff: [staff('a', '甲', CARE), staff('y', '乙', '清掃員')],
      tasks: [BATH, { ...clean, fixedStaffId: 'y' }],
      days: [1, 2, 3],
      off: { y: [3] },
      codes: { y: { 1: '清掃_032DS' } },
    });
    const { plan, assignments } = run(db);
    const derived = deriveAssignments(plan, assignments).filter((a) => a.taskId === 'EVENING_CLEAN');

    expect(plan.slots.some((s) => s.taskId === 'EVENING_CLEAN')).toBe(false);
    expect(derived.map((a) => [a.day, a.staffId])).toEqual([[1, 'y'], [2, 'y']]);
  });

  test('担当が決まっていなければ空きの枠を出す', () => {
    const db = databaseWith({ period, staff: [staff('a', '甲', CARE)], tasks: [BATH, clean], days: [1] });
    const plan = buildPlan(db, period);
    expect(deriveAssignments(plan, [])).toEqual([{ day: 1, taskId: 'EVENING_CLEAN', index: 0, staffId: '' }]);
  });
});

describe('週ごとの表', () => {
  test('短縮名で出し、出勤の欄を区分ごとに時刻付きで並べる', () => {
    const db = databaseWith({
      period,
      staff: [{ ...staff('a', '甲野 一', CARE), displayName: 'タロ' }, staff('b', '乙川', CARE)],
      tasks: [BATH],
      days: [1],
      codes: { b: { 1: EARLY.code } },
    });
    const withTimes: Database = {
      ...db,
      shiftTypes: db.shiftTypes.map((t) => (t.code === EARLY.code ? { ...t, startTime: '7:30', endTime: '16:30' } : t)),
    };
    const { plan, assignments } = run(withTimes);
    const sheet = buildWeeklySheets(plan, assignments)[0];

    expect(sheet?.attendance.map((r) => r.label)).toEqual(['早番', '日勤']);
    expect(sheet?.attendance[0]?.cells[1])
      .toEqual([{ name: '乙川', startTime: '7:30', endTime: '16:30', status: 'planned', role: '' }]);
    expect(formatHours('7:30', '16:30')).toBe('7:30〜16:30');
    expect(formatHours('7:30', '')).toBe('7:30');
    expect(sheet?.attendance[1]?.cells[1]?.[0]?.name).toBe('タロ');
    expect(sheet?.rows[0]?.cells[1]?.length).toBe(1);
  });
});

describe('ドライバー', () => {
  test('職種がドライバーの人も送迎の区分の人も、出勤の欄で別の行にまとめる', () => {
    const db = databaseWith({
      period,
      staff: [staff('a', '甲', CARE), staff('d1', '運転一', 'ドライバー'), staff('d2', '運転二', CARE)],
      tasks: [BATH],
      days: [1],
      codes: { d2: { 1: '送迎_032DS' } },
    });
    const plan = buildPlan(db, period);
    const sheet = buildWeeklySheets(plan, [])[0];

    expect(sheet?.attendance.map((r) => r.label)).toEqual(['日勤', 'ドライバー']);
    const drivers = sheet?.attendance.find((r) => r.kind === 'DRIVER')?.cells[1]?.map((c) => c.name);
    expect(drivers).toEqual(['運転一', '運転二']);
  });
  test('洗面（残り全員）にはドライバーなど担当できない職種の人を入れない', () => {
    const tasks = defaultTasks([CARE]).filter((t) => ['MORNING_MEAL', 'MORNING_WASH'].includes(t.taskId));
    const db = databaseWith({
      period,
      staff: [staff('a', '甲', CARE), staff('b', '乙', CARE), staff('d1', '運転一', 'ドライバー')],
      tasks,
      days: [1],
    });
    const { plan, assignments } = run(db);
    const wash = deriveAssignments(plan, assignments).filter((a) => a.taskId === 'MORNING_WASH').map((a) => a.staffId);
    expect(wash).toHaveLength(1);
    expect(wash).not.toContain('d1');
  });
});

describe('手作業を空きにしない', () => {
  const NURSE = '看護職員';
  const pick = (ids: readonly string[]): Task[] => defaultTasks([CARE]).filter((t) => ids.includes(t.taskId));

  test('2人目に入れる人がいなければ、その日は1人にして空きを出さない', () => {
    // 看護師はバイタルで連絡帳を持てず、手作業もできない。人数だけ見れば3枠埋まるが実際は2枠。
    const db = databaseWith({
      period,
      staff: [staff('n1', '看護一', NURSE), staff('c0', '介護0', CARE), staff('c1', '介護1', CARE)],
      tasks: pick(['MORNING_VITAL', 'MORNING_RENRAKU', 'RENRAKU', 'HANDWORK']),
      days: [1],
    });
    const { plan, assignments } = run(db);
    const handwork = assignments.filter((a) => a.taskId === 'HANDWORK');

    expect(handwork).toHaveLength(1);
    expect(handwork[0]?.staffId).toMatch(/^c/);
    expect(assignments.filter((a) => !a.staffId)).toEqual([]);
    // 減らした枠は「設定と合っていない」とは言わない。
    expect(staleRun(plan, { assignments }).missing).toEqual([]);
  });

  test('1人も入れない日は、連絡帳・レク以外の午後の業務の人が掛け持ちで入る', () => {
    const db = databaseWith({
      period,
      staff: ['c0', 'c1', 'c2'].map((id) => staff(id, id, CARE)),
      tasks: pick(['RENRAKU', 'REC_LEAD', 'REHA_PM', 'HANDWORK']),
      days: [1],
    });
    const { assignments } = run(db);
    const of = (taskId: string) => assignments.find((a) => a.taskId === taskId)?.staffId;

    expect(assignments.filter((a) => !a.staffId)).toEqual([]);
    expect(of('HANDWORK')).toBe(of('REHA_PM'));
    expect(of('HANDWORK')).not.toBe(of('RENRAKU'));
    expect(of('HANDWORK')).not.toBe(of('REC_LEAD'));
  });
});

describe('あとから加わった標準の業務', () => {
  const oldData = (extra: Record<string, unknown> = {}) => JSON.stringify({
    tasks: [{ taskId: 'REHA_AM', name: 'リハ担当', slot: 'AM', headcount: 2, active: true }],
    settings: {},
    ...extra,
  });

  test('古い保存データには朝の受け入れ・フリー・夕方清掃を自動で足す', () => {
    const restored = importBackup(oldData());
    const ids = restored.tasks.map((t) => t.taskId);
    expect(ids).toEqual(expect.arrayContaining([
      'MORNING_MEAL', 'MORNING_DRINK', 'MORNING_RENRAKU', 'MORNING_WASH', 'MORNING_VITAL',
      'FREE_AM', 'FREE_PM', 'EVENING_CLEAN',
    ]));
    expect(restored.settings.offeredBuiltIns).toContain('MORNING_MEAL');
  });

  test('一度足したあとで人が消した業務は、読み込み直しても戻さない', () => {
    const restored = importBackup(oldData());
    const removed = { ...restored, tasks: restored.tasks.filter((t) => t.taskId !== 'FREE_AM') };
    const again = importBackup(JSON.stringify(removed));
    expect(again.tasks.some((t) => t.taskId === 'FREE_AM')).toBe(false);
    expect(again.tasks.filter((t) => t.taskId === 'MORNING_MEAL')).toHaveLength(1);
  });

  test('業務がまだ無いデータには足さない。旧い名前「バイタル」は BP（バイタル）に直す', () => {
    expect(importBackup(JSON.stringify({ tasks: [], settings: {} })).tasks).toEqual([]);
    const renamed = importBackup(JSON.stringify({
      tasks: [{ taskId: 'MORNING_VITAL', name: 'バイタル', slot: 'MORNING', headcount: 2, active: true }],
      settings: {},
    }));
    expect(renamed.tasks.find((t) => t.taskId === 'MORNING_VITAL')?.name).toBe('BP（バイタル）');
  });
});

describe('古い保存データ', () => {
  test('組み込みの業務には決まり方を補い、用紙の既定は A4', () => {
    const restored = importBackup(JSON.stringify({
      tasks: [{ taskId: 'MORNING_WASH', name: '洗面', slot: 'MORNING', headcount: 1, active: true }],
      settings: {},
    }));
    expect(restored.tasks[0]?.derive).toBe('rest');
    expect(restored.tasks[0]?.fixedStaffId).toBe('');
    expect(restored.settings.paperSize).toBe('A4');
    // 0 は「人が余った日だけ」。読み込みで 1 に戻さない。
    expect(importBackup(JSON.stringify({ tasks: [{ taskId: 'X', name: 'x', slot: 'AM', headcount: 1, minHeadcount: 0 }] }))
      .tasks[0]?.minHeadcount).toBe(0);
    expect(restored.roster).toEqual([]);
    expect(restored.guests).toEqual([]);
  });
});
