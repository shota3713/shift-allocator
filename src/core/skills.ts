/**
 * 「誰が何を担当できるか」。
 *
 * 職種だけでは決まらない。同じ介護職員でも、清掃専任の人に昼担当は回せないし、
 * 連絡帳を書ける人は限られる。だから最終的な可否は人が選ぶ。
 *
 * ただし毎回インポートで人が入れ替わるので、未設定の人は職種から埋める。
 * 設定した人はその設定が勝つ。「未設定」と「誰も選んでいない」を区別するため、
 * 一覧は staffId ごとの行として持つ（空配列 = 何も担当しない、という意思）。
 */

import type { Staff, Task } from './types';

/** staffId ごとの担当できる業務。行が無い人は未設定。 */
export interface StaffSkills {
  readonly staffId: string;
  readonly taskIds: readonly string[];
}

/** 職種から見た担当可否。個人の設定が無いときの初期値。 */
export function eligibleByJob(job: string, task: Task): boolean {
  if (task.eligibleJob.length === 0) return true;
  return task.eligibleJob.includes(job);
}

/** その人が担当できる業務のID。未設定なら職種から埋めた初期値を返す。 */
export function taskIdsFor(
  staffId: string,
  job: string,
  tasks: readonly Task[],
  skills: readonly StaffSkills[],
): string[] {
  const row = skills.find((s) => s.staffId === staffId);
  if (row) {
    const known = new Set(tasks.map((t) => t.taskId));
    return row.taskIds.filter((id) => known.has(id));
  }
  return tasks.filter((task) => eligibleByJob(job, task)).map((task) => task.taskId);
}

/** 設定済みかどうか。画面で「未設定」を出すために使う。 */
export function isConfigured(staffId: string, skills: readonly StaffSkills[]): boolean {
  return skills.some((s) => s.staffId === staffId);
}

/** taskId → 担当できる staffId。Plan を組むときに1回だけ作る。 */
export function buildCapableMap(
  staff: readonly { staffId: string; job: string }[],
  tasks: readonly Task[],
  skills: readonly StaffSkills[],
): Map<string, Set<string>> {
  const capable = new Map<string, Set<string>>();
  for (const task of tasks) capable.set(task.taskId, new Set());
  for (const person of staff) {
    for (const taskId of taskIdsFor(person.staffId, person.job, tasks, skills)) {
      capable.get(taskId)?.add(person.staffId);
    }
  }
  return capable;
}

/** その人の担当できる業務を書き換える。 */
export function setSkills(
  skills: readonly StaffSkills[],
  staffId: string,
  taskIds: readonly string[],
): StaffSkills[] {
  const next = skills.filter((s) => s.staffId !== staffId);
  next.push({ staffId, taskIds: [...new Set(taskIds)].sort() });
  return next.sort((a, b) => (a.staffId < b.staffId ? -1 : 1));
}

/** ある業務を担当できる人を、まとめて置き換える。業務ごとの画面から使う。 */
export function setTaskMembers(
  skills: readonly StaffSkills[],
  staff: readonly Staff[],
  tasks: readonly Task[],
  taskId: string,
  memberIds: readonly string[],
): StaffSkills[] {
  const members = new Set(memberIds);
  let next = [...skills];
  for (const person of staff) {
    // 未設定の人も、ここで初期値を確定させてから足し引きする。
    // そうしないと「職種の初期値」に戻って選択が消えたように見える。
    const current = new Set(taskIdsFor(person.staffId, person.job, tasks, next));
    if (members.has(person.staffId)) current.add(taskId);
    else current.delete(taskId);
    next = setSkills(next, person.staffId, [...current]);
  }
  return next;
}
