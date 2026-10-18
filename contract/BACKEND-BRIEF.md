# The test API: what a backend builds

**For:** the backend team that gives a dev or staging environment the seven routes the kit needs. **Contract:**
[`core.openapi.yaml`](core.openapi.yaml) in this folder is the source of truth; the kit's client, the broker's
allowlist, the reference server and the demo app are checked against it (`pnpm contract:check`). Change the contract
first, in the same pull request as the client.

**Done when:**

1. `npx credless health --target dev` reports `enabled: true`, the right `environment`, and every sink `true`.
2. `npx credless run --target dev` with the example spec passes: every persona in the catalog opens signed in, the
   guard sees no error, the evidence is clean.
3. The locks test (below) fails the build when any lock is missing.
4. `curl -i https://<staging or prod origin>/_test/health` answers 404 at the edge, with no key and with a key.

Read first: the kit never signs in as a real person, never runs against production, and holds the runner key in one
broker process on the runner. The backend's job is to make the test API impossible to reach outside dev and staging,
and to make everything it does scoped to flagged synthetic accounts.

## Where

One package, module, engine or app, so the whole surface is in one place and easy to audit (a `testapi` package, a
Rails engine, a Django app, a Laravel service provider, a route-handler folder). Nothing of it is referenced from the
rest of the code except the login seam it calls.

## The five locks

The risk that matters most is a login shortcut reaching production. Laravel Dusk's `/_dusk/login/{id}` is registered
only outside production, and a third-party plugin shipped exactly that route in production anyway (CVE-2024-32003,
"may potentially be used to gain access to any user account"). Five independent locks, each tested, is the answer.

