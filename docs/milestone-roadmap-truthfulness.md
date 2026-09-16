# Milestone — Roadmap and status truthfulness

Written for: anyone maintaining the public surfaces, and anyone who has to
believe what they say.

This change adds no capability. It makes the public product status tell the
truth, gives that status one place to live, and makes a silent class of test
failure impossible. No intelligence, score, engine, API contract or schema is
touched; there is no migration.

---

## 1. What was wrong

The public roadmap disagreed with the repository, and disagreed with itself.

```text
apps/web/src/lib/site.ts  primaryNav         Market Intelligence  LIVE
apps/web/src/lib/site.ts  siteRail           Market Intelligence  LIVE
apps/web/src/lib/site.ts  roadmapGroups      Market Intelligence  NEXT
home-sections.tsx         landing            Market Intelligence  IN DEVELOPMENT
landing-sections.tsx      unused draft       Market Intelligence  NEXT
```

The repository says it is live: `/markets`, `/app/markets`,
`GET /v1/markets`, `GET /v1/markets/:asset`, `POST /v1/markets/:asset/ask`,
`ENABLE_MARKETS` default `true`, and `tests/e2e-d10.ts` behind it. So three of
those four statements were false, and the fourth was a coincidence.

Two shipped products were missing entirely: Wallet Context (D8) and Ask AEGIX
(D9). And the whitepaper's own "source of truth" table asserted things the code
contradicts:

```text
whitepaper §2   Markets — IN DEVELOPMENT
whitepaper §4   "Four directions, none implemented."
                "No market data provider is integrated and no engine exists."
whitepaper §6   AEGIX AI — PLANNED, "no provider is integrated"
```

Neither claim survived contact with `packages/markets` or
`packages/ai/src/providers/openai-compatible.ts`.

The reason it went unnoticed is the real finding: the status lists were written
by hand in four files, and **no test compared them**. Nothing failed.

---

## 2. What was built

### 2.1 One place a status is written down

`products` in `apps/web/src/lib/site.ts` is now the only declaration of a
product's status. Everything that presents status derives from it:

```text
roadmapGroups        →  /roadmap, and the landing roadmap panel
categoryProducts     →  the landing category strip
productLineProducts  →  the landing product line
statusGroups(...)    →  the /privacy status list
productNav(...)      →  the primary nav and the persistent rail badges
```

The group a product lands in is a function of its status, not a second list:
`LIVE → SHIPPED`, `IN DEVELOPMENT → NEXT`, `PLANNED | RESEARCH → LATER`.
`CURRENT` holds workstreams (public launch, documentation, infrastructure),
which are not products and are asserted to be none.

A product carries `surfaces` instead of appearing in a per-page list, so
"where does this show up" is answered once, next to the product.

### 2.2 The honest corrections

```text
Market Intelligence   NEXT → SHIPPED, with the shipped scope stated as BTC,
                      ETH and SOL price and volume over a bounded hourly
                      window. The landing product line no longer claims that
                      narrative radar, anomaly detection and a cross-market
                      signal engine ship with it.
Wallet Context (D8)   listed for the first time; /app/context, GET
                      /v1/wallets/:address/context
Ask AEGIX (D9)        listed for the first time, qualified: embedded in Wallet
                      Context and Markets with no route of its own, and
                      provider-gated — without LLM_API_KEY the route reports
                      MISSING_CREDENTIAL rather than answering
Cross-Market          joins NEXT, which previously listed four items of which
Intelligence          one was already live
```

A product that has not been built now carries **no `href` at all**, so a
planned capability cannot render a link that would 404. That is asserted, not
merely intended.

Per-item qualifiers — a shipped capability that is gated, or one whose input
does not exist — are rendered beside the item on `/roadmap`. Those sentences
are the ones a bare status cannot carry:

```text
Population Commonality  activates only when the observed population passes the
                        sufficiency gate; the flag alone never enables it
Anomaly Detection       depends on a licensed historical data source that the
                        repository does not yet have
Wallet Reputation       no labelled reputation dataset exists; only the
                        evidence-verification infrastructure is built
Market Intelligence     BTC, ETH and SOL only; sector, ETF, narrative and
                        cross-market analysis are not built
```

### 2.3 Documentation reconciled

`docs/whitepaper.md` §2, §4, §6 and §10 and `docs/production-readiness.md`
were corrected against the code. §10 no longer claims to be the source of
truth — it now names `apps/web/src/lib/site.ts` as the machine-checkable one
and mirrors it, the same relationship the whitepaper already claimed for the
website.

