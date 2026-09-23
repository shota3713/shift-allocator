/**
 * 割り振り。実行・結果の閲覧・手修正・学習をひとつの画面で行う。
 *
 * 実行の前に「そもそも埋まらない枠」を診断して見せる。割り振ってから
 * 空欄を見せられても手の打ちようがない。
 */

import type { Ctx } from '../app';
import { el, openSheet, toast } from '../dom';
import { runAssignment } from '../../core/assign';
import { diagnoseFeasibility } from '../../core/feasibility';
import { buildPlan, weekdayOf } from '../../core/plan';
import { buildStats } from '../../core/stats';
import {
  applyLearning,
  buildLearningProposals,
  candidatesForSlot,
  recordCorrection,
  type LearningProposal,
  type SlotCandidate,
  type SlotKey,
} from '../../core/learn';
import { defaultTasks } from '../../core/masters';
import { clearTaskDecisions } from '../../core/skills';
import { newId, nowIso, type Run } from '../../store/db';
import { SLOT_LABELS, SLOT_ORDER, WEEKDAY_LABELS, type Assignment, type Plan } from '../../core/types';

export function renderAssign(root: HTMLElement, ctx: Ctx): void {
  const db = ctx.db;
  const period = ctx.state.period;
  const plan = buildPlan(db, period);

  if (plan.staffIds.length === 0) {
    root.append(el('div', { class: 'empty' },
      el('p', { text: 'この月の勤務表がまだ確定していません。' })));
    return;
  }

  if (plan.tasks.length === 0) {
    root.append(
      el('div', { class: 'notice notice--caution' },
        el('strong', { text: '割り振る業務がまだありません。' }),
        el('span', { text: 'リハ担当・入浴・レクなど、何を割り振るかを決めてください。' })),
      el('div', { class: 'actions' },
        el('button', {
          class: 'btn btn--primary',
          type: 'button',
          text: '標準の業務を作る',
          onclick: () => {
            ctx.update((current) => ({ ...current, tasks: defaultTasks(current.settings.careJobs) }));
          },
        }),
        el('button', {
          class: 'btn btn--quiet',
          type: 'button',
          text: '設定を開く',
          onclick: () => ctx.go('settings'),
        })),
    );
    return;
  }

  renderCapabilityGaps(root, ctx, plan);

  const runs = db.runs.filter((r) => r.period === period)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const active = runs.find((r) => r.runId === ctx.state.runId) ?? runs[0];

  if (!active) {
    renderBeforeRun(root, ctx, plan);
    return;
  }

  renderResult(root, ctx, plan, active, runs);
}

/**
 * 担当できる人が1人もいない業務を、いちばん上で名指しする。
 *
 * この状態の業務は何度割り振っても空欄のまま出てくる。原因は設定の奥に
 * あるので、結果の画面から1回で直せるようにしておく。職種の初期値に戻すのは、
 * ドライバーまで巻き込む「全員にする」より安全なため。
 */
function renderCapabilityGaps(root: HTMLElement, ctx: Ctx, plan: Plan): void {
  const gaps = plan.tasks.filter((task) => (plan.capable.get(task.taskId)?.size ?? 0) === 0);
  if (gaps.length === 0) return;

  root.append(
    el('div', { class: 'notice notice--blocked' },
      el('strong', { text: `${gaps.map((t) => t.name).join('・')} を担当できる人が1人もいません。` }),
      el('span', { text: 'この業務は何度割り振っても空欄のままになります。' })),
    el('div', { class: 'actions', style: 'margin-bottom:var(--step-4)' },
      ...gaps.map((task) => el('button', {
        class: 'btn btn--primary',
        type: 'button',
        text: `${task.name} を職種の初期値に戻す`,
        onclick: () => {
          ctx.update((db) => ({ ...db, skills: clearTaskDecisions(db.skills, task.taskId) }));
          toast(`${task.name} の担当を職種から決め直しました。割り振り直してください。`);
        },
      })),
      el('button', {
        class: 'btn btn--quiet',
        type: 'button',
        text: '設定で選ぶ',
        onclick: () => ctx.go('settings'),
      })),
  );
}

