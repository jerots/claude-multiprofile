// Copying existing sessions into a new profile.
//
// A profile normally starts empty, and seeding (src/code.js) deliberately
// leaves conversations behind: a profile exists to keep accounts apart. But a
// common way to arrive here is moving the account you already use into its own
// profile, so the default install can go to another account. Then the empty
// profile is the problem, and `add` offers this instead, as an explicit
// choice that defaults to no.
//
// What a session is made of, and where each part lives:
//
//   Desktop data dir (the Code tab)
//     claude-code-sessions/<account>/<org>/  one record per session, the
//                                            routines (scheduled-tasks.json),
//                                            archived and deleted markers
//     git-worktrees.json                     which session owns which worktree
//     claude_desktop_config.json             sidebar groups and sections,
//                                            under preferences.epitaxyPrefs
//   Claude Code config dir
//     projects/          the transcripts the records point at
//     history.jsonl      prompt history
//     file-history/      checkpoints for rewinding edits
//     plans/, todos/     plan mode and todo state
//     scheduled-tasks/   each routine's SKILL.md
//
// Everything is copied (APFS clones, so it costs next to no space), never
// moved: the originals stay where they are. Anything the profile already has
// is left alone, so this never replaces a session, a routine or a group.
//
// Desktop files its sessions by account and organisation, so the copies show
// up only when the profile signs in to the same account they came from.

import fs from "node:fs";
import path from "node:path";
import { copyEntry } from "./code.js";
import { fileExists } from "./util.js";

export const CODE_SESSION_ITEMS = [
  "projects",
  "history.jsonl",
  "file-history",
  "plans",
  "todos",
  "scheduled-tasks",
];

// Sidebar preferences. The dframe-* ones are maps keyed by "<account>/<org>";
// the starred-* ones are plain lists.
export const SIDEBAR_PREF_KEYS = [
  "dframe-group-scopes",
  "dframe-code-sections",
  "starred-session-groups",
  "starred-local-routines",
];

const SESSIONS_DIR = "claude-code-sessions";

