// src/team/git-worktree.ts

/**
 * Git worktree manager for team worker isolation.
 *
 * Native team worktrees live at:
 *   {repoRoot}/.omc/team/{team}/worktrees/{worker}
 * Branch naming (branch mode): omc-team/{teamName}/{workerName}
 *
 * The public create/remove helpers are kept for legacy callers, but the
 * implementation is conservative: compatible clean worktrees are reused,
 * dirty team worktrees are preserved, and cleanup never force-removes dirty
 * worker changes.
 */

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { atomicWriteJson, ensureDirWithMode, validateResolvedPath } from './fs-utils.js';
import { sanitizeName } from './tmux-session.js';
import { withFileLockSync } from '../lib/file-lock.js';

export type TeamWorktreeMode = 'disabled' | 'detached' | 'named';

export interface WorktreeInfo {
  path: string;
  branch: string;
  workerName: string;
  teamName: string;
  createdAt: string;
  repoRoot?: string;
  detached?: boolean;
  created?: boolean;
  reused?: boolean;
}

export interface EnsureWorkerWorktreeOptions {
  mode?: TeamWorktreeMode;
  baseRef?: string;
  requireCleanLeader?: boolean;
}

export interface EnsureWorkerWorktreeResult extends WorktreeInfo {
  mode: TeamWorktreeMode;
  repoRoot: string;
  detached: boolean;
  created: boolean;
  reused: boolean;
}

export interface CleanupTeamWorktreesResult {
  removed: string[];
  preserved: Array<{ workerName: string; path: string; reason: string }>;
}

/** Get canonical native team worktree path for a worker. */
export function getWorktreePath(repoRoot: string, teamName: string, workerName: string): string {
  return join(repoRoot, '.omc', 'team', sanitizeName(teamName), 'worktrees', sanitizeName(workerName));
}

/** Get branch name for a worker. */
export function getBranchName(teamName: string, workerName: string): string {
  return `omc-team/${sanitizeName(teamName)}/${sanitizeName(workerName)}`;
}

function git(repoRoot: string, args: string[], cwd = repoRoot): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: 'pipe' }).trim();
}

function isInsideGitRepo(repoRoot: string): boolean {
  try {
    git(repoRoot, ['rev-parse', '--show-toplevel']);
    return true;
  } catch {
    return false;
  }
}

function assertCleanLeaderWorktree(repoRoot: string): void {
  const status = git(repoRoot, ['status', '--porcelain']);
  if (status.length > 0) {
    const error = new Error('leader_worktree_dirty: commit, stash, or clean changes before enabling team worktree mode');
    (error as Error & { code?: string }).code = 'leader_worktree_dirty';
    throw error;
  }
}

function getRegisteredWorktreeBranch(repoRoot: string, wtPath: string): string | undefined {
  try {
    const output = git(repoRoot, ['worktree', 'list', '--porcelain']);
    const resolvedWtPath = resolve(wtPath);
    let currentMatches = false;
    for (const line of output.split('\n')) {
      if (line.startsWith('worktree ')) {
        currentMatches = resolve(line.slice('worktree '.length).trim()) === resolvedWtPath;
        continue;
      }
      if (!currentMatches) continue;
      if (line.startsWith('branch ')) return line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
      if (line === 'detached') return 'HEAD';
    }
  } catch {
    // Best-effort check only.
  }
  return undefined;
}

/** Get worktree metadata path. */
function getMetadataPath(repoRoot: string, teamName: string): string {
  return join(repoRoot, '.omc', 'state', 'team', sanitizeName(teamName), 'worktrees.json');
}

function getLegacyMetadataPath(repoRoot: string, teamName: string): string {
  return join(repoRoot, '.omc', 'state', 'team-bridge', sanitizeName(teamName), 'worktrees.json');
}

