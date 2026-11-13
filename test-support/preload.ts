/**
 * Bun test preload that serves a synthetic `@oh-my-pi/pi-natives`.
 *
 * Importing the real package (directly or through pi-ai, pi-catalog, and
 * pi-coding-agent) loads the Rust `pi_natives` addon at module scope. A
 * checkout without a built addon then cannot even import the extension, so no
 * unit test could run. Bun applies newly registered `Bun.plugin` interceptors
 * to `import` statements compiled after registration, which is why this lives
 * in `[test] preload` (see `bunfig.toml`).
 *
 * The synthetic modules export one symbol per real export; every symbol is an
 * inert value that throws only if native code is actually called. Routing,
 * config, and catalog tests never call it.
 */

import * as nativesShim from "./natives-shim";

const NATIVES_PACKAGE = "@oh-my-pi/pi-natives";

const ROOT_EXPORTS = Object.entries(nativesShim).filter(
  ([name, value]) => name !== "default" && typeof value !== "undefined",
);

/** Subpath modules re-export these names from their parent module. */
const SUBPATH_EXPORTS: Record<string, readonly string[]> = {
  path: ["expandWindowsLongPath", "getWindowsShortPath"],
  clipboard: [
    "copyToClipboard",
    "readImageFromClipboard",
    "readTextFromClipboard",
  ],
  "sqlite-locks": ["installSqliteLockShim", "heldFileKind"],
  desktop: [
    "createDesktopSession",
    "desktopEscapeStops",
    "forgetDesktopEscapeStops",
    "closeDesktopEventTaps",
  ],
  vcs: [
    "isVcsError",
    "isEmptyCherryPick",
    "git",
    "repo",
    "repoForDisplay",
    "require",
    "requireGit",
    "gitInfo",
    "jj",
    "isPureJj",
    "clone",
    "detachGitDir",
    "copyGitObjects",
    "runPostCheckoutHook",
    "joinPatches",
    "validateHunkSelections",
    "watch",
    "HEAD_WATCH_INTERVAL_MS",
  ],
};

const ROOT = Object.fromEntries(ROOT_EXPORTS);

Bun.plugin({
  name: "aperture-natives-shim",
  setup(build) {
    build.module(NATIVES_PACKAGE, () => ({ exports: ROOT, loader: "object" }));

    build.onResolve({ filter: /^@oh-my-pi\/pi-natives\// }, (args) => {
      const sub = args.path
        .slice(NATIVES_PACKAGE.length)
        .replace(/^\.?\//, "")
        .replace(/\.js$/, "");
      return { path: sub, namespace: "natives-subpath", importer: "" };
    });

    build.onLoad({ filter: /.*/, namespace: "natives-subpath" }, (args) => {
      const names = SUBPATH_EXPORTS[args.path];
      if (!names) {
        throw new Error(`natives shim: unknown subpath "${args.path}"`);
      }
      const exports: Record<string, unknown> = {};
      for (const name of names) {
        if (!(name in ROOT)) {
          throw new Error(`natives shim: missing root export "${name}"`);
        }
        exports[name] = ROOT[name];
      }
      return { exports, loader: "object" };
    });
  },
});