/* ── 実行前 ────────────────────────────────── */

function renderBeforeRun(root: HTMLElement, ctx: Ctx, plan: Plan): void {
  const report = diagnoseFeasibility(plan);

  root.append(
    el('div', { class: 'tally' },
      tally(String(plan.staffIds.length), '出勤者', ''),
      tally(String(plan.workingByDay.size), '営業日', ''),
      tally(String(plan.slots.length), '埋める枠', ''),
      tally(String(report.shortfall), '埋まらない枠', report.ok ? 'settled' : 'caution')),
  );

  if (report.ok) {
    root.append(el('div', { class: 'notice notice--settled', style: 'margin-top:var(--step-4)' },
      el('strong', { text: 'すべての枠を埋められます。' })));
  } else {
    root.append(
      el('div', { class: 'notice notice--caution', style: 'margin-top:var(--step-4)' },
        el('strong', { text: `${report.affectedDayCount}日で、合わせて ${report.shortfall}枠が埋まりません。` }),
        el('span', { text: '実行はできます。埋まらない枠は空欄のまま残ります。' })),
      el('h2', { class: 'section-title', text: '埋まらない枠' }),
      el('div', { class: 'rows' },
        ...report.issues.slice(0, 20).map((issue) =>
          el('div', { class: 'row row--caution' },
            el('div', { class: 'row__main' },
              el('span', { class: 'row__title', text: `${issue.day}日 ${issue.slotLabel}` }),
              el('span', { class: 'row__note', text: issue.message }))))),
    );
    if (report.issues.length > 20) {
      root.append(el('p', { class: 'card__body', text: `ほか ${report.issues.length - 20} 件` }));
    }
  }

  root.append(
    el('div', { class: 'actions actions--sticky' },
      el('button', {
        class: 'btn btn--primary btn--block',
        type: 'button',
        text: '割り振りを実行する',
        onclick: () => execute(ctx, plan),
      })),
  );
}

function execute(ctx: Ctx, plan: Plan): void {
  const settings = ctx.db.settings;
  const result = runAssignment(plan, {
    weightFairnessTotal: settings.weightFairnessTotal,
    weightFairnessTask: settings.weightFairnessTask,
    weightLearnedRule: settings.weightLearnedRule,
    weightPreference: settings.weightPreference,
    improvementPasses: settings.improvementPasses,
  }, settings.seed);

  const run: Run = {
    runId: newId('run'),
    period: plan.periodKey,
    createdAt: nowIso(),
    seed: result.seed,
    cost: result.cost,
    assignments: result.assignments.map((a) => ({
      day: a.day,
      taskId: a.taskId,
      index: a.index,
      staffId: a.staffId,
      origin: 'auto' as const,
    })),
  };

  ctx.update((db) => ({ ...db, runs: [run, ...db.runs] }));
  ctx.go('assign', { runId: run.runId });
}

/* ── 実行後 ────────────────────────────────── */

/**
 * 結果は実行したときの写し。あとから業務を足しても、この結果には入らない。
 * 黙っていると「足したのに割り振られない」と見えるので、ずれを名指しで出す。
 */
function staleTasks(plan: Plan, run: Run): { missing: string[]; extra: string[] } {
  const key = (a: { day: number; taskId: string; index: number }): string =>
    `${a.day}#${a.taskId}#${a.index}`;
  const planned = new Set(plan.slots.map(key));
  const inRun = new Set(run.assignments.map(key));
  const nameOf = (id: string): string => plan.tasksById.get(id)?.name ?? id;

  const missing = [...new Set(plan.slots.filter((s) => !inRun.has(key(s))).map((s) => s.taskId))];
  const extra = [...new Set(
    run.assignments.filter((a) => !planned.has(key(a))).map((a) => a.taskId),
  )];
  return { missing: missing.map(nameOf), extra: extra.map(nameOf) };
}