/** Read worktree metadata, including legacy metadata for cleanup compatibility. */
function readMetadata(repoRoot: string, teamName: string): WorktreeInfo[] {
  const paths = [getMetadataPath(repoRoot, teamName), getLegacyMetadataPath(repoRoot, teamName)];
  const byWorker = new Map<string, WorktreeInfo>();
  for (const metaPath of paths) {
    if (!existsSync(metaPath)) continue;
    try {
      const entries = JSON.parse(readFileSync(metaPath, 'utf-8')) as WorktreeInfo[];
      for (const entry of entries) byWorker.set(entry.workerName, entry);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[omc] warning: worktrees.json parse error: ${msg}\n`);
    }
  }
  return [...byWorker.values()];
}

/** Write native worktree metadata. */
function writeMetadata(repoRoot: string, teamName: string, entries: WorktreeInfo[]): void {
  const metaPath = getMetadataPath(repoRoot, teamName);
  validateResolvedPath(metaPath, repoRoot);
  ensureDirWithMode(join(repoRoot, '.omc', 'state', 'team', sanitizeName(teamName)));
  atomicWriteJson(metaPath, entries);
}

function recordMetadata(repoRoot: string, teamName: string, info: WorktreeInfo): void {
  const metaLockPath = getMetadataPath(repoRoot, teamName) + '.lock';
  withFileLockSync(metaLockPath, () => {
    const existing = readMetadata(repoRoot, teamName).filter(entry => entry.workerName !== info.workerName);
    writeMetadata(repoRoot, teamName, [...existing, info]);
  });
}

function forgetMetadata(repoRoot: string, teamName: string, workerName: string): void {
  const metaLockPath = getMetadataPath(repoRoot, teamName) + '.lock';
  withFileLockSync(metaLockPath, () => {
    const existing = readMetadata(repoRoot, teamName).filter(entry => entry.workerName !== workerName);
    writeMetadata(repoRoot, teamName, existing);
  });
}

function assertCompatibleExistingWorktree(
  repoRoot: string,
  wtPath: string,
  expectedBranch: string,
  mode: TeamWorktreeMode,
): void {
  if (isWorktreeDirty(wtPath)) {
    const error = new Error(`worktree_dirty: preserving dirty worker worktree at ${wtPath}`);
    (error as Error & { code?: string }).code = 'worktree_dirty';
    throw error;
  }

  const registeredBranch = getRegisteredWorktreeBranch(repoRoot, wtPath);
  if (!registeredBranch) {
    const error = new Error(`worktree_mismatch: existing path is not a registered git worktree: ${wtPath}`);
    (error as Error & { code?: string }).code = 'worktree_mismatch';
    throw error;
  }

  if (mode === 'named' && registeredBranch !== expectedBranch) {
    const error = new Error(`worktree_mismatch: expected branch ${expectedBranch} at ${wtPath}, found ${registeredBranch}`);
    (error as Error & { code?: string }).code = 'worktree_mismatch';
    throw error;
  }

  if (mode === 'detached' && registeredBranch !== 'HEAD') {
    const error = new Error(`worktree_mismatch: expected detached worktree at ${wtPath}, found ${registeredBranch}`);
    (error as Error & { code?: string }).code = 'worktree_mismatch';
    throw error;
  }
}

function assertLeaderRepoClean(repoRoot: string): void {
  const status = git(repoRoot, ['status', '--porcelain'])
    .split('\n')
    .filter(line => line.trim() !== '' && !/^\?\? \.omc(?:\/|$)/.test(line))
    .join('\n')
    .trim();
  if (status !== '') {
    const err = new Error('leader_worktree_dirty: refusing to provision team worktrees from a dirty leader repository');
    err.name = 'leader_worktree_dirty';
    throw err;
  }
}

export function normalizeTeamWorktreeMode(value: unknown): TeamWorktreeMode {
  if (typeof value !== 'string') return 'disabled';
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'enabled', 'detached'].includes(normalized)) return 'detached';
  if (['branch', 'named', 'named-branch'].includes(normalized)) return 'named';
  return 'disabled';
}

/**
 * Ensure a worker worktree exists according to the selected opt-in mode.
 * Disabled mode is a no-op. Existing clean compatible worktrees are reused;
 * dirty or mismatched existing worktrees throw without deleting files.
 */
export function ensureWorkerWorktree(
  teamName: string,
  workerName: string,
  repoRoot: string,
  options: EnsureWorkerWorktreeOptions = {},
): EnsureWorkerWorktreeResult | null {
  const mode = options.mode ?? 'disabled';
  if (mode === 'disabled') return null;

  if (!isInsideGitRepo(repoRoot)) {
    throw new Error(`not_a_git_repository: ${repoRoot}`);
  }
  if (options.requireCleanLeader !== false) {
    assertCleanLeaderWorktree(repoRoot);
  }

  const wtPath = getWorktreePath(repoRoot, teamName, workerName);
  const branch = mode === 'named' ? getBranchName(teamName, workerName) : 'HEAD';
  validateResolvedPath(wtPath, repoRoot);

  try {
    execFileSync('git', ['worktree', 'prune'], { cwd: repoRoot, stdio: 'pipe' });
  } catch { /* ignore */ }

  if (existsSync(wtPath)) {
    assertCompatibleExistingWorktree(repoRoot, wtPath, branch, mode);
    const info: EnsureWorkerWorktreeResult = {
      path: wtPath,
      branch,
      workerName,
      teamName,
      createdAt: new Date().toISOString(),
      repoRoot,
      mode,
      detached: isDetached(wtPath),
      created: false,
      reused: true,
    };
    recordMetadata(repoRoot, teamName, info);
    return info;
  }

  const wtDir = join(repoRoot, '.omc', 'team', sanitizeName(teamName), 'worktrees');
  ensureDirWithMode(wtDir);

  const args = mode === 'named'
    ? ['worktree', 'add', '-b', branch, wtPath, options.baseRef ?? 'HEAD']
    : ['worktree', 'add', '--detach', wtPath, options.baseRef ?? 'HEAD'];
  execFileSync('git', args, { cwd: repoRoot, stdio: 'pipe' });

  const info: EnsureWorkerWorktreeResult = {
    path: wtPath,
    branch,
    workerName,
    teamName,
    createdAt: new Date().toISOString(),
    repoRoot,
    mode,
    detached: mode === 'detached',
    created: true,
    reused: false,
  };
  recordMetadata(repoRoot, teamName, info);
  return info;
}

/** Legacy creation helper: create or reuse a named-branch worker worktree. */
export function createWorkerWorktree(
  teamName: string,
  workerName: string,
  repoRoot: string,
  baseBranch?: string,
): WorktreeInfo {
  const info = ensureWorkerWorktree(teamName, workerName, repoRoot, {
    mode: 'named',
    baseRef: baseBranch,
    requireCleanLeader: false,
  });
  if (!info) throw new Error('worktree creation unexpectedly disabled');
  return info;
}

/** Remove a worker's worktree and branch, preserving dirty worktrees. */
export function removeWorkerWorktree(
  teamName: string,
  workerName: string,
  repoRoot: string,
): void {
  const wtPath = getWorktreePath(repoRoot, teamName, workerName);
  const branch = getBranchName(teamName, workerName);

  if (existsSync(wtPath) && isWorktreeDirty(wtPath)) {
    const error = new Error(`worktree_dirty: preserving dirty worker worktree at ${wtPath}`);
    (error as Error & { code?: string }).code = 'worktree_dirty';
    throw error;
  }

  try {
    execFileSync('git', ['worktree', 'remove', wtPath], { cwd: repoRoot, stdio: 'pipe' });
  } catch { /* may not exist */ }

  try {
    execFileSync('git', ['worktree', 'prune'], { cwd: repoRoot, stdio: 'pipe' });
  } catch { /* ignore */ }

  try {
    execFileSync('git', ['branch', '-D', branch], { cwd: repoRoot, stdio: 'pipe' });
  } catch { /* branch may not exist */ }

  // If a stale plain directory remains and it is not a registered worktree, remove it.
  if (existsSync(wtPath) && !isRegisteredWorktreePath(repoRoot, wtPath)) {
    rmSync(wtPath, { recursive: true, force: true });
  }

  forgetMetadata(repoRoot, teamName, workerName);
}

/** List all worktrees for a team. */
export function listTeamWorktrees(
  teamName: string,
  repoRoot: string
): WorktreeInfo[] {
  return readMetadata(repoRoot, teamName);
}

/** Remove all clean worktrees for a team, preserving dirty worktrees. */
export function cleanupTeamWorktrees(
  teamName: string,
  repoRoot: string
): CleanupTeamWorktreesResult {
  const entries = readMetadata(repoRoot, teamName);
  const removed: string[] = [];
  const preserved: Array<{ workerName: string; path: string; reason: string }> = [];

  for (const entry of entries) {
    try {
      removeWorkerWorktree(teamName, entry.workerName, repoRoot);
      removed.push(entry.workerName);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      preserved.push({ workerName: entry.workerName, path: entry.path, reason });
      process.stderr.write(`[omc] warning: preserved worktree ${entry.path}: ${reason}\n`);
    }
  }

  return { removed, preserved };
}
