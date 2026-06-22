import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findOnPath } from "./findOnPath";

describe("findOnPath", () => {
  let tmpDir: string;
  let binDirA: string;
  let binDirB: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "findOnPath-"));
    binDirA = path.join(tmpDir, "binA");
    binDirB = path.join(tmpDir, "binB");
    fs.mkdirSync(binDirA);
    fs.mkdirSync(binDirB);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns absolute path to a file found on PATH", () => {
    const target = path.join(binDirA, "az.cmd");
    fs.writeFileSync(target, "@echo off\n");
    const env = { PATH: [binDirA, binDirB].join(path.win32.delimiter) };
    expect(findOnPath("az.cmd", env)).toBe(target);
  });

  it("returns the first match when multiple PATH entries contain the file", () => {
    const first = path.join(binDirA, "tool.cmd");
    const second = path.join(binDirB, "tool.cmd");
    fs.writeFileSync(first, "");
    fs.writeFileSync(second, "");
    const env = { PATH: [binDirA, binDirB].join(path.win32.delimiter) };
    expect(findOnPath("tool.cmd", env)).toBe(first);
  });

  it("returns null when no PATH directory contains the file", () => {
    const env = { PATH: [binDirA, binDirB].join(path.win32.delimiter) };
    expect(findOnPath("missing.cmd", env)).toBeNull();
  });

  it("ignores empty PATH segments", () => {
    const target = path.join(binDirA, "thing.exe");
    fs.writeFileSync(target, "");
    const env = {
      PATH: `${binDirA}${path.win32.delimiter}${path.win32.delimiter}${binDirB}`,
    };
    expect(findOnPath("thing.exe", env)).toBe(target);
  });

  it("locates PATH case-insensitively (Path vs PATH)", () => {
    const target = path.join(binDirA, "cli.cmd");
    fs.writeFileSync(target, "");
    const env = { Path: binDirA };
    expect(findOnPath("cli.cmd", env)).toBe(target);
  });

  it("returns null when env has no PATH-like key", () => {
    expect(findOnPath("foo.exe", {})).toBeNull();
  });
});
