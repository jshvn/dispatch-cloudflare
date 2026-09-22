// What this scheduler starts, and when. One file per GitHub repo, named for the half of
// "owner/name" after the slash; this file is the list of them, and the table of slots each
// one registers its workflows in.
//
// Before adding a workflow to any of them, confirm all three. Nothing here can check them,
// and a workflow that fails any of them is dispatched into silence:
//
//   1. It declares `workflow_dispatch:` in `on:`.
//   2. It declares a `concurrency` group with `cancel-in-progress: false`, so a dispatch
//      arriving during a run queues instead of doubling up. GitHub keeps exactly one
//      pending run per group.
//   3. The workload pings its own healthcheck. This repo never learns whether a run passed,
//      so a workload without one is unmonitored.
//
// These workflows carry no `schedule:` of their own, so this directory is the only clock
// they have. A slot lost here is a run that does not happen, and the workload's own
// healthcheck is what says so.
//
// The imports below are the whole registry: Workers bundling is static, so there is no glob
// and a file this list omits never runs. test/schedules.test.ts reads the directory and
// asserts the two match, both ways.
//
// They carry the .ts extension because `task crons` and `task targets` import this file
// with node's own resolver, which does not guess one. tsconfig.json allows it.

import terraform from "./terraform.ts"

/**
 * The firing times, each a Cloudflare cron trigger of its own. The expressions are UTC; the
 * names are Pacific, exact in winter and an hour early in summer. The dailies sit at :17
 * and the hourly at :42, so no two slots share a minute and none is on the hour, which
 * GitHub sheds first.
 *
 * One expression per slot rather than one four-hour daily: five is the free plan's whole
 * budget, but a trigger Cloudflare drops then takes one slot's targets with it and not every
 * daily's. Only a slot some workflow registers in becomes a trigger. Changing an expression
 * here is a trigger change -- `task crons`, then up to 15 minutes before it fires.
 */
export const SLOTS = {
  hourly: "42 * * * *",
  /** 03:17 PST */
  overnight: "17 11 * * *",
  /** 09:17 PST */
  morning: "17 17 * * *",
  /** 15:17 PST */
  afternoon: "17 23 * * *",
  /** 21:17 PST */
  evening: "17 5 * * *",
} as const

export type Slot = keyof typeof SLOTS

export type Workflow = {
  /** workflow file name, e.g. "sync.yml" */
  workflow: string
  /** where it runs; one is usual, a second is a second pass in the day. Never none. */
  slots: readonly [Slot, ...Slot[]]
  /**
   * git ref to run on. Omitted means `main` -- the dispatch names a ref rather than
   * asking GitHub for the repo's own default, so a repo whose default branch is
   * anything else has to say so here or every dispatch 404s.
   */
  ref?: string
  inputs?: Record<string, string>
}

/** One repo's file: what a `schedules/<name>.ts` default-exports. */
export type Repo = {
  /** "owner/name" */
  repo: string
  workflows: readonly Workflow[]
}

/** One workflow in one slot -- everything a single dispatch needs, keyed by the cron. */
export type Target = Omit<Workflow, "slots"> & { repo: string; cron: string }

// Annotated here rather than in each repo file, so a leaf stays plain data with no import
// of its own. A leaf ends in `as const`, which is what keeps its slot names narrow enough to
// check against SLOTS; a typo in one, or a leaf without it, fails to compile on this line.
const REPOS: readonly Repo[] = [terraform]

export const TARGETS: readonly Target[] = REPOS.flatMap((r) =>
  r.workflows.flatMap(({ slots, ...w }) =>
    slots.map((slot) => ({ repo: r.repo, cron: SLOTS[slot], ...w })),
  ),
)

/**
 * The cron expressions wrangler.jsonc must carry, which `task crons` writes there. Deduped,
 * because targets share slots; and sorted, so reordering the registry above does not
 * rewrite generated JSON.
 */
export const crons = (targets: readonly Target[] = TARGETS): string[] =>
  [...new Set(targets.map((t) => t.cron))].sort()

/** Targets claiming this cron expression. More than one may share an expression. */
export const selectTargets = (cron: string, targets: readonly Target[] = TARGETS): Target[] =>
  targets.filter((t) => t.cron === cron)