function renderResult(root: HTMLElement, ctx: Ctx, plan: Plan, run: Run, runs: readonly Run[]): void {
  const assignments: Assignment[] = toAssignments(run, plan);
  const stats = buildStats(assignments, plan);
  const manual = run.assignments.filter((a) => a.origin === 'manual').length;
  const stale = staleTasks(plan, run);

  if (stale.missing.length > 0 || stale.extra.length > 0) {
    root.append(
      el('div', { class: 'notice notice--caution' },
        el('strong', { text: 'この結果は、いまの業務の設定と合っていません。' }),
        stale.missing.length > 0
          ? el('span', { text: `${stale.missing.join('・')} の枠がこの結果に入っていません。` })
          : null,
        stale.extra.length > 0
          ? el('span', { text: `${stale.extra.join('・')} は、いまは割り振らない設定です。` })
          : null,
        el('span', { text: '割り振り直すと反映されます。手修正はやり直しになります。' })),
      el('div', { class: 'actions', style: 'margin-bottom:var(--step-4)' },
        el('button', {
          class: 'btn btn--primary',
          type: 'button',
          text: 'いまの設定で割り振り直す',
          onclick: () => execute(ctx, plan),
        })),
    );
  }

  root.append(
    el('div', { class: 'tally' },
      tally(String(run.assignments.length), '割り当て', ''),
      tally(String(stats.unfilled), '空き枠', stats.unfilled > 0 ? 'caution' : 'settled'),
      tally(String(manual), '手修正', ''),
      tally(run.cost.toFixed(2), 'コスト', '')),
  );

  if (runs.length > 1) {
    const select = el('select', {
      'aria-label': '実行結果',
      onchange: (event: Event) =>
        ctx.go('assign', { runId: (event.currentTarget as HTMLSelectElement).value }),
    }, ...runs.map((r) =>
      el('option', {
        value: r.runId,
        selected: r.runId === run.runId,
        text: new Date(r.createdAt).toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' }),
      })));
    root.append(el('div', { class: 'field', style: 'margin-top:var(--step-4)' },
      el('label', { class: 'field__label', text: '見ている結果' }), select));
  }

  root.append(
    el('h2', { class: 'section-title', text: '公平さ' }),
    ...stats.pools.map((pool) => el('div', { class: 'card' },
      el('div', { class: 'card__title', text: pool.label }),
      el('p', { class: 'card__body',
        text: `${pool.memberCount}人 / 1日あたり負担の最大差 ${pool.spread.toFixed(2)}` }),
      el('div', { class: 'bar', style: 'margin-top:var(--step-2)' },
        el('div', {
          class: pool.spread > 0.5 ? 'bar__fill bar__fill--wide' : 'bar__fill',
          style: `width:${Math.min(100, pool.spread * 100).toFixed(0)}%`,
        })))),
  );

  root.append(el('h2', { class: 'section-title', text: '日ごとの担当' }));
  const days = [...new Set(run.assignments.map((a) => a.day))].sort((a, b) => a - b);
  for (const day of days) {
    root.append(renderDay(ctx, plan, run, day));
  }

  root.append(
    el('div', { class: 'actions actions--sticky' },
      el('button', {
        class: 'btn btn--quiet btn--block',
        type: 'button',
        text: 'もう一度割り振る',
        onclick: () => execute(ctx, plan),
      })),
  );
}

function toAssignments(run: Run, plan: Plan): Assignment[] {
  return run.assignments.map((a) => ({
    day: a.day,
    taskId: a.taskId,
    index: a.index,
    staffId: a.staffId,
    weekday: weekdayOf(plan.year, plan.month, a.day),
  }));
}

