// Claude Desktop app settings, copied from one profile into another.
//
// Desktop keeps its app settings under `preferences` in
// <user-data-dir>/claude_desktop_config.json: the menu bar icon, the Quick
// Entry shortcut, keep awake, and so on. A new profile starts with none of
// them, so it runs on Claude's own defaults. Those are often not what the
// user chose in their main Claude: a menu bar icon they had hidden comes
// back, and a Quick Entry shortcut they had turned off is live again in the
// second window.
//
// Everything in `preferences` is copied, including settings Claude adds after
// this was written, except what must not cross from one account to another:
//
//   - per-account choices         maps keyed by account ID (...ByAccount)
//   - permissions and trust       bypass mode, trusted folders, folder and
//                                 site grants, consent memory
//   - device identity             browser extension pairing, device name
//   - organisation policy         mirrored from the account's org
//   - Claude's own bookkeeping    migration flags, caches, session state
//
// Permissions in particular are left for the profile to grant itself: copying
// them would quietly let a work account into everything the personal one was
// allowed into. EXCLUSIONS is the single list of what stays behind, with the
// reason shown to the user.
//
// Copying only adds, like the connector copy in desktop.js: a setting the
// profile already has is kept unless the caller asks to replace it. And the
// same timing rule applies: Claude rewrites this file from its own state while
// it runs, so callers must not write behind a running profile.

import fs from "node:fs";
import path from "node:path";
import { HOME, fileExists } from "./util.js";

const CONFIG_NAME = "claude_desktop_config.json";

export const DEFAULT_DESKTOP_PREFERENCES_FILE = path.join(
  HOME,
  "Library",
  "Application Support",
  "Claude",
  CONFIG_NAME
);

// Ordered: the first rule that matches gives the reason.
export const EXCLUSIONS = [
  { reason: "per-account", test: (k) => /ByAccount$/.test(k) },
  {
    reason: "permission",
    test: (k) => /^bypassPermissions/.test(k) || k === "allowAllBrowserActions" || k === "dispatchCodeTasksPermissionMode",
  },
  {
    reason: "trust grant",
    test: (k) =>
      /Trusted|Grants?$|Consent|AllowedOrigins|AllowedDomainTransitions|PrivateNetwork|AccessReports|AdoptionChecked|Authed/.test(k),
  },
  {
    reason: "device",
    test: (k) => ["chromeExtension", "remoteToolsDeviceName", "folderTccProbeResults", "selfHostedGrantsHost"].includes(k),
  },
  { reason: "organisation policy", test: (k) => /^org[A-Z]|Hipaa/.test(k) },
  {
    reason: "Claude's own state",
    test: (k) =>
      k === "epitaxyPrefs" ||
      /^launchPreview(PersistedWorkspaces|SessionScopedSessions)$/.test(k) ||
      /HasBoundRoutine|ProvenFor$|(Pruned|Latched|Seeded|Checked|Migrated|KillSwitchEngaged)$/.test(k),
  },
];

// Friendlier names for the settings people recognise. Anything else is shown
// by its key.
const LABELS = {
  menuBarEnabled: "menu bar icon",
  quickEntryShortcut: "Quick Entry shortcut",
  quickEntryDictationShortcut: "Quick Entry dictation shortcut",
  dictationShortcut: "dictation shortcut",
  legacyQuickEntryEnabled: "legacy Quick Entry",
  keepAwakeEnabled: "keep awake",
  sidebarMode: "sidebar mode",
  coworkPreferredBrowser: "preferred browser",
  ccRemoteControlDefaultEnabled: "Remote Control default",
  ccBranchPrefix: "branch prefix",
};

export function preferenceLabel(key) {
  return LABELS[key] || key;
}

// "menu bar icon, keep awake, sidebar mode and 4 more". Settings with a
// friendly name come first, so the ones people recognise are the ones shown.
export function describePreferences(keys, max = 4) {
  const names = [...keys.filter((k) => k in LABELS), ...keys.filter((k) => !(k in LABELS))].map(preferenceLabel);
  if (names.length <= max) return names.join(", ");
  return `${names.slice(0, max).join(", ")} and ${names.length - max} more`;
}

