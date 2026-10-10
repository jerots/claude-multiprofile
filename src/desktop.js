// Claude Desktop profile setup.
//
// Background:
//
// Claude Desktop is an Electron app. Electron, like Chromium, supports
// the `--user-data-dir` command-line flag, which forces the app to read
// and write all of its state (auth tokens, chat list, settings, MCP
// connectors, projects, etc.) to a directory of your choosing rather than
// the default `~/Library/Application Support/Claude`.
//
// This is the entire mechanism behind multi-account support. Each profile
// gets its own user-data-dir, which means each profile has its own
// completely isolated:
//
//   - Logged-in account
//   - Chat history
//   - MCP servers and connectors
//   - Custom styles
//   - Projects
//   - Preferences
//
// What this module does:
//
//   1. Creates the user-data-dir for the new profile.
//   2. Builds a real macOS .app bundle (an Info.plist and a tiny shell
//      script) that, when launched, invokes Claude with the right
//      --user-data-dir flag. This gives the user a draggable Dock icon.
//   3. Copies Claude's own .icns icon onto the new .app so it's
//      visually recognizable, optionally tinted later by the user.
//
// Why a .app and not a shell alias?
//
// macOS doesn't let you put shell aliases on the Dock. The user wants to
// click an icon, not type a command. .command files work but launch a
// background Terminal window, which is ugly. A .app bundle whose executable
// is a shell script appears as a real application (dock-able, Spotlight-
// searchable, with a custom name) and, unlike an AppleScript applet, never
// takes focus or shows a "Press Run" screen. See compileApp.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ensureColoredClone, applyColor, clonePathFor, psSnapshot } from "./appclone.js";
import { installHelper, helperSpecFor } from "./launchhelper.js";
import { blockUpdates } from "./updates.js";
import { seedDesktopPreferences } from "./preferences.js";
import {
  HOME,
  pathStr,
  command,
  ok,
  info,
  warn,
  step,
  tildify,
  fileExists,
  titleCase,
} from "./util.js";

// Conventional location for Claude's data folder. We don't change this for
// the default profile, only for new profiles.
const DEFAULT_CLAUDE_DATA_PARENT = path.join(
  HOME,
  "Library",
  "Application Support"
);

// Where to look for the installed Claude.app. /Applications is the standard
// install location; we fall back to ~/Applications which is where users land
// when they install without admin rights.
const CLAUDE_APP_CANDIDATES = [
  "/Applications/Claude.app",
  path.join(HOME, "Applications", "Claude.app"),
];

// ---- Discovery -----------------------------------------------------------

export function findClaudeApp() {
  // Returns the path to /Applications/Claude.app or its alternative,
  // or null if not found. We don't try `mdfind` because it can be slow
  // and may surface unrelated bundles.
  for (const candidate of CLAUDE_APP_CANDIDATES) {
    if (fileExists(candidate)) return candidate;
  }
  return null;
}

export function defaultDataDirFor(name) {
  // The standard suggestion. Users can override during the wizard.
  return path.join(DEFAULT_CLAUDE_DATA_PARENT, `Claude-${titleCase(name)}`);
}

export function defaultAppPathFor(name) {
  // Defaults to ~/Applications because it never requires sudo.
  // /Applications would arguably be more "correct" but writing there
  // can prompt for admin in some macOS configurations, which we'd rather
  // avoid in an automated wizard.
  const appsDir = path.join(HOME, "Applications");
  return path.join(appsDir, `Claude ${titleCase(name)}.app`);
}

// ---- Data directory --------------------------------------------------

export function ensureDataDir(dataDir) {
  // Creates the user-data-dir if it doesn't exist. Important: we never
  // copy the existing default Claude profile in. Doing so would carry
  // over the credentials cookie, and the new profile would launch
  // already signed into the wrong account. Each profile must start clean
  // and be signed into independently.
  fs.mkdirSync(dataDir, { recursive: true });
}

// ---- MCP connectors ------------------------------------------------
//
// Desktop reads its MCP connectors from
// <user-data-dir>/claude_desktop_config.json, so a fresh profile starts with
// none of the servers the default profile has. Claude Code profiles get theirs
// from seedConfigDir() in src/code.js; this is the Desktop half of that idea.
//
// That file is not only connectors: it also holds `preferences` and whatever
// servers the user added by hand in this profile. So update the mcpServers map
// rather than overwrite the file, and refuse to touch a config we cannot
// parse - a hand-made file is worth more than the convenience.
//
// Timing matters: Claude rewrites this file from its own state while it runs,
// so a write behind a live instance is lost at the next flush. Seeding here is
// safe because the profile is being created and nothing is running on it yet;
// the doctor check that repairs an existing profile guards with dataDirInUse.

