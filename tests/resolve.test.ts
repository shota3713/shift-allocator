/**
 * 名寄せと勤務区分の解決。
 * 「似ているだけのものを自動で通さない」ことが一番大事なので、そこを厚く試す。
 */

import { describe, expect, it } from 'vitest';
import {
  FLAG,
  buildResolveContext,
  nameSimilarity,
  normalizeName,
  normalizeText,
  rankNameCandidates,
  resolveName,
  resolveShiftValue,
} from '../src/core/resolve';
import { OFF, WORK, staff } from './helpers';

const STAFF = [
  staff('a', '田中太郎', '介護職員'),
  staff('b', '白石花子', '看護職員'),
  staff('c', '山本一郎', '介護職員'),
];

const context = buildResolveContext(STAFF, [{ rawText: 'タナカタロウ', staffId: 'a' }], [WORK, OFF]);

describe('正規化', () => {
  it('全角と半角のゆれを潰す', () => {
    expect(normalizeText('ＡＢＣ　１２')).toBe('ABC12');
  });

  it('小数点は残す（時間を壊さないため）', () => {
    expect(normalizeText('7.5')).toBe('7.5');
  });

  it('氏名の区切り記号は落とす', () => {
    expect(normalizeName('田中・太郎')).toBe('田中太郎');
    expect(normalizeName('田中 太郎')).toBe('田中太郎');
  });
});

describe('氏名の類似度', () => {
  it('1文字違いを高く評価する', () => {
    // bigram だけだと 0.33 に沈む形。編集距離と併用して拾う。
    expect(nameSimilarity('田仲太郎', '田中太郎')).toBeGreaterThan(0.7);
  });

  it('別人は低く出る', () => {
    expect(nameSimilarity('田中太郎', '白石花子')).toBeLessThan(0.3);
  });

  it('近い順に候補を返す', () => {
    const ranked = rankNameCandidates('田仲太郎', STAFF, 2);
    expect(ranked[0]?.staff.staffId).toBe('a');
    expect(ranked.length).toBe(2);
  });
});

describe('氏名の解決', () => {
  it('完全一致はそのまま通す', () => {
    const result = resolveName('田中太郎', context);
    expect(result.staffId).toBe('a');
    expect(result.flag).toBe(FLAG.OK);
  });

  it('別名辞書にあれば通す', () => {
    const result = resolveName('タナカタロウ', context);
    expect(result.staffId).toBe('a');
    expect(result.flag).toBe(FLAG.OK);
  });

  it('似ているだけのものは必ず確認に回す', () => {
    const result = resolveName('田仲太郎', context);
    expect(result.staffId).toBe('a');
    expect(result.flag).toBe(FLAG.REVIEW);
    expect(result.reason).toContain('確認');
  });

  it('名簿に無い人は止める', () => {
    const result = resolveName('新人次郎', context);
    expect(result.staffId).toBeNull();
    expect(result.flag).toBe(FLAG.BLOCK);
    expect(result.candidates.length).toBeGreaterThan(0);
  });

  it('空の氏名は止める', () => {
    expect(resolveName('', context).flag).toBe(FLAG.BLOCK);
  });
});

describe('勤務区分の解決', () => {
  it('登録済みのコードは通す', () => {
    const result = resolveShiftValue('日勤', context);
    expect(result.code).toBe('日勤');
    expect(result.flag).toBe(FLAG.OK);
  });

  it('別名でも引ける', () => {
    expect(resolveShiftValue('休', context).code).toBe('OFF');
  });

  it('空欄は休みとして扱う', () => {
    expect(resolveShiftValue('', context).code).toBe('OFF');
  });

  it('読み取れなかったセルは止める', () => {
    expect(resolveShiftValue(null, context).flag).toBe(FLAG.BLOCK);
  });

  it('未登録の記号は勝手に解釈しない', () => {
    const result = resolveShiftValue('夜_032DS', context);
    expect(result.code).toBeNull();
    expect(result.flag).toBe(FLAG.BLOCK);
  });
});
