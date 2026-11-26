import {
  defaultPriority,
  isDueInRange,
  rangeEnd,
  rangeStart,
  sortByPriority,
  sortTaskTree,
  type DueRange,
  type Task,
} from "./task-schema.ts";

export type ListStatus = "all" | "open" | "done";

const effortLabels = { small: "小", medium: "中", large: "大" } as const;
const weekdays = ["一", "二", "三", "四", "五", "六", "日"];
const emptyList = "清单是空的。可以说「帮我记一下买牛奶」来添加任务。";

function pad(value: number) {
  return String(value).padStart(2, "0");
}

// 与 dueAt 相同，按服务端本地时间表示。
export function localDate(now: Date) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function localMinute(now: Date) {
  return `${localDate(now)}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

export function isOverdue(task: Task, now: Date) {
  return !task.done && !!task.dueAt && rangeEnd(task.dueAt) < localMinute(now);
}

function dayNumber(date: string) {
  const [year, month, day] = date.split("-").map(Number);
  return Date.UTC(year, month - 1, day) / 86_400_000;
}

// 1970-01-01 是周四，以周一为 0 计算星期。
function weekdayIndex(day: number) {
  return (day + 3) % 7;
}

export function dueText(dueAt: string, now: Date, overdue: boolean) {
  const date = dueAt.slice(0, 10);
  const time = dueAt.length > 10 ? ` ${dueAt.slice(11)}` : "";
  const today = dayNumber(localDate(now));
  const day = dayNumber(date);
  const days = day - today;
  if (overdue) return days < 0 ? `已过期 ${-days} 天` : `已过期（今天${time}）`;

  const daysLeftThisWeek = 6 - weekdayIndex(today);
  let when: string;
  if (days === 0) when = "今天";
  else if (days === 1) when = "明天";
  else if (days === 2) when = "后天";
  else if (days > 0 && days <= daysLeftThisWeek) when = `周${weekdays[weekdayIndex(day)]}`;
  else if (days > 0 && days <= daysLeftThisWeek + 7) when = `下周${weekdays[weekdayIndex(day)]}`;
  else if (date.slice(0, 4) === localDate(now).slice(0, 4))
    when = `${Number(date.slice(5, 7))}月${Number(date.slice(8))}日`;
  else when = date;
  const gap = time || when === date ? " " : "";
  return `${when}${time}${gap}到期`;
}

export function taskName(task: Task, tasks: Task[]) {
  const title = task.title.replace(/\s+/g, " ").trim();
  const sameTitle = tasks.some(
    (other) =>
      other.id !== task.id && other.parentId === task.parentId && other.title === task.title,
  );
  return sameTitle ? `${title}（#${task.id.slice(0, 8)}）` : title;
}

export function taskLabel(task: Task, tasks: Task[]) {
  return `「${taskName(task, tasks)}」`;
}

function parentOf(task: Task, tasks: Task[]) {
  return tasks.find((candidate) => candidate.id === task.parentId);
}

export function taskPath(task: Task, tasks: Task[]) {
  const parent = parentOf(task, tasks);
  const label = taskLabel(task, tasks);
  return parent ? `${taskLabel(parent, tasks)} / ${label}` : label;
}

export function taskDetails(task: Task) {
  const details = [`P${task.priority ?? defaultPriority}`];
  if (task.effort) details.push(`工作量 ${effortLabels[task.effort]}`);
  if (task.dueAt) details.push(`到期 ${task.dueAt.replace("T", " ")}`);
  return details.join(" · ");
}

function childrenOf(task: Task, tasks: Task[]) {
  return tasks.filter((child) => child.parentId === task.id);
}

// 待办行突出优先级、截止时间和子任务进度；已完成行只保留名称。
function taskRow(task: Task, tasks: Task[], now: Date, name = taskName(task, tasks)) {
  if (task.done) return `✓ ${name}`;
  const parts = [`○ P${task.priority ?? defaultPriority} ${name}`];
  if (task.dueAt) parts.push(dueText(task.dueAt, now, isOverdue(task, now)));
  if (task.effort) parts.push(`工作量${effortLabels[task.effort]}`);
  const children = childrenOf(task, tasks);
  if (children.length) {
    parts.push(`子任务 ${children.filter((child) => child.done).length}/${children.length}`);
  }
  return parts.join(" · ");
}

function pathName(task: Task, tasks: Task[]) {
  const parent = parentOf(task, tasks);
  const name = taskName(task, tasks);
  return parent ? `${taskName(parent, tasks)} / ${name}` : name;
}

