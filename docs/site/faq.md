# FAQ

**Why not `storageState`?** It works for one role and one machine. The file is plaintext cookies (Playwright's docs
warn it "could be used to impersonate you"), producing it needs a password in the test environment, it goes stale
(the Monday-morning failure), and nothing about it gives you one account per worker, several roles in one test, or a
server-side record of who minted what. credless keeps `storage-state-file` as a session provider for apps that have
nothing else yet, and documents it as the weaker option.

**Why a broker? Why not just an environment variable the test reads?** Because the test code is what the agent
writes and reads, and an environment variable is in every worker, every child process and every trace of a
`process.env` dump. With the broker the key exists in one process, moves as a file that is read once and deleted, and
the workers hold a per-run token that opens seven contract routes on one origin and nothing else. A self-test (B01)
reads every worker's environment to prove it.

**Is credless a sandbox?** No. It is not a security boundary, and it says so in the README, in SECURITY.md and in
the skill. The boundaries are the broker process and the locks on your server. The guard, the proxy, the scrub, the
lint gate and the deny rules are defence in depth that an agent with shell access could in principle edit, which is
why each has a self-test and `credless doctor --security` reports which are active. Run the agent in whatever OS
sandbox you trust; the kit inherits it.

**Why can the Node worker still reach the network in native mode?** Because a per-browser CONNECT proxy covers
browsers, not Node. v0.1 adds a lint gate that keeps network modules and bare `fetch` out of test code and an advisory
shim that routes Node's `fetch` and sockets through the policy; v0.2's `run --isolate` puts the whole run in a network
namespace whose only route is the egress proxy. Until then the threat model says "not isolated" and so does `doctor`.

**Why does a leaked secret fail the run even though it was scrubbed?** Because the scrub is a safety net, and a
value reaching the evidence means a code path leaked it. The kept evidence is clean; the exit code is 1 so somebody
fixes the path.

**Why does the demo refuse `--target prod`?** It refuses every production host, by config, before DNS, and the
backend should answer 404 at the ingress anyway. There is no flag to allow it.

**Does the scan read screenshots?** No. Regexes cannot read images and we do not claim they can. Screens that show a
code are masked by selector and by the list of codes in play; an OCR pass may come later as advisory only.

**Can I use it without implementing the test API?** Partly: the `storage-state-file` session provider, the guard,
the egress proxy and the evidence pipeline work without it. Personas as real accounts, one-call scenarios and
server-minted sessions need the seven routes; the brief and the reference server make that an afternoon on most
stacks, and the Clerk and Supabase providers (v0.3) will cover two hosted stacks without a backend route.

**Why Apache-2.0?** Patent grant, trademark clause, the license Playwright itself uses. The name "credless" is the
project's; forks rename.

**"cred" also means credibility. Is the name a joke?** It names the property the way "passwordless" does: the
credential is outside the trust boundary of the agent, the test code and the evidence. If you read it as "no
credibility", we hear you; the leak-vector suite and the published threat model are the answer, and we will keep the
name unless it measurably hurts.
