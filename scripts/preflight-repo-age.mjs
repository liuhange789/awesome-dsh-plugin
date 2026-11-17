#!/usr/bin/env node
/**
 * Preflight for the catalog's submission gate — run BEFORE opening the pull
 * request, so the four failure classes the gate reports stop arriving by mail.
 *
 * Why this exists: on 2026-11-16 six entries were opened as six pull requests
 * and all six came back failed, each with the same five annotations. The only
 * substantive one was the repository-age bar:
 *
 *   liuhange789/dsh-cost-preflight     run 43815244751  70s  PR #15785
 *   liuhange789/dsh-gov-doc-router     run 43820780576  51s  PR #15799
 *   liuhange789/dsh-clinic-intake      run 43838747689  49s  PR #15859
 *   liuhange789/dsh-contract-redline   run 43839944986  64s  PR #15861
 *   liuhange789/dsh-sop-runner         run 43871156548  62s  PR #15915
 *   liuhange789/dsh-patient-education  run 43883777311  41s  PR #15944
 *
 *   "repository is 0.0 days old (needs 1) — nothing to do: this check re-runs
 *    by itself and should clear in about 24h."
 *
 * Nothing in those entry files was wrong; the repositories were hours old. The
 * gate re-runs itself (`regate.yml`) and clears them, but only after six
 * notifications have already been sent. So the age bar belongs in preflight.
 *
 * What it checks (the classes seen in the same gate stream, not just ours):
 *   1. entry YAML parses            -> gate: "unparsable entry file(s)"
 *   2. at most MAX_ENTRIES_PER_PR   -> gate: "N entries in one PR (limit 3)"
 *   3. repository exists, not archived
 *   4. repository age >= MIN_AGE_DAYS (1 day) -> gate: "repository is X days old"
 *
 * Usage:
 *   node scripts/preflight-repo-age.mjs data/plugins/owner__repo.yml [more.yml ...]
 *   node scripts/preflight-repo-age.mjs liuhange789/dsh-cost-preflight
 *   node scripts/preflight-repo-age.mjs --at 2026-11-17T10:00:00Z <same args>
 *   node scripts/preflight-repo-age.mjs --json <same args>
 *
 * Cost: one GitHub API request per unique repository; no requests for the YAML
 * and count checks. Six entries take about 3 s. Repository metadata is public,
 * so no token is needed; GITHUB_TOKEN is used when present (rate limits only).
 * Unknown means blocked: a lookup that fails is reported as UNVERIFIED and
 * exits 1, never as a pass.
 */
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import * as yaml from 'js-yaml'

const MIN_AGE_DAYS = 1
const MAX_ENTRIES_PER_PR = Number(process.env.MAX_ENTRIES_PER_PR ?? 3)
const DAY_MS = 86400000

function parseArgs(argv) {
  const entries = []
  let at = new Date()
  let json = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') json = true
    else if (a === '--at') {
      const v = argv[++i]
      const d = new Date(v)
      if (Number.isNaN(d.getTime())) throw new Error(`--at is not a date: ${v}`)
      at = d
    } else if (a.startsWith('--')) throw new Error(`unknown flag: ${a}`)
    else entries.push(a)
  }
  return { entries, at, json }
}

const isRepoRef = (a) => /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(a)

/** `owner/repo` from an entry file, or from a bare `owner/repo` argument. */
function parseTarget(arg) {
  if (isRepoRef(arg)) return { repo: arg }
  let text
  try {
    text = readFileSync(arg, 'utf8').replace(/^\uFEFF/, '')
  } catch {
    return { problem: `${arg}: not an entry file and not an owner/repo — nothing was checked` }
  }
  let doc
  try {
    doc = yaml.load(text)
  } catch (err) {
    return { problem: `${basename(arg)}: entry yaml does not parse — ${String(err.message).split('\n')[0]}` }
  }
  const url = typeof doc?.url === 'string' ? doc.url : ''
  const name = typeof doc?.name === 'string' ? doc.name : ''
  const m =
    url.match(/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)/) ??
    name.match(/^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/)
  if (!m) return { problem: `${basename(arg)}: no url:/name: pointing at github.com/owner/repo` }
  return { repo: `${m[1]}/${m[2]}` }
}

