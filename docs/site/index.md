# credless documentation

credless runs signed-in, multi-user Playwright end-to-end tests on dev or staging, written by you or by an AI
coding agent (Claude Code, Cursor, Codex), without the long-lived credential ever reaching the agent, the test code or
the evidence. Start with the [quickstart](quickstart.md).

| Page | What it answers |
|---|---|
| [Quickstart](quickstart.md) | The demo in 30 seconds, then your app in an afternoon |
| [Concepts](concepts.md) | Personas, namespaces, slots, the test API, the broker, the egress guard, evidence |
| [Configuration](configuration.md) | Every field of `credless.config.ts`, the persona catalog, the environment variables |
| [Adapters](adapters.md) | The five interfaces, the built-ins, the "good first adapter" list |
| [CLI](cli.md) | Every command and exit code |
| [Backend](backend.md) | What your backend builds: the seven routes behind five locks |
| [Evidence](evidence.md) | The folder, `SUMMARY.md`, the contact sheet, how to triage |
| [Agents](agents.md) | The skill, the Claude Code plugin, Cursor, `AGENTS.md`, and the rules the agent follows |
| [Security](security.md) | The short form of [SECURITY.md](../../SECURITY.md) |
| [FAQ](faq.md) | Why not `storageState`, why a broker, is it a sandbox (no), and the name |

The research and the technical design the kit was built from, as dated working documents:
[research](../research/), [technical plan](../plans/PLAN-TECH.md). Reference CI workflows for forks and for your own
repositories: [docs/ci](../ci/).
