import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { storedTask, type Task, type TaskChanges, type TaskInput } from "./task-schema.ts";

const taskList = z.array(storedTask);

export class TaskConflict extends Error {}

export interface TaskStore {
  list(): Task[];
  create(title: string, metadata?: Omit<TaskInput, "title">): Task;
  update(id: string, changes: TaskChanges): Task | undefined;
  remove(id: string): boolean;
}

function updateParentStatus(tasks: Task[], parentId: Task["parentId"]) {
  if (!parentId) return;
  const parent = tasks.find((task) => task.id === parentId);
  const children = tasks.filter((task) => task.parentId === parentId);
  if (parent && children.length) parent.done = children.every((task) => task.done);
}

export function createJsonTaskStore(filename: string): TaskStore {
  function list(): Task[] {
    if (!existsSync(filename)) return [];
    return taskList.parse(JSON.parse(readFileSync(filename, "utf8")));
  }

  // 同一服务进程内同步完成读写；替换文件前，原清单始终完整可读。
  function save(tasks: Task[]) {
    mkdirSync(dirname(filename), { recursive: true });
    const temporary = filename + ".tmp";
    writeFileSync(temporary, JSON.stringify(tasks, null, 2) + "\n");
    renameSync(temporary, filename);
  }

  return {
    list,

    create(title, metadata) {
      const tasks = list();
      if (metadata?.parentId) {
        const parent = tasks.find((item) => item.id === metadata.parentId);
        if (!parent) throw new TaskConflict("找不到这条父任务。");
        if (parent.parentId) throw new TaskConflict("子任务只支持一层。");
        parent.done = false;
      }
      const task = { ...metadata, id: randomUUID(), title, done: false };
      save([...tasks, task]);
      return task;
    },

    update(id, changes) {
      const tasks = list();
      const task = tasks.find((item) => item.id === id);
      if (!task) return undefined;

      Object.assign(task, changes);
      if (changes.done !== undefined) {
        if (task.parentId) {
          updateParentStatus(tasks, task.parentId);
        } else {
          for (const child of tasks) {
            if (child.parentId === id) child.done = changes.done;
          }
        }
      }
      save(tasks);
      return task;
    },

    remove(id) {
      const tasks = list();
      const task = tasks.find((item) => item.id === id);
      if (!task) return false;
      const remaining = tasks.filter((item) => item.id !== id && item.parentId !== id);
      updateParentStatus(remaining, task.parentId);

      save(remaining);
      return true;
    },
  };
}
