# Security model in brief

The full text, kept current, is [SECURITY.md](../../SECURITY.md). This page is the map.

**The definition.** credless means the agent, the test code and the evidence run without the credential: no
long-lived key, password or service token is given to them; what they hold is a short-lived session for a synthetic
account, and we say exactly what that is.

**Not a boundary.** credless is not a security boundary. The boundaries are the broker process that holds the key
and the test API's locks on your server; everything else in the kit (the guard, the egress proxy, the scrub, the
deny rules, the lint gate) is defence in depth that an agent with shell access could in principle edit, which is why
the self-tests check each layer and `credless doctor --security` tells you which ones are active on this machine.

**Reporting.** Private, through
[GitHub Security Advisories](https://github.com/Prathyush-KKK/credless/security/advisories/new). Acknowledgement in
3 business days, triage in 7, coordinated disclosure in 90 days, credit by default, no bounty.

**Threat model.** Thirteen rows in SECURITY.md, each with the mitigation in v0.1, the gap and the planned fix. The
ones to know: the Node worker is not network-isolated in native mode (lint gate and advisory shim now; `--isolate`
in v0.2); the broker lives in Playwright's main process (own process in v0.2); WebKit WebRTC can send UDP around the
proxy (`--isolate` closes it); the CI key is an environment secret, masked not hidden (OIDC in v0.3); the scan cannot
read images; prompt injection through evidence can be bounded, not closed.

**Claims.** The safe list and the forbidden list are in SECURITY.md and apply to every README, post and reply.
Never "sandboxed", never "secrets never touch the agent" as an absolute, never "compliant".

**Data classes.** Key (broker only, never in evidence), broker token, session cookies, one-time codes, the one
sign-in password, persona identities (synthetic), application content, screenshots (masked; no OCR), traces (no
screencast; scrubbed inside zips), reports, logs and aria snapshots (scrubbed text, untrusted when an agent reads
it), `scan.json` and `QUARANTINED.md` (file and kind, never a value). Retention is yours.

**Compliance.** credless supports controls your auditors ask about; it does not make anything compliant. The
mapping to SOC 2 CC6/CC7/CC8 and ISO/IEC 27001:2022 Annex A is in SECURITY.md, phrased as "supports", never
"satisfies".

**Check your machine.** `npx credless doctor --security` prints `on`/`off` per layer (broker, egress proxy per
context, canary, lint gate, advisory worker shim, evidence pipeline, trace secrets, docker isolate) after the usual
checks (tools, staging permissions, key source by presence, the target probed without a key) and reads no secret.