async function repoAge(repo, at) {
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'awesome-dsh-plugin-preflight' }
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  const res = await fetch(`https://api.github.com/repos/${repo}`, { headers })
  if (!res.ok) return { ok: false, status: res.status, why: `repo lookup failed (HTTP ${res.status})` }
  const body = await res.json()
  if (body.archived) return { ok: false, status: 200, why: 'repository is archived' }
  const createdAt = new Date(body.created_at)
  const ageDays = (at.getTime() - createdAt.getTime()) / DAY_MS
  const clearsAt = new Date(createdAt.getTime() + MIN_AGE_DAYS * DAY_MS)
  return { ok: ageDays >= MIN_AGE_DAYS, status: 200, ageDays, clearsAt }
}

async function main() {
  const { entries, at, json } = parseArgs(process.argv.slice(2))
  if (!entries.length) {
    console.error('usage: node scripts/preflight-repo-age.mjs [--at ISO] [--json] <entry.yml|owner/repo>...')
    process.exitCode = 2
    return
  }

  const problems = []
  const fileCount = entries.filter((a) => !isRepoRef(a)).length
  if (fileCount > MAX_ENTRIES_PER_PR) {
    problems.push(`this submission lists ${fileCount} entry files; the gate allows ${MAX_ENTRIES_PER_PR} per PR — split it`)
  }

  const targets = new Set()
  for (const arg of entries) {
    const t = parseTarget(arg)
    if (t.problem) problems.push(t.problem)
    else targets.add(t.repo)
  }

  const results = []
  for (const repo of targets) {
    let r
    try {
      r = await repoAge(repo, at)
    } catch (err) {
      r = { ok: false, status: 0, why: `repo lookup failed — ${err.message}` }
    }
    results.push({ repo, ...r })
  }

  const failed = problems.length > 0 || results.some((r) => !r.ok)

  if (json) {
    console.log(JSON.stringify({
      at: at.toISOString(),
      problems,
      results: results.map((r) => ({
        repo: r.repo,
        verdict: r.ok ? 'pass' : Number.isFinite(r.ageDays) ? 'blocked' : 'unverified',
        ageDays: Number.isFinite(r.ageDays) ? r.ageDays.toFixed(2) : null,
        clearsAt: r.clearsAt ? r.clearsAt.toISOString() : null,
        why: r.why ?? null,
      })),
    }, null, 2))
  } else {
    console.log(`preflight @ ${at.toISOString()} — age bar: ${MIN_AGE_DAYS} day(s), max ${MAX_ENTRIES_PER_PR} entries/PR`)
    for (const p of problems) console.log(`  FAIL    ${p}`)
    const pad = Math.max(...results.map((r) => r.repo.length), 4)
    for (const r of results) {
      if (typeof r.ok === 'boolean' && Number.isFinite(r.ageDays)) {
        const tag = r.ok ? 'PASS' : 'BLOCKED'
        const clear = r.ok ? '' : ` — clears ${r.clearsAt.toISOString()}`
        console.log(`  ${tag.padEnd(7)} ${r.repo.padEnd(pad)}  age ${r.ageDays.toFixed(2)} d${clear}`)
      } else {
        console.log(`  ${'UNVERIFIED'.padEnd(7)} ${r.repo.padEnd(pad)}  ${r.why}`)
      }
    }
    const blocked = results.filter((r) => !r.ok).length
    console.log(`\n${results.length - blocked}/${results.length} repos pass, ${blocked} blocked, ${problems.length} file problem(s)`)
    console.log(failed ? 'VERDICT: do not open the pull request yet' : 'VERDICT: safe to open the pull request')
  }
  process.exitCode = failed ? 1 : 0
}

main().catch((err) => {
  console.error(`preflight aborted: ${err.message}`)
  process.exitCode = 1
})