---

## 3. Defects found and fixed

Every one of these was found by running the thing, not by reading it.

**A test that could not fail.** The drift survived because nothing compared the
surfaces. `apps/web/src/lib/site.test.ts` now pins the invariants, including
the exact defect — no group outside SHIPPED may claim a live product — plus:
every roadmap item names a real product and appears in exactly one group, a
live product must have an entry point, an unbuilt one must not, and every
navigation badge equals the status of the product it names.

**It could not have been caught end to end either.** `test:web-restored`
renders the real production build and asserts on real HTML, but it was never
wired into CI — only `test:web-routing` was. It now runs in the
`static-build` job, with a `/roadmap` row and the shipped/next assertion.

**The first version of that assertion was wrong.** It failed on first contact
with real rendered HTML on the verification host, and the page was right: a
bare `includes("Market Intelligence")` also matches `Cross-Market
Intelligence`, which belongs under NEXT. It now anchors on the item boundary
and also asserts the positive case, so an emptied NEXT column cannot pass by
being empty. Recorded here because the failure was in the test, not the code,
and saying so is the point.

**Twenty-five test scripts silently ran zero tests on Windows.** The globs
were single-quoted:

```json
"test": "node --import tsx --test 'src/**/*.test.ts'"
```

`cmd.exe` does not strip single quotes, so node received a literal quoted
string, matched nothing, and exited 0. The suite reported success while running
nothing. Double quotes are stripped by both `cmd` and `sh`, so node expands the
glob on either. Applied to the root `tests/helpers/*.test.ts`, `apps/web`, and
seventeen packages.

Measured on this machine:

```text
before this milestone      204 tests   (5 of 24 runs executed anything)
after fixing root + web    232
after fixing the 17        564   ← 23 suites now execute, 0 failures
```

`564` is also the arithmetic check: the record below said `557`, and this
milestone adds the 7 new status assertions. The two agree, which is how the
documented figure was corroborated rather than assumed.

**A dead duplicate.** `components/layout/landing-sections.tsx` was imported by
nothing and held a fourth copy of the status lists. It was kept for one
release so its content could stop contradicting the code, then deleted
(559 lines, 14 sections). Two images it referenced
(`aegix-intelligence-infrastructure.jpg`, `aegix-market-structure.jpg`) are
left in place — deleting assets is a separate decision.
`aegix-wallet-intelligence.jpg` stays, because `app/layout.tsx` uses it as the
OpenGraph image.

---

## 4. Verified

Local, this machine:

```text
pnpm test                        PASS  564 / 564, 0 failures, 24 suites
pnpm --filter @aegix/web typecheck  PASS
pnpm --filter @aegix/web test      PASS  23 / 23
```

`projecteon-v2`, from a fresh tree of `b72527b` extracted from a tarball (the
host has no repository credentials), isolated port, production stack untouched:

```text
install --frozen-lockfile        PASS
typecheck / lint                 PASS
build (packages, apps, web)      PASS
unit tests                       PASS
test:web-routing                 PASS
test:web-restored                PASS   after the assertion fix
render inspection                PASS   /, /privacy, /markets, /roadmap
```

The render inspection is the part that matters here: it read the actual text of
the rendered `/roadmap` and confirmed the groups in order — SHIPPED with Market
Intelligence, Wallet Context and Ask AEGIX among them, NEXT with the four
unbuilt market directions, and each qualifier under its item.

CI, both PRs and `main` afterwards: 8/8 jobs green (typecheck/lint/build,
unit, PostgreSQL+Redis integration, golden, three E2E suites, Docker images).

This milestone changes no schema and no migration, so the usual clean-state
flow (schema reset → migrate → end-to-end) and the load/correlation harnesses
are not applicable and were not run; `test:migrations` remains at 14 and the
integration job stayed green.

---

## 5. Still open

```text
annotation convention   `products.note` is rendered on /roadmap and as a
                        `title` on the landing panel. If a status ever needs
                        the same qualifier on /privacy, that surface needs the
                        same rendering
two unused images       left in place deliberately, see §3
whitepaper §7-§9        reputation, $AEX and multi-chain status paragraphs
                        were already accurate and were not touched
```

Nothing about `PR-11` changes: credentials still need rotating, infrastructure
still needs provisioning, and nothing is deployed. This milestone is not a step
towards deployment and must not be presented as one.