| # | Lock | Concretely |
|---|---|---|
| 1 | **A flag, default off; with the flag off the routes do not exist** | A setting such as `test-api.enabled` (env `TEST_API_ENABLED`), default `false`, set only by the dev and staging configuration. Everything in the package is conditional on it (a conditional bean, a route file included only when it is on, an engine mounted only when it is on). With the flag off there is no handler: the base path is a plain 404, not a 403 and not a "disabled" message. |
| 2 | **A boot guard that always loads** | A check that is not behind the flag and fails startup when the flag is on in a production or staging profile (active profile, deploy environment, hostname pattern: whatever the app already trusts for "where am I"). Staging too: staging holds real-looking data and real-looking URLs. |
| 3 | **The runner key, constant time, with rotation** | Header `X-Test-Runner-Key` (the name is configurable on both sides). Compare SHA-256 digests with a constant-time primitive against `TEST_API_RUNNER_KEY` and `TEST_API_RUNNER_KEY_NEXT`, so a rotation is: set `_NEXT`, switch the runner, move `_NEXT` to the key, clear `_NEXT`. Both come from the secret store, never from a file in the repo. No key configured means every route answers 401: the flag alone opens nothing. |
| 4 | **The test-account flag, plus the address pattern** | A column such as `is_test_account` (default false). Only `personas/ensure` sets it, and only for addresses matching the configured pattern (`TEST_API_ADDRESS_PATTERN`, for example `^qa\+[a-z0-9-]+@example\.com$`). Every route refuses (403) an account without the flag or an address outside the pattern, and never puts a non-test account into a test object (a workspace, a team, a tenant: whatever the app's unit is). |
| 5 | **No route outside dev at the edge** | The dev ingress, gateway or reverse proxy routes the base path; staging and production answer 404 for it at the edge, so even a misconfigured deployment has no way in. One alert rule: any request to the base path reaching staging or production ingress is a page-worthy event. |

**One test checks the locks** and the build fails without it: a boot without the flag has no handler for the base
path; the boot guard throws for a production and a staging profile with the flag on; a missing or wrong key gets
401 on every route; a non-test account gets 403 on every route; no production or staging configuration file sets the
flag.

## The seven routes

Base path `/_test` on the API origin (configurable; `targets.<t>.testApi` when another origin serves it). Every
route requires the key. Answers are plain JSON, no envelope. Refusals carry the HTTP status and
`{ "error": { "code", "message" } }`; the message never quotes a key, a cookie or a code. Handles are
`<namespace>.<persona>` (`a0.owner`): one account per handle. Epoch fields are seconds.

| operationId | Route | Request | Response |
|---|---|---|---|
| `health` | `GET /health` | – | `{ enabled: true, environment, keyId, version?, sinks: { mail, push, analytics, ... }, extensions: [operationIds] }`. `keyId` is the first 8 hex of SHA-256 of the presented key. A sink reports `true` only when it is really wired; the kit refuses a real run while any is `false`, so report honestly. |
| `ensurePersonas` | `POST /personas/ensure` | `{ personas: [{ handle, email, displayName, attributes }] }` (1–64) | `{ personas: [{ handle, userId, created }] }`. Create the accounts that do not exist: flagged, verified, complete (no onboarding-only state), no welcome mail, the attributes stored as the baseline. Leave existing ones. Idempotent. `attributes` carries `role`, `firstName`, `lastName`, `locale`, `timezone`, `countryCode?`, `auth` and the app's own keys. |
| `resetPersonas` | `POST /personas/reset` | `{ handles: [...] }` (1–64) | `{ reset: [{ handle, removed: { kind: n } }] }`. Put each account back to its baseline: remove or leave what a test could have created, clear its captured mail and notifications, restore the attributes. Idempotent. |
| `personaState` | `GET /personas/{handle}` | – | `{ handle, userId, state: {...} }`; `state` is the app's view (memberships, plan, flags). |
| `createSession` | `POST /session` | `{ handle, runId, client?: 'web' }` | `Set-Cookie` as the real login sends it (`HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age` ≤ 3600) plus `{ user: { userId, email, displayName }, expiresAt }`. The session value is never in the body. 429 over the rate limit. |
| `personaMessages` | `GET /personas/{handle}/messages?since&kind&limit` | – | `{ messages: [{ id, to, subject, sentAt, kind?, links, codes }] }`, newest first, from the mail sink. Links and one-time codes are parsed out of the body so a test never reads raw mail. |
| `cleanupRun` | `POST /runs/{runId}/cleanup` | `{ revokeSessions?: true }` | `{ removed: { kind: n }, sessionsRevoked }`. Remove everything tagged with the run id and revoke its sessions. Idempotent; a run with nothing left answers zeros. |

Status codes: 401 key missing or wrong; 403 not a test account or address outside the pattern; 404 flag off (route
absent) or unknown object; 409 conflict; 422 request does not match the contract; 429 session rate limit.

A persona with `auth: password` (one in a catalog, for the sign-in screen test) gets its password from the backend's
own secret store (`TEST_API_SIGNIN_PASSWORD`); no route returns or logs it, and without the variable such accounts get
no password and the sign-in test skips.

## Session minting: through the real login seam

`createSession` must produce exactly what a web login produces: the same cookie names, flags, domain and path, the
same server-side session record, so the app boots signed in with no storage touched and the kit's cookie handling
(`sessionCookies` in the config) matches. Do it by extracting the seam your login controller uses into one function
called by both; never by writing a session row by hand.

- **TTL at most one hour** (`Max-Age ≤ 3600`, `expiresAt` to match), shorter if the app allows it (20–30 minutes is
  comfortable for most suites; the kit will re-mint on expiry from v0.2).
- **Tag the session with `runId`** so `cleanupRun` can revoke every session the run minted.
- **No side effects a real login has for a person:** no login mail, push, analytics or audit event in the user's
  own history; the test API's audit line is the record.
- **Rate limit per key:** 120 sessions a minute is the default the contract names; answer 429 above it.
- If the app ends the previous session when a new one starts (single-session accounts), say so in `health.version`
  or the docs; the kit opens one browser per persona per worker and does not depend on either behaviour.

## Sinks

Each one, when wired, turns its `health.sinks` flag `true`:

- **Mail:** in the mail path, a message to a test account or to an address matching the pattern is written to a sink
  table (to, subject, template, body, created at) instead of being sent. `personaMessages` reads it, newest first,
  and parses links and codes.
- **Push:** notifications to test accounts are logged to a sink table, never sent to a device.
- **Analytics:** events from test accounts are skipped, or written with a test flag that every dashboard filters out.
- **Payments and other third parties:** test mode only (test clocks, sandbox accounts); never a live account.

A sink that is not wired reports `false`; the kit refuses a real run until all are `true`, so phase the work with
`health` telling the truth at every step.

## Audit, rate limits, tagging and cleanup

- **One audit line per call:** time, key id, route, handle, user id, run id, client IP, status. Never the key, a
  cookie or a code. Keep it where your other security logs live; it is what an auditor asks for (an export route is
  on the kit's roadmap).
- **Rate limit** valid keys (120 sessions a minute per key, 429 above) and **throttle failed keys** per IP with an
  alert on a burst of 401s.
- **Tag with `runId`** every object the test API creates on behalf of a run and every session it mints, so
  `cleanupRun` is a sweep by tag, scoped to test accounts, and never touches a real user's data. The kit's global
  teardown calls it; `run` calls it again when a run was killed.
- **Scope by namespace:** a reset or a cleanup for `a0.*` must not touch `a1.*` or `b0.*`; two agents and several
  workers run at once.

## Extension routes

An app adds its own routes under the same base path in its own OpenAPI file (the demo's
`apps/demo/contract/demo.openapi.yaml` adds workspaces, invites and documents), lists their operationIds in
`health.extensions`, and applies the same five locks, the same key, the same audit line and the same test-account
rule to each. Typical extensions: "create a workspace with these members and this many documents, return its id and
the invite code once", "expire this invite", "run this sweeper now, scoped to the run". On the kit's side the app's
`Control` class calls them and tracks what it created for teardown; a code returned once is wrapped as a secret and
masked in every screenshot.

## Reference implementation

A Node backend can mount `createTestApi()` from `credless/server`: it implements the seven routes, the key check,
the address pattern, the status codes and the audit hook, and takes the app's state as callbacks (`personas.ensure`,
`personas.reset`, `personas.state`, `session.mint`, `session.revoke`, `mail.list`, `cleanup`, `isTestAccount`). The
demo app (`apps/demo/src/test-api.ts`) wires it to an in-memory store in about 150 lines and is the complete,
runnable reference for every route and every status code. Locks 1, 2 and 5 stay the app's: `createTestApi()` is a
handler you mount only when the flag is on.

## Per-framework notes

Sketches, not recipes: each names the seam that gives lock 1 (routes absent), lock 2 (boot guard), the constant-time
compare, and the login seam for `createSession`. Details marked *(unverified)* come from memory of the framework and
need checking against your version; the demo app is the only implementation this repository runs.

**Spring Boot.** Put every bean of the package behind
`@ConditionalOnProperty(name = "test-api.enabled", havingValue = "true")` (controllers, services, the security
filter), so with the flag off no handler mapping exists. The boot guard is a plain `@Component` that is *not*
conditional and throws from `@PostConstruct` (or an `ApplicationListener<ApplicationEnvironmentPreparedEvent>`) when
the property is true and the active profiles include `prod` or `staging`. Compare keys with
`MessageDigest.isEqual` on SHA-256 digests in a `OncePerRequestFilter` registered for the base path only; keep the
base path out of the app's normal security chain except through that filter. Mint the session by calling the same
service the login controller calls, then the same cookie-writing helper with a one-hour max age; `@Transactional`
around `ensure` and `reset`. The locks test is a `@SpringBootTest` matrix: without the property, no mapping for the
base path; with the property and `spring.profiles.active=prod`, the context fails to start; a wrong key gets 401.

**Rails.** Package the routes as an engine or a controller namespace and mount them in `config/routes.rb` inside
`if Rails.application.config.x.test_api.enabled` (set to true only in `config/environments/development.rb` and the
staging environment file, from `ENV["TEST_API_ENABLED"]`). The boot guard is an initializer that raises when the flag
is on and `Rails.env.production?` (and your staging predicate). Compare keys with
`ActiveSupport::SecurityUtils.secure_compare` on digests in a `before_action`. For the session, the controller calls
the same method your sessions controller calls after a successful password check; with Devise that is `sign_in(user)`
from `Devise::Controllers::SignInOut` inside a real request, which sets the same session cookie a form login sets
*(unverified: that `sign_in` is available and behaves identically in an API-only controller; Warden's
`warden.set_user` is the lower-level seam)*. TTL: the cookie store's `expire_after` or Devise `timeoutable` is
app-wide; a per-request one-hour `Max-Age` may need the cookie written explicitly *(unverified)*. Rate limit with
`Rack::Attack` on the base path. The flag is a boolean column via a migration; `ensure` goes through your user
creation service, not `User.create!`.

**Django.** `force_login` is a test-client method and is not reachable over HTTP; the HTTP seam is
`django.contrib.auth.login(request, user)` inside a view, after the key check, which makes the session middleware set
the `sessionid` cookie on the response; call `request.session.set_expiry(3600)` for the one-hour TTL. Lock 1: include
the package's `urls.py` from the root URL conf only `if settings.TEST_API_ENABLED` (read from the environment, default
`False`, set only in the dev and staging settings modules), so with the flag off the base path resolves to nothing.
Lock 2: a system check (`django.core.checks.register`) or `AppConfig.ready()` that raises when the flag is on and
`DEBUG` is off or the settings module is the production one *(unverified: pick the predicate your deployment already
trusts)*. Compare keys with `hmac.compare_digest` on digests in a decorator or middleware scoped to the base path.
The flag is a boolean on the profile model; `ensure` goes through your user creation path so signals and
verification state match a real account. Rate limit with `django-ratelimit` or your gateway.