export function exclusionReason(key) {
  const rule = EXCLUSIONS.find((r) => r.test(key));
  return rule ? rule.reason : null;
}

// Splits a preferences object into what may be copied and what stays behind.
export function classifyPreferences(prefs) {
  const copyable = {};
  const excluded = [];
  if (!isPlainObject(prefs)) return { copyable, excluded };
  for (const [key, value] of Object.entries(prefs)) {
    const reason = exclusionReason(key);
    if (reason) excluded.push({ key, reason });
    else copyable[key] = value;
  }
  return { copyable, excluded };
}

export function preferencesFile(dataDir) {
  return path.join(dataDir, CONFIG_NAME);
}

// The `preferences` object of a config file. {} for a missing file or one
// without preferences; null when the file exists but cannot be parsed.
export function readDesktopPreferences(file = DEFAULT_DESKTOP_PREFERENCES_FILE) {
  if (!fileExists(file)) return {};
  try {
    const config = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!isPlainObject(config)) return null;
    return isPlainObject(config.preferences) ? config.preferences : {};
  } catch {
    return null;
  }
}

// How a profile's settings compare with the source's copyable ones.
//   missing   - the source has it, the profile does not
//   differing - both have it, with different values
// status is "ok", "none" (the source has nothing copyable or is unreadable)
// or "foreign" (the profile's config cannot be parsed).
export function comparePreferences(dataDir, { sourceFile = DEFAULT_DESKTOP_PREFERENCES_FILE } = {}) {
  const empty = { missing: [], differing: [], excluded: [] };
  const source = readDesktopPreferences(sourceFile);
  if (!source) return { status: "none", ...empty };
  const { copyable, excluded } = classifyPreferences(source);
  if (Object.keys(copyable).length === 0) return { status: "none", ...empty, excluded };

  const own = readDesktopPreferences(preferencesFile(dataDir));
  if (!own) return { status: "foreign", ...empty, excluded };

  const missing = [];
  const differing = [];
  for (const [key, value] of Object.entries(copyable)) {
    if (!(key in own)) missing.push(key);
    else if (!sameValue(own[key], value)) differing.push(key);
  }
  return { status: "ok", missing, differing, excluded };
}

// Copies the source's copyable settings into a profile. Returns
// { status, added, replaced, differing, excluded }, where status is one of:
//   "seeded"  - settings were written into the profile
//   "current" - nothing to write
//   "none"    - the source has nothing copyable
//   "foreign" - the profile has a config we could not parse; left alone
// `differing` lists the settings the profile kept because it has its own
// value; pass `overwrite: true` to replace those too. `addMissing: false`
// skips the ones the profile does not have, for a replace-only copy.
export function seedDesktopPreferences(
  dataDir,
  { sourceFile = DEFAULT_DESKTOP_PREFERENCES_FILE, addMissing = true, overwrite = false } = {}
) {
  const diff = comparePreferences(dataDir, { sourceFile });
  const result = { status: diff.status, added: [], replaced: [], differing: [], excluded: diff.excluded };
  if (diff.status !== "ok") return result;

  const add = addMissing ? diff.missing : [];
  const replace = overwrite ? diff.differing : [];
  result.differing = overwrite ? [] : diff.differing;
  if (add.length === 0 && replace.length === 0) return { ...result, status: "current" };

  const file = preferencesFile(dataDir);
  // comparePreferences already refused a config it could not parse.
  const config = fileExists(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  if (!isPlainObject(config.preferences)) config.preferences = {};
  const { copyable } = classifyPreferences(readDesktopPreferences(sourceFile));
  for (const key of [...add, ...replace]) config.preferences[key] = copyable[key];
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n", "utf8");

  return { ...result, status: "seeded", added: add, replaced: replace };
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function sameValue(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