export const DEFAULT_DESKTOP_CONFIG_FILE = path.join(
  DEFAULT_CLAUDE_DATA_PARENT,
  "Claude",
  "claude_desktop_config.json"
);

export function desktopConfigFile(dataDir) {
  return path.join(dataDir, "claude_desktop_config.json");
}

// Returns { status, added, total }, where status is one of:
//   "seeded"  - servers were written into the profile
//   "current" - the profile already had every server
//   "none"    - nothing to copy: no readable source servers
//   "foreign" - the profile has a config we could not parse; left alone
//
// `only` limits the copy to the named servers (the explicit, pick-what-you-
// want copy in `extensions`). A server the profile already has is never
// replaced, even when the source has one by the same name: a work profile's
// `github` server, with its work token, must not be overwritten by the
// default profile's personal one. Copying only ever adds.
export function seedDesktopMcpServers(
  dataDir,
  { sourceFile = DEFAULT_DESKTOP_CONFIG_FILE, only = null } = {}
) {
  const nothing = { status: "none", added: [], total: 0 };
  let servers;
  try {
    servers = JSON.parse(fs.readFileSync(sourceFile, "utf8")).mcpServers;
  } catch {
    return nothing;
  }
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return nothing;
  if (only) {
    servers = Object.fromEntries(Object.entries(servers).filter(([k]) => only.includes(k)));
  }
  if (Object.keys(servers).length === 0) return nothing;

  const file = desktopConfigFile(dataDir);
  let config = {};
  if (fileExists(file)) {
    try {
      config = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return { status: "foreign", added: [], total: 0 };
    }
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      return { status: "foreign", added: [], total: 0 };
    }
  }

  const existing =
    config.mcpServers && typeof config.mcpServers === "object" && !Array.isArray(config.mcpServers)
      ? config.mcpServers
      : {};
  // The profile's own entries are spread last, so they win.
  const added = Object.keys(servers).filter((k) => !(k in existing));
  const merged = { ...servers, ...existing };
  const total = Object.keys(merged).length;
  if (added.length === 0) {
    return { status: "current", added: [], total };
  }
  config.mcpServers = merged;
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n", "utf8");
  return { status: "seeded", added, total };
}

// ---- .app bundle generation ----------------------------------------

export function buildLaunchCommand(dataDir, claudeAppPath, codeConfigDir, ghConfigDir, dedicatedBundle = false, helper = null, { background = true } = {}) {
  // The `open -n` flag forces a new instance even when Claude is already
  // running. Without -n, macOS would route the request to the existing
  // Claude window and ignore our --user-data-dir argument entirely.
  //
  // The `-a` argument takes a path or app name; we pass the explicit path
  // so this works even if there are multiple Claude.app bundles around.
  //
  // `--env CLAUDE_CONFIG_DIR=...` closes the other half of the isolation.
  // --user-data-dir separates Claude DESKTOP state (auth, chats, settings,
  // MCP connectors). It does NOT separate the Claude CODE sessions that
  // Desktop spawns: those read ~/.claude in every profile, because Desktop
  // does not set CLAUDE_CONFIG_DIR for the CLI it launches. The practical
  // effect is that CLAUDE.md, settings.json, and per-project memory MERGE
  // across profiles even when Desktop itself is cleanly separated, which
  // is the failure this whole tool exists to prevent.
  //
  // Verified on macOS 25.5 (2026-07-29), A/B against a control launch:
  // `open --env` sets the variable in the launched app's environment AND in
  // the environment its child processes inherit, which is the exact relationship
  // Claude.app has with the claude-code CLI. Passing it via --env rather
  // than launching the binary directly keeps `open -n` semantics intact,
  // which the -n comment above explains is load-bearing.
  //
  // codeConfigDir is optional: when the profile has no Claude Code target,
  // omitting it leaves Desktop-spawned Claude Code on the default ~/.claude,
  // which is the pre-existing behaviour.
  //
  // Paths cross TWO quoting layers here and both have to be honoured:
  //
  //   1. the shell command, where each path sits inside single quotes
  //   2. the AppleScript string literal that `do shell script` takes
  //
  // Escaping only for the shell is what the code used to do, and it breaks on
  // an apostrophe: the POSIX escape is '\'' , and that backslash lands inside
  // an AppleScript double-quoted string where \' is not a valid escape, so
  // osacompile refuses the script outright. A user named o'brien has an
  // apostrophe in $HOME and therefore in every default path we generate, so
  // this is reachable rather than theoretical.
  //
  // GH_CONFIG_DIR rides along the same way when the profile has its own
  // GitHub CLI login. Without it, Claude Code opened from inside Desktop
  // would use the profile's Claude config but the machine's default gh
  // account, which is a confusing half-isolation.
  // `-n` forces a brand new instance. It is required when the launch target is
  // the SHARED /Applications/Claude.app, because without it macOS routes the
  // request to whatever Claude is already running and drops our
  // --user-data-dir entirely, silently opening the wrong profile.
  //
  // When the profile has its own cloned bundle, that reasoning inverts.
  // Nothing else runs from that path, so `open -a <clone>` targets exactly
  // this profile: it launches the app if it is not running, and focuses the
  // existing window if it is. Dropping `-n` there is what stops every click
  // on the Dock icon from stacking up another copy.
  const newInstance = dedicatedBundle ? "" : "-n ";
  const openLine =
    `open ${newInstance}-a ${shellQuote(claudeAppPath)} ` +
    (codeConfigDir ? `--env ${shellQuote(`CLAUDE_CONFIG_DIR=${codeConfigDir}`)} ` : "") +
    (ghConfigDir ? `--env ${shellQuote(`GH_CONFIG_DIR=${ghConfigDir}`)} ` : "") +
    `--args --user-data-dir=${shellQuote(dataDir)} > /dev/null 2>&1${background ? " &" : ";"}`;

  // A profile with its own copy routes through the launch helper
  // (src/launchhelper.js), which keeps the copy current and catches it
  // running on the wrong account before opening it. The helper gets the same
  // open arguments as an array. If the helper file is missing, the launcher
  // runs exactly the line above, so the helper can never be why Claude fails
  // to open.
  if (!dedicatedBundle || !helper) return openLine;

  const openArgs = ["-a", claudeAppPath];
  if (codeConfigDir) openArgs.push("--env", `CLAUDE_CONFIG_DIR=${codeConfigDir}`);
  if (ghConfigDir) openArgs.push("--env", `GH_CONFIG_DIR=${ghConfigDir}`);
  openArgs.push("--args", `--user-data-dir=${dataDir}`);
  const helperArgs = [claudeAppPath, helper.source, helper.hue || "", dataDir, helper.label, ...openArgs];
  const cmd =
    `if [ -f ${shellQuote(helper.path)} ]; then ` +
    `/usr/bin/osascript -l JavaScript ${shellQuote(helper.path)} ${helperArgs.map(shellQuote).join(" ")} > /dev/null 2>&1${background ? " &" : ";"} ` +
    `else ${openLine} fi`;
  return cmd;
}