/** 普通清单：按顶层任务分为已过期、待办、已完成三组，子任务缩进在父任务下。 */
export function overviewReply(tasks: Task[], status: ListStatus, now: Date) {
  if (!tasks.length) return emptyList;

  if (status === "done") {
    const done = sortTaskTree(tasks).filter((task) => task.done);
    if (!done.length) return "还没有已完成的任务。";
    const rows = done.map((task) => `  ${taskRow(task, tasks, now, pathName(task, tasks))}`);
    return [`已完成 ${done.length} 项。`, "", ...rows].join("\n");
  }

  const ordered = sortTaskTree(tasks);
  const groups = { overdue: [] as Task[], open: [] as Task[], done: [] as Task[] };
  for (const root of ordered.filter((task) => !task.parentId)) {
    const family = [root, ...childrenOf(root, tasks)];
    if (root.done) groups.done.push(root);
    else if (family.some((task) => isOverdue(task, now))) groups.overdue.push(root);
    else groups.open.push(root);
  }

  const openCount = groups.overdue.length + groups.open.length;
  const overdueNote = groups.overdue.length ? `，其中 ${groups.overdue.length} 项已过期` : "";
  let summary: string;
  if (status === "open") {
    summary = openCount ? `共 ${openCount} 项待办${overdueNote}。` : "没有待办任务，全都完成了。";
  } else if (!openCount) {
    summary = `${groups.done.length} 项任务都已完成，没有待办。`;
  } else {
    const doneNote = groups.done.length ? `；已完成 ${groups.done.length} 项` : "";
    summary = `共 ${openCount} 项待办${overdueNote}${doneNote}。`;
  }

  function section(heading: string, roots: Task[]) {
    if (!roots.length) return [];
    const rows = roots.flatMap((root) => {
      const children = ordered.filter(
        (task) => task.parentId === root.id && (status === "all" || !task.done),
      );
      return [
        `  ${taskRow(root, tasks, now)}`,
        ...(root.done ? [] : children.map((child) => `      ${taskRow(child, tasks, now)}`)),
      ];
    });
    return ["", heading, ...rows];
  }

  return [
    summary,
    ...section("⚠️ 已过期", groups.overdue),
    ...section("📌 待办", groups.open),
    ...(status === "all" ? section("✅ 已完成", groups.done) : []),
  ].join("\n");
}

/** 某个父任务的子任务：未完成的在前，同组按优先级排列。 */
export function childrenReply(parent: Task, tasks: Task[], status: ListStatus, now: Date) {
  const children = childrenOf(parent, tasks);
  if (!children.length) return `${taskLabel(parent, tasks)}还没有子任务。`;
  const matching = children.filter((task) => status === "all" || task.done === (status === "done"));
  if (!matching.length) return "没有符合条件的子任务。";
  const ordered = [
    ...sortByPriority(matching.filter((task) => !task.done)),
    ...matching.filter((task) => task.done),
  ];
  const doneCount = children.filter((task) => task.done).length;
  return [
    `${taskLabel(parent, tasks)}的子任务（已完成 ${doneCount}/${children.length}）`,
    "",
    ...ordered.map((task) => `  ${taskRow(task, tasks, now)}`),
  ].join("\n");
}

/** 到期查询；范围包含今天时，另外列出范围之前已过期且未完成的任务。 */
export function dueReply(tasks: Task[], due: DueRange, status: ListStatus, now: Date) {
  const matching = sortByPriority(
    tasks.filter(
      (task) =>
        (status === "all" || task.done === (status === "done")) && isDueInRange(task.dueAt, due),
    ),
  );
  const today = localDate(now);
  const coversToday = due.from.slice(0, 10) <= today && today <= due.to.slice(0, 10);
  const earlierOverdue =
    status === "done" || !coversToday
      ? []
      : sortByPriority(
          tasks.filter(
            (task) => isOverdue(task, now) && rangeEnd(task.dueAt!) < rangeStart(due.from),
          ),
        );

  const range = `${due.from.replace("T", " ")} 至 ${due.to.replace("T", " ")}`;
  const lines = matching.length
    ? [
        `到期清单（${range}），共 ${matching.length} 项`,
        "",
        ...matching.map((task) => `  ${taskRow(task, tasks, now, pathName(task, tasks))}`),
      ]
    : ["这个时间范围内没有符合条件的到期任务。"];
  if (earlierOverdue.length) {
    lines.push(
      "",
      `⚠️ 另有 ${earlierOverdue.length} 项已过期未完成`,
      ...earlierOverdue.map((task) => `  ${taskRow(task, tasks, now, pathName(task, tasks))}`),
    );
  }
  return lines.join("\n");
}
