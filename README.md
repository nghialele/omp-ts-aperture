# omp-ts-aperture

**Route [omp](https://omp.sh)'s models and MCP tools through [Tailscale Aperture](https://tailscale.com/docs/features/aperture), so your API keys can finally retire.**

```
You:        "omp, use GPT-5"
omp:        "ok"
Aperture:   "hold my beer, I'll handle the credentials"
Your .env:  *stays suspiciously empty*
```

---

## What is this?

A [Tailscale Aperture](https://tailscale.com/docs/features/aperture) gateway sits on your tailnet and injects upstream provider credentials server-side. That means: **your laptop never holds an OpenAI key, an Anthropic key, or that one API key your coworker pasted into Slack in 2023.**

This package teaches [omp](https://omp.sh) to grow a new provider called `aperture`, list the models your gateway actually serves, and send every request through it. omp stays confused and happy. The gateway does all the paperwork.

> **With love to the original.** This is a port of [`@aliou/pi-ts-aperture`](https://github.com/aliou/pi-ts-aperture) by [Aliou](https://github.com/aliou), which does the same magic for Pi. Same idea, same gateway, different host. Upstream is the blueprint; this repo is the amateur carpenter following it with slightly different tools. Go star the original. It is not a fork: it is a standalone package that ports the idea, with the upstream MIT notice preserved in [LICENSE](./LICENSE).

## Install

```bash
omp install npm:@nghialele/omp-ts-aperture
```

Then:

```bash
omp
> /aperture:settings
```

The settings wizard holds your hand through: gateway URL (with a health check), which capabilities you want, which gateway providers to include, which local providers to reroute, and whether to register the gateway's MCP tools.

## The two flavors

### 🎯 Dedicated provider (the default, and the easy one)

omp gets a shiny new provider called `aperture`. Its model list is pulled from your gateway's `/v1/models`, cached, and refreshed like any other omp discovery provider. Models look like:

```
aperture/openai/gpt-5
aperture/anthropic/claude-sonnet-5
aperture/google/gemini-3-pro
```

Yes, two slashes. The first is omp's provider, the second is the gateway's routing id. The gateway knows what to do. We don't ask questions.

What's under the hood:

- **The gateway's own prices and token limits win**, because they describe the actual endpoint your request hits. A reseller capping a model at 200k context means your request gets capped at 200k, not the model's theoretical 1M.
- **Vision, reasoning, thinking levels, and names** get looked up in omp's registry, then [models.dev](https://models.dev), then some tasteful defaults.
- **`/v1/systemone` models become `judge` models**, because they are judges. They do not get invited to the chat. They judge.

### 🔀 Proxy existing providers (for the cautious)

Already happy with omp's `anthropic` provider and don't want to learn a new path? Reroute it:

```
omp's "anthropic" provider  ──►  your Aperture gateway  ──►  Anthropic
```

Model ids stay bare (`claude-sonnet-5`, not `aperture/anthropic/claude-sonnet-5`), so your existing sessions, model picker, and muscle memory all survive. The qualified id is added on the wire, where only HTTP headers live and nobody has to look at it.

Config knob per provider, for the people who like knobs:

| `gatewayId` | Route to a *different* gateway provider than the local one. `anthropic` → `anthropic-oauth`, if that's your thing. |

### 🧰 MCP tools (so your AI can use GitHub, allegedly well)

Flip one switch and `/aperture:settings` writes this into `~/.omp/agent/mcp.json`:

```json
{
  "mcpServers": {
    "aperture": { "url": "http://ai.pango-lin.ts.net/v1/mcp", "type": "http" }
  }
}
```

omp then owns the connection, `/mcp` management, and per-tool exposure. Tools show up as `mcp__aperture__whatever`. If you already wrote your own `aperture` entry in `mcp.json`, we leave it alone. We are guests here.

MCP changes take effect next session. That's omp's rule, not ours.

## Commands you can type

| Command | What it does |
|---|---|
| `/aperture:settings` | The whole wizard: connection, capabilities, providers, MCP |
| `/aperture:proxy` | Straight to the proxy config, skipping the small talk |

## How the sausage is made

If you're here for the architecture tour:

```
omp
 │
 ├── extension: extensions/aperture/index.ts
 │      ├─ registers provider "aperture" (apiKey: "-", fetchDynamicModels)
 │      ├─ proxy mode: re-registers routed providers
 │      └─ lifecycle: sync on session_start, cleanup on shutdown
 │
 ├── custom apis: src/provider/apis.ts
 │      aperture-openai-completions ─┐
 │      aperture-anthropic-messages ─┤
 │      aperture-google-generative-ai┼──► rewrite api, call stream()
 │      aperture-openai-responses ───┤
 │      ...                          ┘
 │
 ├── catalog: src/provider/catalog.ts   gateway /v1/models → omp rows
 ├── proxy:   src/provider/proxy.ts     which local providers, which api
 ├── config:  src/config/*              ~/.omp/agent/aperture.json + migrations
 └── judge:   src/provider/system-one.ts  kinds of "judge" and nothing else
```

Three details worth knowing:

1. **`apiKey: "-"`** is not a bug. Aperture injects the real credential. A config-sourced key also outranks stored OAuth, so a routed provider stops sending its own key instead of leaking it to the gateway.
2. **One omp api per upstream transport.** omp dispatches on `model.api`, and Aperture is a gateway, not a protocol. So Gemini says `aperture-google-generative-ai` and lands at `/v1beta`, Bedrock says `aperture-bedrock-converse-stream` and lands at `/bedrock`, and everyone goes home happy.
3. **Judges post to `{gateway}/v1/systemone`**, which means the judge row's base URL is the gateway *root*. Not `/v1`. Do not ask how long that bug lived.

## Configuration

Lives in `~/.omp/agent/aperture.json`. Global only, because your tailnet is not project-specific and neither is this.

```jsonc
{
  "baseUrl": "http://ai.pango-lin.ts.net",
  "onboardingDone": true,
  "shouldSendProvenanceHeaders": true,
  "dedicated": { "enabled": true, "providers": [] },
  "proxy": { "enabled": false, "upstreamProviders": [] },
  "mcp": { "enabled": false }
}
```

Environment variable `APERTURE_BASE_URL` overrides `baseUrl` at runtime and is never written back to disk. Because sometimes you need to point at the dev gateway and sometimes you don't.

Existing Pi config? The migration chain from upstream is ported over. It will helpfully fix up your ancient `mode: "proxy"` config and your `connectors` block. You're welcome.

## Developing

```bash
bun test          # 114 tests, no Rust addon required
bun run typecheck # tsc against a host checkout (see README-DEV.md)
```

Both need `@oh-my-pi/*` to resolve. [README-DEV.md](./README-DEV.md) has the
one-time `git clone` + `ln -s` dance.

The test preload (`test-support/preload.ts`) serves a synthetic
`@oh-my-pi/pi-natives` so the suite runs on a checkout that has never seen
`cargo`. Inside a real omp binary the real package is used. Magic, but boring
magic.

## What's different from the Pi version

Because someone will ask:

| Pi extension | This omp port |
|---|---|
| `pi.registerProvider(native Provider)` | `fetchDynamicModels` (discovery-backed) |
| `pi-ai/compat` stream delegation | custom `aperture-*` apis through `stream()` |
| Classifier models (`classify`) | `judge` role models on omp's `typesafe` wire |
| `before_provider_headers` hook | headers stamped per request by the adapters |
| Tabbed TUI settings | `/aperture:settings` dialogs |
| `pi.registerMcpServer` | an `mcp.json` entry, omp-managed |
| `~/.pi/agent/models.json` | omp's registry + models.dev |

## License

**WTFPL** — Do What The Fuck You Want To Public License.

```text
0. You just DO WHAT THE FUCK YOU WANT TO.
```

Portions are derived from [`@aliou/pi-ts-aperture`](https://github.com/aliou/pi-ts-aperture) (MIT, Copyright (c) Aliou). Those portions remain under MIT, whose notice is reproduced in [LICENSE](./LICENSE). The rest is yours to do absolutely anything with.

## Not affiliated

Not affiliated with Tailscale, omp, or Aliou. Just a person with a tailnet and a dream.

If this breaks, open an issue. If it works, also open an issue so I can feel something.