// The same command, wrapped for an AppleScript launcher (`osacompile`). Only
// launchers built before v0.1.34-jerots.1 are AppleScript; this is kept so they
// can still be read back and compared.
export function buildLaunchAppleScript(...args) {
  return `do shell script ${appleScriptString(buildLaunchCommand(...args))}`;
}

// The same command as the program of a plain .app bundle (see compileApp).
//
// Run in the foreground: the launcher exits once `open` (or the helper) has
// handed over. A launcher started by LaunchServices that backgrounds `open`
// and exits at once loses the launch, verified on macOS 15 with a stand-in
// app: nothing opened until the launcher waited for it.
//
// A launcher whose executable is a shell script never connects to the window
// server, so opening it does not take focus from the app in front. That is
// what lets the launch helper see that this profile is already in front and
// hide it, which makes a hotkey on the launcher (Raycast, Alfred, a Dock
// click) toggle the profile the way it toggles any other app. An AppleScript
// launcher takes focus as it starts, and with a modifier key still held it
// stops at the "Press Run to run this script" screen instead.
export function buildLauncherScript(dataDir, claudeAppPath, codeConfigDir, ghConfigDir, dedicatedBundle = false, helper = null) {
  return [
    "#!/bin/bash",
    "# Written by claude-multiprofile; rebuilt by `claude-multiprofile doctor --fix`.",
    "# Opens this profile's copy of Claude with its own data folder. Runs in the",
    "# foreground and exits once it has handed over; it never takes focus.",
    buildLaunchCommand(dataDir, claudeAppPath, codeConfigDir, ghConfigDir, dedicatedBundle, helper, { background: false }),
    "",
  ].join("\n");
}

// Whether a launcher goes through the launch helper. Read back from the
// compiled script, like the env checks below, because the bundle is the only
// record of what a launcher actually does.
// Matched on a fixed suffix rather than the full path: the path sits inside
// two escaping layers, and a home folder with an apostrophe would not match
// itself verbatim.
export function launcherUsesHelper(appPath) {
  const src = readLauncherScript(appPath);
  if (src === null) return undefined;
  return src.includes("claude-multiprofile/bin/launch.js");
}

