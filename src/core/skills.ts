/**
 * 「誰が何を担当できるか」。
 *
 * 職種だけでは決まらない。同じ介護職員でも、清掃専任の人に昼担当は回せないし、
 * 連絡帳を書ける人は限られる。だから最終的な可否は人が選ぶ。
 *
 * 持ち方が要点。「この人ができる業務の一覧」として持つと、あとから業務を
 * 足したときに誰の一覧にも入らず、新しい業務に誰も割り振られなくなる。
 * そこで業務ごとに「できる／できない」を別々に記録し、どちらも決めていない
 * 業務は職種から判断する。毎月インポートで人が入れ替わるのでこの形が要る。
 */

import type { Staff, Task } from './types';

/** staffId ごとの担当可否。taskIds にも excluded にも無い業務は職種で判断する。 */
export interface StaffSkills {
  readonly staffId: string;
  /** 明示的に「担当できる」とした業務。 */
  readonly taskIds: readonly string[];
  /** 明示的に「担当しない」とした業務。 */
  readonly excluded: readonly string[];
}

/** 職種から見た担当可否。まだ選んでいない業務の初期値。 */
export function eligibleByJob(job: string, task: Task): boolean {
  if (task.eligibleJob.length === 0) return true;
  return task.eligibleJob.includes(job);
}

function rowFor(staffId: string, skills: readonly StaffSkills[]): StaffSkills | undefined {
  return skills.find((s) => s.staffId === staffId);
}

/** その人がその業務を担当できるか。選んでいなければ職種で決める。 */
export function canDo(
  staffId: string,
  job: string,
  task: Task,
  skills: readonly StaffSkills[],
): boolean {
  const row = rowFor(staffId, skills);
  if (row?.taskIds.includes(task.taskId)) return true;
  if (row?.excluded.includes(task.taskId)) return false;
  return eligibleByJob(job, task);
}

/** その人が担当できる業務のID。 */
export function taskIdsFor(
  staffId: string,
  job: string,
  tasks: readonly Task[],
  skills: readonly StaffSkills[],
): string[] {
  return tasks.filter((task) => canDo(staffId, job, task, skills)).map((task) => task.taskId);
}

/** その業務について、人が選んだかどうか。画面で「職種から」を出すために使う。 */
export function isConfigured(staffId: string, skills: readonly StaffSkills[]): boolean {
  const row = rowFor(staffId, skills);
  return (row?.taskIds.length ?? 0) + (row?.excluded.length ?? 0) > 0;
}

/** taskId → 担当できる staffId。Plan を組むときに1回だけ作る。 */
export function buildCapableMap(
  staff: readonly { staffId: string; job: string }[],
  tasks: readonly Task[],
  skills: readonly StaffSkills[],
): Map<string, Set<string>> {
  const capable = new Map<string, Set<string>>();
  for (const task of tasks) {
    const members = new Set<string>();
    for (const person of staff) {
      if (canDo(person.staffId, person.job, task, skills)) members.add(person.staffId);
    }
    capable.set(task.taskId, members);
  }
  return capable;
}

function upsert(
  skills: readonly StaffSkills[],
  staffId: string,
  taskIds: readonly string[],
  excluded: readonly string[],
): StaffSkills[] {
  const next = skills.filter((s) => s.staffId !== staffId);
  if (taskIds.length > 0 || excluded.length > 0) {
    next.push({
      staffId,
      taskIds: [...new Set(taskIds)].sort(),
      excluded: [...new Set(excluded)].sort(),
    });
  }
  return next.sort((a, b) => (a.staffId < b.staffId ? -1 : 1));
}

/**
 * その人の担当できる業務を、いま画面に出ている業務の範囲で決め直す。
 * 画面に無い業務（あとから足すもの）には触らない。
 */
export function setSkills(
  skills: readonly StaffSkills[],
  staffId: string,
  chosen: readonly string[],
  shownTaskIds: readonly string[],
): StaffSkills[] {
  const pick = new Set(chosen);
  const shown = new Set(shownTaskIds);
  const row = rowFor(staffId, skills);

  const taskIds = [
    ...(row?.taskIds ?? []).filter((id) => !shown.has(id)),
    ...shownTaskIds.filter((id) => pick.has(id)),
  ];
  const excluded = [
    ...(row?.excluded ?? []).filter((id) => !shown.has(id)),
    ...shownTaskIds.filter((id) => !pick.has(id)),
  ];
  return upsert(skills, staffId, taskIds, excluded);
}

/** ある業務を担当できる人を、まとめて置き換える。他の業務の設定には触らない。 */
export function setTaskMembers(
  skills: readonly StaffSkills[],
  staff: readonly Staff[],
  taskId: string,
  memberIds: readonly string[],
): StaffSkills[] {
  const members = new Set(memberIds);
  let next = [...skills];
  for (const person of staff) {
    const row = rowFor(person.staffId, next);
    const taskIds = (row?.taskIds ?? []).filter((id) => id !== taskId);
    const excluded = (row?.excluded ?? []).filter((id) => id !== taskId);
    if (members.has(person.staffId)) taskIds.push(taskId);
    else excluded.push(taskId);
    next = upsert(next, person.staffId, taskIds, excluded);
  }
  return next;
}

/**
 * 古い形（できる業務の一覧だけ）を、できる／できないの形に直す。
 *
 * 一覧だけの形は「ここに無い業務は担当しない」という意味になっていたので、
 * あとから足した業務に誰も割り振られなくなっていた。どの業務が当時
 * 存在したかは記録が無いので、「どの人の一覧にも出てこない業務」は
 * あとから足したものとみなし、職種の判断に戻す。
 */
export function migrateSkills(
  skills: readonly StaffSkills[],
  tasks: readonly Task[],
): StaffSkills[] {
  if (skills.length === 0) return [];
  if (skills.every((s) => Array.isArray(s.excluded))) {
    return skills.map((s) => ({
      staffId: s.staffId,
      taskIds: Array.isArray(s.taskIds) ? s.taskIds : [],
      excluded: s.excluded,
    }));
  }

  const mentioned = new Set(skills.flatMap((s) => (Array.isArray(s.taskIds) ? s.taskIds : [])));
  const decided = tasks.map((t) => t.taskId).filter((id) => mentioned.has(id));

  return skills.map((s) => {
    const taskIds = Array.isArray(s.taskIds) ? s.taskIds : [];
    return {
      staffId: s.staffId,
      taskIds: [...taskIds].sort(),
      excluded: Array.isArray(s.excluded)
        ? s.excluded
        : decided.filter((id) => !taskIds.includes(id)).sort(),
    };
  });
}
