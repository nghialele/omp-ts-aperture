# Developing against oh-my-pi

This package targets the [oh-my-pi](https://github.com/can1357/oh-my-pi) host.
`node_modules/@oh-my-pi/*` must resolve to that workspace, either from a real
install or from a local checkout used for reference and type-checking.

```bash
# one-time
git clone https://github.com/can1357/oh-my-pi.git oh-my-pi

# link the host packages (directory name -> published name)
mkdir -p node_modules/@oh-my-pi
ln -sfn "$PWD/oh-my-pi/packages/ai"           node_modules/@oh-my-pi/pi-ai
ln -sfn "$PWD/oh-my-pi/packages/catalog"      node_modules/@oh-my-pi/pi-catalog
ln -sfn "$PWD/oh-my-pi/packages/coding-agent" node_modules/@oh-my-pi/pi-coding-agent
ln -sfn "$PWD/oh-my-pi/packages/utils"        node_modules/@oh-my-pi/pi-utils
ln -sfn "$PWD/oh-my-pi/packages/omptype"      node_modules/@oh-my-pi/omptype
ln -sfn "$PWD/oh-my-pi/packages/tui"          node_modules/@oh-my-pi/pi-tui
```

Then:

```bash
bun test          # no Rust addon required, see below
bun run typecheck # requires an `oh-my-pi/node_modules` install for tsc deps
```

Tests need no `pi_natives` addon: `test-support/preload.ts` serves a synthetic
module through `Bun.plugin`, wired in by `bunfig.toml`. Type-checking against the
host needs its own dependencies installed (`bun install` inside `oh-my-pi`).
