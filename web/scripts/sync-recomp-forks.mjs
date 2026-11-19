#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptRoot, "../..");
const lockPath = join(repoRoot, "3rdparty/recomp/forks.lock.json");
const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const rootArg = args.find((argument) => argument.startsWith("--root="));
const root = resolve(rootArg?.slice("--root=".length) || process.env.RPCS3_RECOMP_FORKS_DIR || join(repoRoot, "3rdparty/recomp"));
const lock = JSON.parse(readFileSync(lockPath, "utf8"));

if (lock.schema !== 1 || !Array.isArray(lock.forks)) {
  throw new Error(`${lockPath}: unsupported fork lock schema`);
}

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function verifyCheckout(path, fork) {
  if (!existsSync(join(path, ".git"))) {
    throw new Error(`${fork.name}: checkout is missing at ${path}`);
  }

  const head = git(path, "rev-parse", "HEAD");
  if (head !== fork.commit) {
    throw new Error(`${fork.name}: expected ${fork.commit}, found ${head}`);
  }

  const dirty = git(path, "status", "--porcelain", "--untracked-files=no");
  if (dirty) {
    throw new Error(`${fork.name}: tracked files are modified in ${path}`);
  }
}

function hasHead(path) {
  try {
    git(path, "rev-parse", "--verify", "HEAD");
    return true;
  } catch {
    return false;
  }
}

if (checkOnly) {
  for (const fork of lock.forks) verifyCheckout(join(root, fork.name), fork);
  process.stdout.write(`${JSON.stringify({ root, verified: lock.forks.length })}\n`);
  process.exit(0);
}

mkdirSync(root, { recursive: true });
for (const fork of lock.forks) {
  const path = join(root, fork.name);
  let freshClone = false;

  if (!existsSync(path)) {
    process.stdout.write(`cloning ${fork.name}\n`);
    execFileSync("git", ["clone", "--no-checkout", fork.upstream, path], { stdio: "inherit" });
    freshClone = true;
  } else if (!existsSync(join(path, ".git"))) {
    throw new Error(`${fork.name}: ${path} exists but is not a Git checkout`);
  }

  const populated = git(path, "ls-files")
    .split("\n")
    .some((file) => file && existsSync(join(path, file)));

  if (!freshClone && hasHead(path) && populated) {
    const dirty = git(path, "status", "--porcelain", "--untracked-files=no");
    if (dirty) {
      throw new Error(`${fork.name}: refusing to change a checkout with tracked modifications at ${path}`);
    }
  }

  process.stdout.write(`pinning ${fork.name} to ${fork.commit}\n`);
  git(path, "fetch", "--all", "--tags", "--prune");
  git(path, "checkout", "--detach", fork.commit);
  verifyCheckout(path, fork);
}

process.stdout.write(`${JSON.stringify({ root, synchronized: lock.forks.length })}\n`);