**Laravel.** Load `routes/testapi.php` from a dedicated service provider only when `config('testapi.enabled')`
(from `TEST_API_ENABLED`, default `false`, set only in the dev and staging environment files); in the provider's
`boot()`, throw when the flag is on and `app()->environment('production', 'staging')`. Learn from Dusk: tie the
routes to an explicit flag, not to "not production", and add the locks test so a deployment with the flag on in
production fails before it serves a request (the Dusk plugin CVE above is the case study). Compare keys with
`hash_equals` on digests in a middleware on the route group. Mint the session with `Auth::guard('web')->login($user)`
in the controller, which sets the same session cookie a form login sets *(unverified: session lifetime is
app-wide in `config/session.php`, in minutes; a per-request one-hour TTL may need the session configured per request
or accepted as the app's lifetime)*. Flag column via a migration; rate limit with `RateLimiter::for('testapi', ...)`
and the `throttle` middleware; audit to a dedicated log channel.

**Next.js (App Router).** File-based routing means the route handlers (`app/_test/[...route]/route.ts`) exist in
every build, so lock 1 lives inside the handler and in `middleware.ts`: answer 404 for the base path unless
`process.env.TEST_API_ENABLED === 'true'`, which is set only in the development and staging environment of the
hosting platform and never in production's. Lock 2: at module load, throw when the flag is on and the platform's
production indicator is set (`VERCEL_ENV === 'production'` on Vercel *(unverified)*, or your own `APP_ENV`). Compare
keys with `crypto.timingSafeEqual` on SHA-256 digests. The session seam depends on the auth library: with Auth.js,
there is no public "mint a session" API; the documented development pattern is a Credentials provider enabled only in
development, or writing the adapter's session row and setting the session cookie the way the library does
*(unverified: cookie name and secure prefix vary by version)*; with Supabase, sign in server-side with the service
role (`signInWithPassword` or `generateLink` plus `verifyOtp`) and set the cookies the way `@supabase/ssr` does
*(unverified)*; with Clerk, prefer the kit's session-provider adapter (testing tokens, v0.3) over a backend route.
`createTestApi()` from `credless/server` speaks Node's `IncomingMessage`/`ServerResponse`; a thin adapter from the
Web `Request`/`Response` is needed for route handlers and is not built yet.

## Out of scope here

The runner and its key handling (the kit), production and staging as targets (never), the persona catalog (the
product's decision, in `personas.yaml`), and the ingress change (your platform team, lock 5).
