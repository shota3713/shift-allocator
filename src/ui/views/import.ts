/**
 * 取り込み。PDFを選んで、その場で読む。
 *
 * 読み取りは端末内で完結する。外へは何も送らない。
 * 読めなかった欄は埋めずに残し、次の確認画面で人に直させる。
 */

import type { Ctx } from '../app';
import { el } from '../dom';
import { readPdfText } from '../../pdf/loadPdf';
import { parseShiftTable } from '../../pdf/shiftTable';
import { addStaff, buildImportReview, upsertShiftTypes } from '../../core/import';
import { planMasterChanges, staffIdFor, type MasterChanges } from '../../core/masters';
import { rankNameCandidates } from '../../core/resolve';
import type { ParsedShift } from '../../pdf/types';
import {
  PRESENCE,
  PRESENCE_PRESETS,
  presetOf,
  presetPresence,
  type Presence,
} from '../../core/shiftCode';
import type { ShiftType, Staff } from '../../core/types';

interface PendingCode {
  readonly code: string;
  readonly count: number;
  am: Presence;
  pm: Presence;
  basis: string;
}

interface PendingStaff {
  readonly name: string;
  readonly job: string;
  /** 既存の職員に寄せる場合はその staffId。空なら新規登録。 */
  mergeInto: string;
}

export function renderImport(root: HTMLElement, ctx: Ctx): void {
  const input = el('input', {
    type: 'file',
    accept: 'application/pdf,.pdf',
    onchange: () => {
      const file = input.files?.[0];
      if (file) void handleFile(file, root, ctx);
    },
  });

  const zone = el(
    'label',
    {
      class: 'dropzone',
      ondragover: (event: DragEvent) => {
        event.preventDefault();
        zone.classList.add('dropzone--over');
      },
      ondragleave: () => zone.classList.remove('dropzone--over'),
      ondrop: (event: DragEvent) => {
        event.preventDefault();
        zone.classList.remove('dropzone--over');
        const file = event.dataTransfer?.files?.[0];
        if (file) void handleFile(file, root, ctx);
      },
    },
    el('span', { class: 'dropzone__lead', text: '勤務（予定）表のPDFを選ぶ' }),
    el('span', { text: 'ここにドラッグしても読み込めます' }),
    input,
  );

  root.append(
    el('div', { class: 'notice notice--settled' },
      el('strong', { text: 'PDFはこの端末の中だけで読みます。' }),
      el('span', { text: '氏名や勤務の中身がインターネットに送られることはありません。' })),
    zone,
  );
}

async function handleFile(file: File, root: HTMLElement, ctx: Ctx): Promise<void> {
  root.replaceChildren(
    el('div', { class: 'empty' },
      el('div', { class: 'spinner', style: 'margin:0 auto var(--step-3)' }),
      el('p', { text: `${file.name} を読み取っています…` })),
  );

  let parsed: ParsedShift;
  try {
    parsed = parseShiftTable(await readPdfText(await file.arrayBuffer()));
  } catch (error) {
    root.replaceChildren(
      el('div', { class: 'notice notice--blocked' },
        el('strong', { text: 'PDFを読めませんでした。' }),
        el('span', { text: error instanceof Error ? error.message : String(error) })),
      el('button', {
        class: 'btn btn--quiet',
        type: 'button',
        text: 'もう一度選ぶ',
        onclick: () => renderImport(root, ctx),
      }),
    );
    return;
  }

  const changes = planMasterChanges(parsed, ctx.db.staff, ctx.db.aliases, ctx.db.shiftTypes);
  const pendingCodes: PendingCode[] = changes.newCodes.map((c) => ({
    code: c.code,
    count: c.count,
    am: c.am,
    pm: c.pm,
    basis: c.basis,
  }));
  const pendingStaff: PendingStaff[] = changes.newStaff.map((s) => ({
    name: s.name,
    job: s.job,
    mergeInto: '',
  }));

  renderResult(root, ctx, parsed, changes, pendingCodes, pendingStaff);
}