function renderDay(ctx: Ctx, plan: Plan, run: Run, day: number): HTMLElement {
  const weekday = WEEKDAY_LABELS[weekdayOf(plan.year, plan.month, day)];
  const rows = SLOT_ORDER.flatMap((slot) =>
    run.assignments
      .filter((a) => plan.tasksById.get(a.taskId)?.slot === slot)
      .filter((a) => a.day === day)
      .sort((a, b) => a.index - b.index)
      .map((a) => {
        const task = plan.tasksById.get(a.taskId);
        const name = a.staffId ? plan.staffNames.get(a.staffId) ?? a.staffId : '';
        // 同じ業務が複数人なら「1人目 / 2人目」を出す。
        // どの枠を触っているのか分からないと、直したつもりが別の枠になる。
        const seat = (task?.headcount ?? 1) > 1 ? `${a.index + 1}人目` : '';
        return el('button', {
          class: a.staffId ? 'row' : 'row row--blocked',
          type: 'button',
          style: 'text-align:left;cursor:pointer',
          onclick: () => openCorrection(ctx, plan, run, { day, taskId: a.taskId, index: a.index }),
        },
          el('div', { class: 'row__main' },
            el('span', { class: 'row__title',
              text: seat ? `${task?.name ?? a.taskId}（${seat}）` : task?.name ?? a.taskId }),
            el('span', { class: 'row__note', text: name || '担当できる人がいません' })),
          el('span', {
            class: a.origin === 'manual' ? 'pill pill--caution' : `pill`,
            text: a.origin === 'manual' ? '手修正' : SLOT_LABELS[slot],
          }));
      }));

  return el('details', { class: 'card', style: 'padding:0' },
    el('summary', {
      style: 'padding:var(--step-4);cursor:pointer;font-weight:700;list-style:none',
      text: `${day}日（${weekday}）`,
    }),
    el('div', { class: 'rows', style: 'padding:0 var(--step-4) var(--step-4)' }, ...rows));
}

/* ── 手修正と学習 ──────────────────────────── */

const GROUP_LABELS: Record<SlotCandidate['group'], string> = {
  ready: 'そのまま入れられる人',
  limited: '入れると無理が出る人',
  absent: 'この時間帯は現場にいない人',
};

function optionsFor(candidates: readonly SlotCandidate[], current: string): HTMLElement[] {
  const groups: SlotCandidate['group'][] = ['ready', 'limited', 'absent'];
  return groups.flatMap((group) => {
    const members = candidates.filter((c) => c.group === group);
    if (members.length === 0) return [];
    return [el('optgroup', { label: `${GROUP_LABELS[group]}（${members.length}人）` },
      ...members.map((c) =>
        el('option', {
          value: c.staffId,
          text: `${c.name}　${c.note}`,
          selected: c.staffId === current,
        })))];
  });
}

/**
 * 枠1つの担当を差し替える。
 *
 * 選択肢は制約を満たす人だけに絞らない。絞ると「この人にしたい」ができず、
 * 結局アプリの外で直すことになる。入れられない人も理由付きで出して、
 * 決めるのは人に任せる。
 */
function openCorrection(ctx: Ctx, plan: Plan, run: Run, key: SlotKey): void {
  const current = run.assignments.find(
    (a) => a.day === key.day && a.taskId === key.taskId && a.index === key.index,
  );
  const task = plan.tasksById.get(key.taskId);
  const assignments = toAssignments(run, plan);
  const candidates = candidatesForSlot(assignments, plan, key);
  const readyCount = candidates.filter((c) => c.ok).length;

  // 同じ日の同じ業務で、他の枠に入っている人。取り違えを防ぐために見せる。
  const siblings = run.assignments
    .filter((a) => a.day === key.day && a.taskId === key.taskId && a.index !== key.index && a.staffId)
    .sort((a, b) => a.index - b.index)
    .map((a) => `${a.index + 1}人目 ${plan.staffNames.get(a.staffId) ?? a.staffId}`);

  const select = el('select', { 'aria-label': '担当' },
    el('option', { value: '', text: '空きにする', selected: !current?.staffId }),
    ...optionsFor(candidates, current?.staffId ?? ''));

  const reason = el('textarea', {
    placeholder: '例）腰を痛めているので当面は外したい',
    'aria-label': '変更の理由',
  });

  const seat = (task?.headcount ?? 1) > 1 ? `（${key.index + 1}人目）` : '';

  const close = openSheet({
    title: `${key.day}日 ${task?.name ?? key.taskId}${seat}`,
    lead: candidates.length === 0
      ? 'この日に出勤している人がいません。'
      : `この枠だけを入れ替えます。そのまま入れられる人は ${readyCount}人です。`,
    body: el('div', {},
      task && task.preferOrder.length > 0
        ? el('p', { class: 'field__hint', style: 'margin-bottom:var(--step-3)',
            text: task.note || '' })
        : null,
      siblings.length > 0
        ? el('p', { class: 'field__hint', style: 'margin-bottom:var(--step-3)',
            text: `同じ日の他の枠: ${siblings.join(' / ')}` })
        : null,
      el('div', { class: 'field' },
        el('label', { class: 'field__label', text: '担当' }), select),
      el('div', { class: 'field' },
        el('label', { class: 'field__label', text: '理由（任意）' }),
        el('span', { class: 'field__hint', text: '今後も反映するかの判断に使います。' }),
        reason),
      el('div', { class: 'actions' },
        el('button', {
          class: 'btn btn--primary',
          type: 'button',
          text: 'この枠を変更する',
          onclick: () => {
            const before = current?.staffId ?? '';
            const after = select.value;
            if (before === after) {
              close();
              return;
            }
            ctx.update((db) => recordCorrection(db, {
              runId: run.runId,
              period: plan.periodKey,
              day: key.day,
              taskId: key.taskId,
              index: key.index,
              staffBefore: before,
              staffAfter: after,
              reason: reason.value.trim(),
            }).db);
            close();
            offerLearning(ctx, plan, key.day, key.taskId, before, after);
          },
        }),
        el('button', { class: 'btn btn--quiet', type: 'button', text: 'やめる', onclick: () => close() }))),
  });
}