// Wrap a value in shell single quotes, escaping embedded apostrophes the POSIX
// way (close quote, escaped quote, reopen).
function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// Render a value as an AppleScript string literal. AppleScript escapes only
// backslash and double quote; everything else, apostrophes included, is
// literal once the backslashes are doubled.
function appleScriptString(s) {
  return `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// PlistBuddy is the standard tool for editing .plist files on macOS. Always
// at this path, ships with the OS.
const PLIST_BUDDY = "/usr/libexec/PlistBuddy";

// Which Claude account a Desktop data directory is currently signed in as.
//
// Claude Desktop records this in config.json at the top level. We read it for
// one reason: two profiles must never be the same account. If they are, the
// isolation has failed in the way that actually matters to a user, even though
// every path, launcher, and data directory still checks out.
//
// How that happens: signing in uses a `claude://` deep link, and macOS routes
// it to whichever Claude instance answers first. With two instances running,
// the token can land in the wrong data directory. A Claude update that forces
// re-authentication is a common trigger, because both profiles get prompted at
// once. The result is a profile that opens the correct folder while
// authenticated as somebody else.
//
// Returns null when the profile has never been signed in, or the file is
// missing or unreadable, all of which are ordinary states rather than errors.
export function desktopAccountUuid(dataDir) {
  const cfg = path.join(dataDir, "config.json");
  if (!fileExists(cfg)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(cfg, "utf8"));
    const id = parsed && parsed.lastKnownAccountUuid;
    return typeof id === "string" && id ? id : null;
  } catch {
    return null;
  }
}

// ---- Reading back an existing launcher -------------------------------------
//
// A launcher built before v0.1.12 has no `--env CLAUDE_CONFIG_DIR=...` in its
// launch line, so Claude Code sessions spawned from that Desktop instance fall
// back to the shared ~/.claude. The bundle is the only record of what a
// launcher actually does (the registry never stored it), so `doctor` reads the
// compiled script back rather than inferring from the profile's age.
//
// Two kinds exist. Launchers built since v0.1.34-jerots.1 are a plain bundle
// whose executable is a shell script (see compileApp). Older ones are
// osacompile'd AppleScript applets. Converting an applet in place leaves its
// applet binary and main.scpt behind, so `doctor --undo` can restore it, and
// Info.plist's CFBundleExecutable is what says which one actually runs.

export const LAUNCHER_EXECUTABLE = "launcher";

export function launcherScriptPath(appPath) {
  return path.join(appPath, "Contents", "MacOS", LAUNCHER_EXECUTABLE);
}