function renderResult(
  root: HTMLElement,
  ctx: Ctx,
  parsed: ParsedShift,
  changes: MasterChanges,
  pendingCodes: PendingCode[],
  pendingStaff: PendingStaff[],
): void {
  const cellCount = parsed.rows.reduce((acc, r) => acc + r.cells.length, 0);
  const redraw = (): void =>
    renderResult(root, ctx, parsed, changes, pendingCodes, pendingStaff);

  root.replaceChildren();

  root.append(
    el('div', { class: 'period' },
      el('span', {
        class: 'period__value',
        text: parsed.year && parsed.month ? `${parsed.year}年${parsed.month}月` : '年月不明',
      })),
    el('div', { class: 'tally' },
      tallyItem(String(parsed.rows.length), '人', ''),
      tallyItem(String(cellCount), 'セル', ''),
      tallyItem(
        String(parsed.unread.length),
        '読めなかった欄',
        parsed.unread.length > 0 ? 'blocked' : 'settled',
      )),
  );

  // 勤務表として成立していないPDFを「読み取れました」と言ってはいけない。
  // 別のPDFを選んだことに気づけないまま進んでしまう。
  const looksLikeShiftTable = parsed.rows.length > 0 && parsed.days.length > 0;

  if (!looksLikeShiftTable) {
    root.append(
      el('div', { class: 'notice notice--blocked', style: 'margin-top:var(--step-4)' },
        el('strong', { text: 'このPDFは勤務表として読み取れませんでした。' }),
        el('span', { text: '勤務（予定）表のPDFか確認してください。スキャンした画像のPDFは読めません。' }),
        ...parsed.warnings.map((w) => el('span', { text: w }))),
      el('div', { class: 'actions' },
        el('button', {
          class: 'btn btn--quiet',
          type: 'button',
          text: '別のPDFを選ぶ',
          onclick: () => renderImport(root, ctx),
        })),
    );
    return;
  }

  if (parsed.unread.length === 0) {
    root.append(
      el('div', { class: 'notice notice--settled', style: 'margin-top:var(--step-4)' },
        el('strong', { text: 'すべての欄を読み取れました。' }),
        el('span', { text: '推測した欄はありません。原本どおりの値です。' })),
    );
  } else {
    root.append(
      el('div', { class: 'notice notice--blocked', style: 'margin-top:var(--step-4)' },
        el('strong', { text: `${parsed.unread.length}件の欄を読み取れませんでした。` }),
        el('span', { text: '次の画面で原本を見ながら入力してください。' })),
    );
  }

  if (pendingStaff.length > 0 || pendingCodes.length > 0) {
    root.append(
      el('h2', { class: 'section-title', text: 'はじめて出てきたもの' }),
      el('p', { class: 'card__body', style: 'margin-bottom:var(--step-3)',
        text: '一度決めれば覚えます。次の月からは聞きません。' }),
    );
  }

  if (pendingStaff.length > 0) {
    root.append(
      el('h3', { class: 'card__title', text: `名簿にいない人（${pendingStaff.length}人）` }),
      el('div', { class: 'rows' }, ...pendingStaff.map((person) => renderStaffRow(person, ctx, redraw))),
    );
  }

  if (pendingCodes.length > 0) {
    root.append(
      el('h3', { class: 'card__title', style: 'margin-top:var(--step-5)',
        text: `新しい勤務区分（${pendingCodes.length}件）` }),
      el('p', { class: 'card__body',
        text: 'どの半日に現場にいるかで、割り振りの対象が決まります。フリーの半日には業務を載せません。' }),
      el('div', { class: 'rows', style: 'margin-top:var(--step-3)' },
        ...pendingCodes.map((code) => renderCodeRow(code, redraw))),
    );
  }

  root.append(
    el('div', { class: 'actions actions--sticky' },
      el('button', {
        class: 'btn btn--primary btn--block',
        type: 'button',
        text: '確認画面へ進む',
        onclick: () => commit(ctx, parsed, pendingCodes, pendingStaff),
      })),
  );
}

function tallyItem(value: string, label: string, tone: string): HTMLElement {
  return el('div', { class: tone ? `tally__item tally__item--${tone}` : 'tally__item' },
    el('span', { class: 'tally__value', text: value }),
    el('span', { class: 'tally__label', text: label }));
}

function renderStaffRow(person: PendingStaff, ctx: Ctx, redraw: () => void): HTMLElement {
  const candidates = rankNameCandidates(person.name, ctx.db.staff, 4)
    .filter((c) => c.score > 0.3);

  const select = el('select', {
    'aria-label': `${person.name} の扱い`,
    onchange: (event: Event) => {
      person.mergeInto = (event.currentTarget as HTMLSelectElement).value;
      redraw();
    },
  },
    el('option', { value: '', text: '新しく登録する', selected: person.mergeInto === '' }),
    ...candidates.map((c) =>
      el('option', {
        value: c.staff.staffId,
        text: `${c.staff.name} と同じ人`,
        selected: person.mergeInto === c.staff.staffId,
      })),
  );

  return el('div', { class: 'row' },
    el('div', { class: 'row__main' },
      el('span', { class: 'row__title', text: person.name }),
      el('span', { class: 'row__note', text: person.job || '職種の記載なし' })),
    select);
}

function renderCodeRow(code: PendingCode, redraw: () => void): HTMLElement {
  const select = el('select', {
    'aria-label': `${code.code} の勤務`,
    onchange: (event: Event) => {
      const next = presetPresence((event.currentTarget as HTMLSelectElement).value);
      code.am = next.am;
      code.pm = next.pm;
      code.basis = '手で決めました';
      redraw();
    },
  }, ...PRESENCE_PRESETS.map((preset) =>
    el('option', {
      value: preset.value,
      text: preset.label,
      selected: preset.value === presetOf(code.am, code.pm),
    })));

  return el('div', { class: 'row' },
    el('div', { class: 'row__main' },
      el('span', { class: 'row__title', text: code.code }),
      el('span', { class: 'row__note', text: `この月に ${code.count} 回` }),
      el('span', { class: 'row__note', text: code.basis })),
    select);
}

function commit(
  ctx: Ctx,
  parsed: ParsedShift,
  pendingCodes: readonly PendingCode[],
  pendingStaff: readonly PendingStaff[],
): void {
  ctx.update((db) => {
    const additions: Staff[] = [];
    const aliases = [...db.aliases];
    for (const person of pendingStaff) {
      if (person.mergeInto) {
        aliases.push({
          rawText: person.name,
          staffId: person.mergeInto,
          hitCount: 1,
          createdAt: new Date().toISOString(),
        });
        continue;
      }
      additions.push({
        staffId: staffIdFor(person.name, [...db.staff, ...additions]),
        name: person.name,
        job: person.job,
        active: true,
        note: '',
      });
    }

    const types: ShiftType[] = pendingCodes.map((c) => {
      const isWorking = c.am === PRESENCE.WORK || c.pm === PRESENCE.WORK;
      return {
        code: c.code,
        label: c.code,
        isWorking,
        hours: isWorking ? 8 : 0,
        aliases: [],
        am: c.am,
        pm: c.pm,
      };
    });

    return upsertShiftTypes(addStaff({ ...db, aliases }, additions), types);
  });

  const review = buildImportReview(parsed, ctx.db);
  ctx.setReview(review);
  ctx.go('review', { period: review.periodKey || ctx.state.period });
}