function subdirs(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

// Every "<account>/<org>" folder of Code-tab sessions in a Desktop data dir.
export function sessionScopes(desktopDataDir) {
  const root = path.join(desktopDataDir, SESSIONS_DIR);
  const scopes = [];
  for (const account of subdirs(root)) {
    for (const org of subdirs(path.join(root, account))) scopes.push(`${account}/${org}`);
  }
  return scopes;
}

// How much there is to copy, for the wizard's question. Deleted sessions keep
// a marker on disk and are not counted.
export function countSessions({ fromDesktop = null, fromCode = null } = {}) {
  let desktop = 0;
  if (fromDesktop) {
    for (const scope of sessionScopes(fromDesktop)) {
      try {
        desktop += fs
          .readdirSync(path.join(fromDesktop, SESSIONS_DIR, scope))
          .filter((f) => f.startsWith("local_") && f.endsWith(".json")).length;
      } catch {
        // Unreadable scope; count what we can.
      }
    }
  }
  let code = 0;
  if (fromCode) {
    for (const project of subdirs(path.join(fromCode, "projects"))) {
      try {
        code += fs
          .readdirSync(path.join(fromCode, "projects", project))
          .filter((f) => f.endsWith(".jsonl")).length;
      } catch {
        // Same.
      }
    }
  }
  return { desktop, code };
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function isPlainObject(v) {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

// Carry the sidebar's groups and sections across. Per scope for the maps, and
// only where the profile has nothing yet, so its own layout always wins.
// Returns the keys that changed, or null when the profile's config exists but
// cannot be parsed (it is then left exactly as it is).
export function copySidebarPrefs(fromDesktop, toDesktop) {
  const src = readJson(path.join(fromDesktop, "claude_desktop_config.json"));
  const srcPrefs = isPlainObject(src) && isPlainObject(src.preferences) ? src.preferences.epitaxyPrefs : null;
  if (!isPlainObject(srcPrefs)) return [];

  const file = path.join(toDesktop, "claude_desktop_config.json");
  let dst = {};
  if (fileExists(file)) {
    dst = readJson(file);
    if (!isPlainObject(dst)) return null;
  }
  if (!isPlainObject(dst.preferences)) dst.preferences = {};
  if (!isPlainObject(dst.preferences.epitaxyPrefs)) dst.preferences.epitaxyPrefs = {};
  const dstPrefs = dst.preferences.epitaxyPrefs;

  const changed = [];
  for (const key of SIDEBAR_PREF_KEYS) {
    const from = srcPrefs[key];
    if (isPlainObject(from)) {
      const into = isPlainObject(dstPrefs[key]) ? dstPrefs[key] : {};
      let added = false;
      for (const [scope, value] of Object.entries(from)) {
        if (scope in into) continue;
        into[scope] = value;
        added = true;
      }
      if (added) {
        dstPrefs[key] = into;
        changed.push(key);
      }
    } else if (Array.isArray(from) && from.length > 0) {
      if (Array.isArray(dstPrefs[key]) && dstPrefs[key].length > 0) continue;
      dstPrefs[key] = from;
      changed.push(key);
    }
  }
  if (changed.length) fs.writeFileSync(file, JSON.stringify(dst, null, 2) + "\n", "utf8");
  return changed;
}

// A routine names its SKILL.md by absolute path, inside the config dir it was
// created under. Copied as is, the profile's routines would keep running the
// source profile's instructions, and stop working once those are cleaned up.
// A path is only rewritten when the profile has its own copy of the file.
export function rebaseRoutines(scheduledTasksFile, fromCode, toCode) {
  const data = readJson(scheduledTasksFile);
  if (!isPlainObject(data) || !Array.isArray(data.scheduledTasks)) return 0;
  const prefix = fromCode.endsWith(path.sep) ? fromCode : fromCode + path.sep;
  let n = 0;
  for (const task of data.scheduledTasks) {
    if (!isPlainObject(task) || typeof task.filePath !== "string") continue;
    if (!task.filePath.startsWith(prefix)) continue;
    const moved = path.join(toCode, task.filePath.slice(prefix.length));
    if (!fileExists(moved)) continue;
    task.filePath = moved;
    n++;
  }
  if (n) fs.writeFileSync(scheduledTasksFile, JSON.stringify(data, null, 2) + "\n", "utf8");
  return n;
}

// Copy sessions from one install into a profile. Either half can be null:
// a Desktop-only profile gets the Code-tab records (its Claude Code still
// reads the shared ~/.claude, where their transcripts already are), and a
// Code-only profile gets the transcripts and history.
//
// Returns { copied, skipped, sidebar, routines, unreadable } for the wizard
// to report. `skipped` lists what the profile already had.
export function copySessions({ fromDesktop = null, toDesktop = null, fromCode = null, toCode = null }) {
  const result = { copied: [], skipped: [], sidebar: [], routines: 0, unreadable: [] };
  const copiedScopes = [];

  if (fromDesktop && toDesktop) {
    for (const scope of sessionScopes(fromDesktop)) {
      const to = path.join(toDesktop, SESSIONS_DIR, scope);
      if (fileExists(to)) {
        result.skipped.push(`${SESSIONS_DIR}/${scope}`);
        continue;
      }
      copyEntry(path.join(fromDesktop, SESSIONS_DIR, scope), to);
      result.copied.push(`${SESSIONS_DIR}/${scope}`);
      copiedScopes.push(scope);
    }
    const worktrees = "git-worktrees.json";
    if (fileExists(path.join(fromDesktop, worktrees))) {
      if (fileExists(path.join(toDesktop, worktrees))) result.skipped.push(worktrees);
      else {
        copyEntry(path.join(fromDesktop, worktrees), path.join(toDesktop, worktrees));
        result.copied.push(worktrees);
      }
    }
    const sidebar = copySidebarPrefs(fromDesktop, toDesktop);
    if (sidebar === null) result.unreadable.push("claude_desktop_config.json");
    else result.sidebar = sidebar;
  }

  if (fromCode && toCode) {
    for (const item of CODE_SESSION_ITEMS) {
      const from = path.join(fromCode, item);
      if (!fileExists(from)) continue;
      const to = path.join(toCode, item);
      if (fileExists(to)) {
        result.skipped.push(item);
        continue;
      }
      copyEntry(from, to);
      result.copied.push(item);
    }
  }

  if (toDesktop && fromCode && toCode) {
    for (const scope of copiedScopes) {
      result.routines += rebaseRoutines(
        path.join(toDesktop, SESSIONS_DIR, scope, "scheduled-tasks.json"),
        fromCode,
        toCode
      );
    }
  }

  return result;
}
