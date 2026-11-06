import { expect, test } from "vitest";

import { BoundedTasks } from "./bounded-tasks.js";

const turn = () => new Promise((resolve) => setImmediate(resolve));

test("runs work after the current turn, drops work past the cap, and frees a slot when work ends", async () => {
  const tasks = new BoundedTasks(2);
  const releases: (() => void)[] = [];
  let started = 0;
  const blocked = () => { started += 1; return new Promise<void>((resolve) => { releases.push(resolve); }); };
  const errors: unknown[] = [];

  expect(tasks.run(blocked, (error) => errors.push(error))).toBe(true);
  expect(started).toBe(0);
  expect(tasks.run(blocked, (error) => errors.push(error))).toBe(true);
  expect(tasks.run(blocked, (error) => errors.push(error))).toBe(false);
  expect(tasks.size).toBe(2);
  await turn();
  expect(started).toBe(2);
  releases[0]!();
  await turn();
  expect(tasks.size).toBe(1);

  expect(tasks.run(() => Promise.reject(new Error("boom")), (error) => errors.push(error))).toBe(true);
  await turn();
  await turn();
  expect(errors).toEqual([new Error("boom")]);
  expect(tasks.size).toBe(1);
});

test("close refuses new work; drain waits for admitted work, within its budget", async () => {
  const tasks = new BoundedTasks(4);
  let release!: () => void;
  expect(tasks.run(() => new Promise<void>((resolve) => { release = resolve; }), () => {})).toBe(true);
  tasks.close();
  expect(tasks.run(async () => {}, () => {})).toBe(false);

  expect(await tasks.drain(20)).toBe(false);
  const drained = tasks.drain(5_000);
  await turn();
  release();
  expect(await drained).toBe(true);
  expect(await tasks.drain(0)).toBe(true);
});