/**
 * 「今後も反映しますか？」を聞く。
 *
 * 初期値は必ず「今回だけ」。黙って選ばれた案が通ると、一度きりの事情が
 * 恒久ルールとして積み上がる。人が明示的に選んだものだけをルールにする。
 */
function offerLearning(
  ctx: Ctx,
  plan: Plan,
  day: number,
  taskId: string,
  before: string,
  after: string,
): void {
  const db = ctx.db;
  const correction = db.corrections[db.corrections.length - 1];
  const proposals = buildLearningProposals(
    db, plan.periodKey, day, taskId, before, after, correction?.correctionId ?? '',
  );
  if (proposals.length === 0) return;

  const name = 'learning-choice';
  const options = [
    ...proposals.map((proposal, index) => ({ proposal, value: `${index}`, label: proposal.label })),
    { proposal: null, value: 'none', label: '今回だけにする' },
  ];

  const close = openSheet({
    title: '今後も反映しますか？',
    lead: '選んだものだけがルールになります。あとから設定で取り消せます。',
    body: el('div', {},
      el('div', { class: 'choice' },
        ...options.map((option, index) => {
          return el('label', { class: 'choice__option' },
            el('input', {
              type: 'radio',
              name,
              value: option.value,
              checked: option.value === 'none',
            }),
            el('span', { class: 'choice__text' },
              el('span', { class: 'choice__label', text: option.label }),
              option.proposal && option.proposal.evidence > 0
                ? el('span', { class: 'choice__why',
                    text: `同じ修正が過去に ${option.proposal.evidence} 回ありました` })
                : index === options.length - 1
                  ? el('span', { class: 'choice__why', text: 'ルールを作りません' })
                  : null));
        })),
      el('div', { class: 'actions' },
        el('button', {
          class: 'btn btn--primary',
          type: 'button',
          text: '決定',
          onclick: () => {
            const chosen = document.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`);
            const value = chosen?.value ?? 'none';
            if (value !== 'none' && correction) {
              const proposal = proposals[Number(value)] as LearningProposal;
              ctx.update((current) => applyLearning(current, correction.correctionId, proposal));
              toast('次回から反映します。');
            }
            close();
            ctx.refresh();
          },
        }))),
    onClose: () => ctx.refresh(),
  });
}

function tally(value: string, label: string, tone: string): HTMLElement {
  return el('div', { class: tone ? `tally__item tally__item--${tone}` : 'tally__item' },
    el('span', { class: 'tally__value', text: value }),
    el('span', { class: 'tally__label', text: label }));
}