// "script", "applet", or null when there is no launcher to read.
export function launcherKind(appPath) {
  const plist = path.join(appPath, "Contents", "Info.plist");
  if (!fileExists(plist)) return null;
  let exe = null;
  try {
    exe = execFileSync(PLIST_BUDDY, ["-c", "Print :CFBundleExecutable", plist], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    // No executable key; fall through to what is on disk.
  }
  if (exe === LAUNCHER_EXECUTABLE && fileExists(launcherScriptPath(appPath))) return "script";
  if (fileExists(path.join(appPath, "Contents", "Resources", "Scripts", "main.scpt"))) return "applet";
  return null;
}

export function readLauncherScript(appPath) {
  const kind = launcherKind(appPath);
  if (kind === "script") {
    try {
      return fs.readFileSync(launcherScriptPath(appPath), "utf8");
    } catch {
      return null;
    }
  }
  if (kind !== "applet") return null;
  // osacompile stores the compiled script here; osadecompile turns it back
  // into source. Both ship with macOS.
  const scpt = path.join(appPath, "Contents", "Resources", "Scripts", "main.scpt");
  try {
    return execFileSync("/usr/bin/osadecompile", [scpt], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return null;
  }
}

// The value a launcher exports for `name`, or null if it exports none.
// Returns undefined when the script can't be read at all, so callers can tell
// "no env flag" apart from "couldn't look".
export function launcherEnvVar(appPath, name) {
  const src = readLauncherScript(appPath);
  if (src === null) return undefined;
  // Our generated line places every --env before --args, so match up to the
  // closing quote that precedes either the next --env or --args.
  const m = src.match(new RegExp(`--env '${name}=(.*?)' --`));
  if (!m) return null;
  // Undo the escaping layers in the order they were applied, outermost
  // first: decompiled text is AppleScript source (so backslashes are
  // doubled), and inside it the path is shell single-quote escaped. A script
  // launcher has only the shell layer.
  const shellText =
    launcherKind(appPath) === "applet" ? m[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\") : m[1];
  return shellText.replace(/'\\''/g, "'");
}

export function launcherCodeConfigDir(appPath) {
  return launcherEnvVar(appPath, "CLAUDE_CONFIG_DIR");
}

export function launcherGhConfigDir(appPath) {
  return launcherEnvVar(appPath, "GH_CONFIG_DIR");
}

export function uniqueBundleId(name) {
  // Every osacompile'd AppleScript .app inherits the default
  // CFBundleIdentifier `com.apple.ScriptEditor.id.applet`. When the user
  // has multiple such launchers (one per profile), LaunchServices treats
  // them as duplicates of the same app, and Dock double-clicks can stop
  // resolving to the right binary. Giving each launcher a unique reverse-
  // DNS bundle identifier avoids the collision entirely.
  //
  // We sanitise `name` to keep it inside the [a-zA-Z0-9-] character class
  // CFBundleIdentifier expects.
  const safe = String(name).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "profile";
  return `com.claude-multiprofile.${safe}`;
}

// The identifier every osacompile'd bundle ships with until we stamp our own.
// Launchers still carrying it were created before v0.1.9 (or hand-built) and
// are exposed to the LaunchServices collision bug. `doctor` looks for it.
export const DEFAULT_APPLET_BUNDLE_ID = "com.apple.ScriptEditor.id.applet";

export function getBundleId(appPath) {
  const plist = path.join(appPath, "Contents", "Info.plist");
  if (!fileExists(plist)) return null;
  try {
    return execFileSync(PLIST_BUDDY, ["-c", "Print :CFBundleIdentifier", plist], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

// Set or clear LSUIElement on a launcher.
//
// v0.1.22 set this to hide the launcher's brief Dock tile. That was a mistake:
// LSUIElement marks an app as a background agent, and macOS does not keep
// agent apps pinned in the Dock or relaunch them reliably from a pin. The
// symptom was a launcher that showed a blank tile, would not stay pinned, and
// would not reopen after quitting. v0.1.24 clears it again. Kept as a function
// so existing launchers can be repaired.
// Remove the compiled asset catalog so CFBundleIconFile (applet.icns) is used.
// See the note in compileApp for why this is load-bearing.
export function stripAssetCatalog(appPath) {
  let changed = false;
  const plist = path.join(appPath, "Contents", "Info.plist");
  if (fileExists(plist)) {
    try {
      execFileSync(PLIST_BUDDY, ["-c", "Delete :CFBundleIconName", plist], {
        stdio: "pipe",
      });
      changed = true;
    } catch {
      // Key already absent.
    }
  }
  const car = path.join(appPath, "Contents", "Resources", "Assets.car");
  if (fileExists(car)) {
    try {
      fs.rmSync(car);
      changed = true;
    } catch {
      // Non-fatal.
    }
  }
  return changed;
}

// True when a launcher still has the asset catalog shadowing its icon.
export function hasAssetCatalog(appPath) {
  return fileExists(path.join(appPath, "Contents", "Resources", "Assets.car"));
}

export function setUiElement(appPath, hidden = true) {
  const plist = path.join(appPath, "Contents", "Info.plist");
  if (!fileExists(plist)) return false;
  const value = hidden ? "true" : "false";
  try {
    execFileSync(PLIST_BUDDY, ["-c", `Set :LSUIElement ${value}`, plist], {
      stdio: "pipe",
    });
    return true;
  } catch {
    try {
      execFileSync(PLIST_BUDDY, ["-c", `Add :LSUIElement bool ${value}`, plist], {
        stdio: "pipe",
      });
      return true;
    } catch {
      return false;
    }
  }
}

export function isUiElement(appPath) {
  const plist = path.join(appPath, "Contents", "Info.plist");
  if (!fileExists(plist)) return null;
  try {
    const out = execFileSync(PLIST_BUDDY, ["-c", "Print :LSUIElement", plist], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return out === "true" || out === "1";
  } catch {
    return false; // key absent means visible
  }
}

export function setBundleId(appPath, bundleId) {
  // PlistBuddy needs the literal Info.plist path, not the .app path.
  const plist = path.join(appPath, "Contents", "Info.plist");
  if (!fileExists(plist)) return false;
  // `Set` overwrites if present, errors if not. We pipe stderr so a missing
  // key doesn't pollute output; on error we fall back to `Add`.
  try {
    execFileSync(PLIST_BUDDY, ["-c", `Set :CFBundleIdentifier ${bundleId}`, plist], {
      stdio: "pipe",
    });
  } catch {
    try {
      execFileSync(
        PLIST_BUDDY,
        ["-c", `Add :CFBundleIdentifier string ${bundleId}`, plist],
        { stdio: "pipe" }
      );
    } catch {
      return false;
    }
  }
  return true;
}

export function stripQuarantine(appPath) {
  // Removes any com.apple.quarantine attribute applied by Gatekeeper. On a
  // freshly osacompile'd bundle there usually isn't one, but if the user
  // has copied the .app between machines via cloud sync or AirDrop it can
  // attach silently. Returns true if the call succeeded; the attribute may
  // not have been present, which is also fine.
  try {
    execFileSync("/usr/bin/xattr", ["-dr", "com.apple.quarantine", appPath], {
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

// Whether any running Claude is using this data folder. Catches a profile
// open through its own copy AND one opened on the shared Claude.app (profiles
// created before v0.1.23 launch that way).
export function dataDirInUse(dataDir, psOutput = psSnapshot()) {
  const flag = ` --user-data-dir=${dataDir}`;
  return psOutput.split("\n").some((line) => {
    const i = line.indexOf(flag);
    if (i < 0) return false;
    // Followed by a space or the end, so Claude-WORK never matches Claude-WORK2.
    const next = line.charAt(i + flag.length);
    return next === "" || next === " ";
  });
}

// Where a profile's launcher should point, for every place that rebuilds one.
//
// Since v0.1.23 a Desktop profile launches its own copy of Claude.app. Several
// rebuild paths (rename, linking a Code half, enabling gh isolation, doctor's
// env repairs) still passed the shared /Applications/Claude.app, so repairing
// one thing quietly pointed the launcher back at the shared app: no colour on
// the running window, a new window on every click, and no launch helper.
// Deciding it here, from the copy actually on disk, keeps them all agreeing.
export function launchTargetFor(name, desktop) {
  if (fileExists(clonePathFor(name))) {
    return {
      claudeAppPath: clonePathFor(name),
      dedicatedBundle: true,
      sourceAppPath: desktop.claudeAppPath,
      color: desktop.color || null,
    };
  }
  return { claudeAppPath: desktop.claudeAppPath, dedicatedBundle: false };
}

export function compileApp({
  name,
  dataDir,
  appPath,
  claudeAppPath,
  codeConfigDir,
  ghConfigDir,
  dedicatedBundle = false,
  sourceAppPath = null,
  color = null,
}) {
  // The launcher is a plain .app bundle written by hand: an Info.plist, and a
  // shell script as its executable (buildLauncherScript). Until
  // v0.1.34-jerots.1 it was an AppleScript applet from `osacompile`, which
  // took focus as it started (so a hotkey could never hide the profile),
  // showed AppleScript's "Press Run" screen when opened with a modifier key
  // held, and was named "staged" after the temp path it was compiled to.
  //
  // `sourceAppPath` is the Claude.app the profile's copy is built from. With
  // it, and a dedicated copy, the launcher goes through the launch helper,
  // which is installed here so a new launcher never points at a helper that
  // is not on disk yet.
  // A launcher written over the app it opens would delete that app and then
  // open itself. macOS disks ignore case, so compare that way.
  if (path.resolve(appPath).toLowerCase() === path.resolve(claudeAppPath).toLowerCase()) {
    throw new Error(`the launcher path ${appPath} is the same as the app it opens`);
  }

  let helper = null;
  if (dedicatedBundle && sourceAppPath) {
    installHelper();
    helper = helperSpecFor({ sourceAppPath, color, appPath });
  }
  const script = buildLauncherScript(dataDir, claudeAppPath, codeConfigDir, ghConfigDir, dedicatedBundle, helper);
  const bundle = {
    script,
    bundleId: uniqueBundleId(name),
    displayName: path.basename(appPath, ".app"),
  };

  // Make sure the parent directory of the .app exists. ~/Applications is
  // not auto-created on a fresh user account so we ensure it.
  fs.mkdirSync(path.dirname(appPath), { recursive: true });

  // Updating an EXISTING launcher rewrites its files inside the bundle,
  // leaving the bundle directory itself untouched.
  //
  // This matters because the Dock remembers a pinned app by its location, and
  // deleting the bundle and writing a new one in its place breaks that
  // reference: the pin goes stale and the user has to drag the icon back.
  // `rename`, `doctor --fix`, and the link flows all rebuild launchers, so
  // delete-and-recreate meant a re-pin after routine maintenance. Writing in
  // place keeps the bundle, and with it the pin, the custom icon, and anything
  // else already stamped on it. An old AppleScript launcher is converted the
  // same way; its applet binary and main.scpt stay behind, unused, so that
  // `doctor --undo` (which restores Info.plist) brings it back intact.
  const updatingInPlace = fileExists(path.join(appPath, "Contents", "Info.plist"));
  if (updatingInPlace) {
    writeLauncherBundle(appPath, bundle);
  } else {
    // Build beside the target first, never straight over it.
    const tmpDir = fs.mkdtempSync(path.join(path.dirname(appPath), ".cmp-launcher-"));
    try {
      const staged = path.join(tmpDir, path.basename(appPath));
      writeLauncherBundle(staged, bundle);
      if (fileExists(appPath)) fs.rmSync(appPath, { recursive: true, force: true });
      fs.renameSync(staged, appPath);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  // Make applet.icns the ONLY icon source.
  //
  // osacompile emitted a compiled asset catalog (Assets.car) holding the
  // stock AppleScript icon, and pointed CFBundleIconName at it. macOS prefers
  // the catalog over CFBundleIconFile, so replacing applet.icns with Claude's
  // icon changed nothing that the Dock actually reads. A launcher built here
  // has no catalog; one converted from an applet may still carry it.
  stripAssetCatalog(appPath);

  return appPath;
}

function xmlEscape(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Write (or rewrite) a launcher bundle's Info.plist, executable and PkgInfo.
// The icon is applet.icns, written by copyClaudeIcon; an existing one is kept.
function writeLauncherBundle(appPath, { script, bundleId, displayName }) {
  const contents = path.join(appPath, "Contents");
  fs.mkdirSync(path.join(contents, "MacOS"), { recursive: true });
  fs.mkdirSync(path.join(contents, "Resources"), { recursive: true });

  // Written to a temp name and renamed, so a launcher clicked mid-rebuild
  // never runs half a script.
  const exe = launcherScriptPath(appPath);
  fs.writeFileSync(`${exe}.tmp`, script, { encoding: "utf8", mode: 0o755 });
  fs.chmodSync(`${exe}.tmp`, 0o755);
  fs.renameSync(`${exe}.tmp`, exe);

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDevelopmentRegion</key>
	<string>en</string>
	<key>CFBundleDisplayName</key>
	<string>${xmlEscape(displayName)}</string>
	<key>CFBundleExecutable</key>
	<string>${LAUNCHER_EXECUTABLE}</string>
	<key>CFBundleIconFile</key>
	<string>applet</string>
	<key>CFBundleIdentifier</key>
	<string>${xmlEscape(bundleId)}</string>
	<key>CFBundleInfoDictionaryVersion</key>
	<string>6.0</string>
	<key>CFBundleName</key>
	<string>${xmlEscape(displayName)}</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>1.0</string>
	<key>CFBundleVersion</key>
	<string>1</string>
	<key>NSHighResolutionCapable</key>
	<true/>
</dict>
</plist>
`;
  fs.writeFileSync(path.join(contents, "Info.plist"), plist, "utf8");
  fs.writeFileSync(path.join(contents, "PkgInfo"), "APPL????", "utf8");
}

// ---- Icon swap -------------------------------------------------------

export function copyClaudeIcon(appPath, claudeAppPath) {
  // Find the .icns inside Claude.app's Resources and copy it onto our
  // launcher as applet.icns.
  const sourceResources = path.join(claudeAppPath, "Contents", "Resources");
  const targetResources = path.join(appPath, "Contents", "Resources");

  if (!fileExists(sourceResources)) {
    return false;
  }

  // Look for any .icns; the exact name has changed over Claude releases.
  // First match wins, which is fine because Claude.app typically has
  // exactly one branding .icns.
  let sourceIcns = null;
  for (const file of fs.readdirSync(sourceResources)) {
    if (file.toLowerCase().endsWith(".icns")) {
      sourceIcns = path.join(sourceResources, file);
      break;
    }
  }
  if (!sourceIcns) return false;

  // The launcher's Info.plist names applet.icns as its icon (the name
  // osacompile used, kept so converted launchers match new ones). A new
  // launcher has none until this writes it.
  const targetIcns = path.join(targetResources, "applet.icns");
  if (!fileExists(path.join(appPath, "Contents"))) return false;
  fs.mkdirSync(targetResources, { recursive: true });
  fs.copyFileSync(sourceIcns, targetIcns);

  // Touch the .app so Finder/Dock pick up the icon change. Without this
  // step, the old generic AppleScript icon can stick around in cache for
  // a while.
  try {
    execFileSync("/usr/bin/touch", [appPath]);
  } catch {
    // Non-fatal; icon will refresh on next reboot or icon-cache rebuild.
  }
  return true;
}

// ---- Top-level orchestration -------------------------------------

export function setupDesktop({
  name,
  dataDir,
  appPath,
  claudeAppPath,
  applyIcon,
  codeConfigDir,
  ghConfigDir,
  color,
  seedConnectors = false,
  seedPreferences = false,
}) {
  // Wraps the whole setup. Returns a summary the wizard can save to the
  // registry and print to the user.
  step(`Creating Claude Desktop profile "${name}"`);

  info(`Data folder: ${pathStr(tildify(dataDir))}`);
  info(`Launcher app: ${pathStr(tildify(appPath))}`);
  info(`Claude.app source: ${pathStr(claudeAppPath)}`);
  if (codeConfigDir) info(`Code config for Desktop-spawned Claude Code: ${pathStr(tildify(codeConfigDir))}`);

  ensureDataDir(dataDir);
  ok("Data folder ready.");

  // Carry the default profile's MCP connectors over, when the user chose to
  // in the wizard. It is a choice rather than automatic because a connector's
  // config often carries its own credentials (tokens in `env`), and those are
  // the default account's: copying them into a work profile is the kind of
  // cross-account bleed a profile exists to prevent unless it was asked for.
  if (seedConnectors) {
    const mcp = seedDesktopMcpServers(dataDir);
    if (mcp.status === "seeded") {
      ok(`MCP connectors copied from your default profile: ${mcp.added.length} added, ${mcp.total} in total.`);
    } else if (mcp.status === "current") {
      ok(`MCP connectors already in place (${mcp.total}).`);
    } else if (mcp.status === "foreign") {
      warn("This data folder's claude_desktop_config.json could not be parsed; left it alone.");
      info(`  Its connectors stay as they are. ${command("claude-multiprofile doctor")} re-checks this.`);
    }
  }

  // Carry the default profile's app settings over (menu bar icon, Quick Entry
  // shortcut, keep awake...), when chosen in the wizard. Without them the
  // profile runs on Claude's defaults rather than the user's choices. What
  // must not cross accounts stays behind; see src/preferences.js.
  if (seedPreferences) {
    const prefs = seedDesktopPreferences(dataDir);
    if (prefs.status === "seeded") {
      ok(`App settings copied from your default profile: ${prefs.added.length}.`);
    } else if (prefs.status === "current") {
      ok("App settings already match your default profile.");
    } else if (prefs.status === "foreign") {
      warn("This data folder's claude_desktop_config.json could not be parsed; left it alone.");
      info(`  Its app settings stay as they are. ${command("claude-multiprofile doctor")} re-checks this.`);
    }
  }

  // A colour means the launcher opens a per-profile CLONE of Claude.app that
  // carries the tint, rather than the shared /Applications/Claude.app. That is
  // what puts the colour on the Dock tile of the running window: the running
  // process becomes the clone. See src/appclone.js for why this is cheap and
  // what it costs.
  // Every Desktop profile gets its own clone, tinted or not. Two reasons:
  //
  //   1. A dedicated bundle is what lets the launcher use `open -a <clone>`
  //      instead of `open -n`, so clicking the Dock icon focuses the profile's
  //      existing window rather than opening yet another copy of it.
  //   2. A colour, when chosen, has somewhere to live.
  //
  // The clone is an APFS copy: a couple of seconds and a few megabytes,
  // because the blocks stay shared with the original.
  let launchTarget = claudeAppPath;
  let clonePath = null;
  try {
    clonePath = ensureColoredClone({ name, claudeAppPath, color: color || null });
    launchTarget = clonePath;
    ok(color ? `Claude clone ready (${color}).` : "Claude clone ready for this profile.");
  } catch (e) {
    warn(`Could not build this profile's Claude clone: ${e.message}`);
    warn("Falling back to the shared Claude.app. Each click will open a new window.");
    color = null;
  }

  compileApp({
    name,
    dataDir,
    appPath,
    claudeAppPath: launchTarget,
    codeConfigDir,
    ghConfigDir,
    dedicatedBundle: Boolean(clonePath),
    sourceAppPath: claudeAppPath,
    color,
  });
  ok("Launcher .app compiled.");

  // Stop the copy updating itself (see src/updates.js). The launcher keeps it
  // current instead, on the first click after /Applications/Claude.app
  // updates, which avoids the relaunch onto the default account that every
  // self-update causes.
  if (clonePath) {
    try {
      const r = blockUpdates(dataDir);
      if (r === "foreign") {
        warn("This data folder already has its own Claude configuration; left it alone.");
        info("  The copy may update itself. `claude-multiprofile doctor` explains what that means.");
      } else {
        ok("Updates managed by the launcher: the copy is refreshed when your main Claude updates.");
      }
    } catch (e) {
      warn(`Could not set up managed updates: ${e.message}`);
    }
  }

  if (applyIcon) {
    const applied = copyClaudeIcon(appPath, claudeAppPath);
    if (applied) ok("Claude icon applied to launcher.");
    else warn("Could not locate a Claude icon to copy. Default AppleScript icon left in place.");
    // Tint the launcher too, so the icon you drag to the Dock matches the
    // window it opens instead of disagreeing with it.
    if (color && clonePath) {
      try {
        applyColor(appPath, claudeAppPath, color);
        ok("Launcher tinted to match.");
      } catch {
        // Non-fatal: the running app is what issue #2 is about.
      }
    }
  }

  return { dataDir, appPath, claudeAppPath, color: color || null, clonePath };
}
