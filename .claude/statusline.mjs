#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { json } from "node:stream/consumers";

const log = (message) =>
  writeFile(
    `${import.meta.filename}.log`,
    `[${new Date().toISOString()}] ${message}\n`,
  );

try {
  const data = await json(process.stdin);
  console.log("[sl2]");
  await log(JSON.stringify(data, undefined, 2));
} catch (error) {
  if (error instanceof Error) {
    await log(`${error.name}: ${error.message}\n${error.stack}`);
  } else {
    await log(`Error: ${String(error)}`);
  }
}
