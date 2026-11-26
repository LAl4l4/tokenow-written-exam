import { z } from "zod";

const title = z.string().trim().min(1).max(200);
export const taskId = z.string().min(1);
export const defaultPriority = 2;

// 日期和分钟均按服务端本地时间解释。
const localMinute = z.iso
  .datetime({ local: true, precision: -1 })
  .refine((value) => !value.endsWith("Z"));
const dueAt = z.union([z.iso.date(), localMinute]);
const metadata = {
  dueAt: dueAt.nullable().optional(),
  parentId: taskId.optional(),
  priority: z.number().int().min(0).max(3).optional(),
  effort: z.enum(["small", "medium", "large"]).nullable().optional(),
};

export const createTaskSchema = z.strictObject({ title, ...metadata });
export const updateTaskSchema = createTaskSchema
  .omit({ parentId: true })
  .partial()
  .extend({ done: z.boolean().optional() })
  .refine((changes) => Object.keys(changes).length > 0);

export const storedTask = z.looseObject({
  id: taskId,
  title: z.string(),
  done: z.boolean(),
  ...metadata,
});

export const dueRangeSchema = z
  .strictObject({ from: dueAt, to: dueAt })
  .refine(
    ({ from, to }) => rangeStart(from) <= rangeEnd(to),
    "到期时间范围的起点应早于或等于终点。",
  );

export function rangeStart(value: string) {
  return value.length === 10 ? `${value}T00:00` : value;
}

export function rangeEnd(value: string) {
  return value.length === 10 ? `${value}T23:59` : value;
}

export type DueRange = z.infer<typeof dueRangeSchema>;

export function isDueInRange(value: string | null | undefined, { from, to }: DueRange) {
  if (!value) return false;
  const deadline = rangeEnd(value);
  return rangeStart(from) <= deadline && deadline <= rangeEnd(to);
}

export type Task = z.infer<typeof storedTask>;
export type TaskInput = z.infer<typeof createTaskSchema>;
export type TaskChanges = z.infer<typeof updateTaskSchema>;

export function sortByPriority(tasks: Task[]): Task[] {
  return tasks.toSorted(
    (a, b) => (a.priority ?? defaultPriority) - (b.priority ?? defaultPriority),
  );
}

export function sortTaskTree(tasks: Task[]): Task[] {
  const ordered = sortByPriority(tasks);
  const visibleIds = new Set(ordered.map(({ id }) => id));
  const roots: Task[] = [];
  const childrenByParent = new Map<string, Task[]>();
  for (const task of ordered) {
    const { parentId } = task;
    if (!parentId || !visibleIds.has(parentId)) {
      roots.push(task);
      continue;
    }
    const children = childrenByParent.get(parentId);
    if (children) children.push(task);
    else childrenByParent.set(parentId, [task]);
  }
  return roots.flatMap((root) => [root, ...(childrenByParent.get(root.id) ?? [])]);
}
