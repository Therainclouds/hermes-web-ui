#!/usr/bin/env node
/**
 * Execute a single phase of the update reconciliation plan.
 *
 * Usage:
 *   node scripts/execute-reconciliation-phase.mjs init <N>
 *       Verify the working tree is clean, fetch origin/main, and create
 *       (or check out) the branch `phase<N>-reconciliation` based on
 *       origin/main.
 *
 *   node scripts/execute-reconciliation-phase.mjs report <N>
 *       Print the Steps section of the corresponding spec so the agent
 *       has a checklist of what to do in this turn.
 *
 *   node scripts/execute-reconciliation-phase.mjs verify <N>
 *       Run the verification commands listed in the spec's Done Criteria.
 *       Exits 0 only if every command exits 0.
 *
 *   node scripts/execute-reconciliation-phase.mjs commit <N> <message...>
 *       git add -A && git commit -m "phase<N>(reconciliation): <message>"
 *
 * The script intentionally does NOT parse the spec into machine actions.
 * The Steps are still executed by the agent in the same turn. The
 * scaffold enforces: clean tree, correct branch, verification gate, and
 * a consistent commit prefix.
 */

import { existsSync, readFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'

const root = process.cwd()
const specDir = path.join(root, '.zcode', 'plans')

function die(message) {
  process.stderr.write(`error: ${message}\n`)
  process.exit(1)
}

function run(cmd, args, options = {}) {
  return execFileSync(cmd, args, {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    ...options,
  })
}

function git(args) {
  try {
    return run('git', args).trim()
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString() : ''
    die(`git ${args.join(' ')} failed:\n${stderr}`)
  }
}

function specPath(phase) {
  return path.join(specDir, `update-reconciliation-phase${phase}.md`)
}

function readSpec(phase) {
  const p = specPath(phase)
  if (!existsSync(p)) die(`spec not found: ${p}`)
  return readFileSync(p, 'utf8')
}

function extractSteps(spec) {
  // Steps live under "## Steps" until the next "## " heading.
  const start = spec.indexOf('## Steps')
  if (start < 0) return []
  const after = spec.slice(start + '## Steps'.length)
  const next = after.indexOf('\n## ')
  const section = next < 0 ? after : after.slice(0, next)
  const lines = section.split('\n')
  const steps = []
  let current = null
  for (const line of lines) {
    const m = line.match(/^###\s+(Step\s+\d+\.\d+\s+—\s+.+)$/)
    if (m) {
      if (current) steps.push(current)
      current = { title: m[1].trim(), body: [] }
    } else if (current) {
      current.body.push(line)
    }
  }
  if (current) steps.push(current)
  return steps
}

function extractDoneCriteria(spec) {
  const start = spec.indexOf('## Done Criteria')
  if (start < 0) return []
  const after = spec.slice(start + '## Done Criteria'.length)
  const next = after.indexOf('\n## ')
  const section = next < 0 ? after : after.slice(0, next)
  // Lines starting with `- ` are bullets. We expect command-form bullets
  // like "`npm run harness:check`" or "command name exits 0".
  const bullets = []
  for (const line of section.split('\n')) {
    const m = line.match(/^\s*-\s+(.+)$/)
    if (m) bullets.push(m[1].trim())
  }
  return bullets
}

function parseArgs(argv) {
  if (argv.length < 1) die('usage: execute-reconciliation-phase <init|report|verify|commit> <N> [args...]')
  const [command, phaseRaw, ...rest] = argv
  if (!/^[1-5]$/.test(phaseRaw)) die(`phase must be 1-5, got: ${phaseRaw}`)
  return { command, phase: Number(phaseRaw), rest }
}

function ensureCleanTree() {
  const status = git(['status', '--short'])
  if (status.length > 0) {
    die(`working tree is not clean:\n${status}`)
  }
}

function cmdInit(phase) {
  ensureCleanTree()
  const branch = `phase${phase}-reconciliation`
  // Make sure origin/main exists locally.
  try {
    git(['rev-parse', '--verify', 'origin/main'])
  } catch {
    git(['fetch', 'origin', '--prune'])
  }
  // Check if the branch already exists locally.
  let exists = false
  try {
    git(['rev-parse', '--verify', branch])
    exists = true
  } catch {
    exists = false
  }
  if (exists) {
    git(['checkout', branch])
  } else {
    git(['checkout', '-b', branch, 'origin/main'])
  }
  process.stdout.write(`On branch ${branch} (based on origin/main).\n`)
  process.stdout.write(`Spec: .zcode/plans/update-reconciliation-phase${phase}.md\n\n`)
  const steps = extractSteps(readSpec(phase))
  if (steps.length === 0) {
    process.stdout.write('No Steps section found in the spec; nothing to do.\n')
  } else {
    process.stdout.write('Steps for this phase:\n')
    for (const step of steps) {
      process.stdout.write(`  - ${step.title}\n`)
    }
    process.stdout.write('\nUse `report <N>` to print the full Step bodies.\n')
  }
}

function cmdReport(phase) {
  const steps = extractSteps(readSpec(phase))
  if (steps.length === 0) die('no Steps found in spec')
  for (const step of steps) {
    process.stdout.write(`### ${step.title}\n`)
    process.stdout.write(step.body.join('\n').trim() + '\n\n')
  }
}

function isCommandLine(text) {
  // Heuristic: starts with a backtick, "npm ", "node ", or backticked cmd.
  return /^`?[a-zA-Z][\w-]*\s/.test(text) || /`[^`]+`/.test(text)
}

function extractVerifyCommands(phase) {
  const criteria = extractDoneCriteria(readSpec(phase))
  // Map a small set of known prefixes to actual shell invocations.
  const commands = []
  for (const c of criteria) {
    if (c.startsWith('`npm run')) {
      const m = c.match(/`([^`]+)`/)
      if (m) commands.push({ source: c, run: ['npm', 'run', ...m[1].replace(/^npm run /, '').split(/\s+/)] })
    } else if (c.startsWith('`bash ')) {
      const m = c.match(/`([^`]+)`/)
      if (m) commands.push({ source: c, run: ['bash', '-c', m[1].replace(/^bash /, '')] })
    }
    // Anything else is informational; we don't auto-run it.
  }
  return commands
}

function cmdVerify(phase) {
  const commands = extractVerifyCommands(phase)
  if (commands.length === 0) {
    process.stderr.write('warning: no machine-runnable commands found in Done Criteria.\n')
    process.stderr.write('         the spec may use prose criteria only; that is fine.\n')
    process.exit(0)
  }
  let failed = 0
  for (const { source, run } of commands) {
    process.stdout.write(`\n> ${source}\n`)
    const result = spawnSync(run[0], run.slice(1), {
      cwd: root,
      stdio: 'inherit',
    })
    if (result.status !== 0) {
      process.stderr.write(`FAILED: ${source}\n`)
      failed += 1
    }
  }
  if (failed > 0) {
    process.stderr.write(`\n${failed} verification command(s) failed.\n`)
    process.exit(1)
  }
  process.stdout.write('\nAll runnable Done Criteria passed.\n')
}

function cmdCommit(phase, messageParts) {
  if (messageParts.length === 0) die('commit requires a message')
  const message = `phase${phase}(reconciliation): ${messageParts.join(' ')}`
  const branch = `phase${phase}-reconciliation`
  // Confirm we're on the right branch.
  const current = git(['rev-parse', '--abbrev-ref', 'HEAD'])
  if (current !== branch) die(`must be on ${branch}, currently on ${current}`)
  git(['add', '-A'])
  const staged = git(['status', '--short'])
  if (staged.length === 0) die('nothing to commit (working tree clean after add)')
  git(['commit', '-m', message])
  process.stdout.write(`committed on ${branch}.\n`)
}

const { command, phase, rest } = parseArgs(process.argv.slice(2))
switch (command) {
  case 'init':
    cmdInit(phase)
    break
  case 'report':
    cmdReport(phase)
    break
  case 'verify':
    cmdVerify(phase)
    break
  case 'commit':
    cmdCommit(phase, rest)
    break
  default:
    die(`unknown command: ${command}`)
}