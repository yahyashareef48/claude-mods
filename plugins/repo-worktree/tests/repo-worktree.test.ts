import { expect, test } from 'claude-code/testing'

const paneProps = { title: 'Repos', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} } as any

type Git = { calls: string[][]; store: Record<string, unknown>; opened: number; behind?: number; ahead?: number; pullFails?: boolean }

// A fake host: one repo at /proj with a linked worktree at /proj/.wt/feature,
// another local branch, and a store kept in memory.
function stubEngine(on: any, g: Git) {
  on('session.start' as any, () => ({ cwd: '/proj' }))
  on('session.cwd', () => ({ value: '/proj/src' }))
  for (const ev of ['command.register', 'ui.close']) on(ev as any, () => ({ value: undefined }))
  on('ui.toast' as any, () => ({ value: undefined }))
  on('ui.open' as any, () => { g.opened++; return { value: { isPlaced: true } } })
  on('clock.every' as any, () => ({ deny: 'no timers in tests' }))
  on('store.get' as any, (_: any, e: any) => ({ value: g.store[e.key] }))
  on('store.set' as any, (_: any, e: any) => { g.store[e.key] = e.value; return { value: undefined } })
  on('process.run' as any, (_: any, e: any) => {
    const argv: string[] = [...e.argv]
    g.calls.push(argv)
    const cwd = e.init?.cwd ?? '/proj'
    const out = (stdout: string, exitCode = 0, stderr = '') => ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } })
    if (argv[0] !== 'git') return out('')
    const cmd = argv.slice(1).join(' ')
    if (cwd.startsWith('/tmp')) return out('', 128, 'fatal: not a git repository')
    if (cmd === 'rev-parse --show-toplevel') return out('/proj\n')
    if (cmd === 'worktree list --porcelain') return out('worktree /proj\nHEAD abc\nbranch refs/heads/main\n\nworktree /proj/.wt/feature\nHEAD def\nbranch refs/heads/feature\n\n')
    if (cmd === 'status --porcelain=v2 --branch') {
      if (cwd === '/proj') return out(`# branch.oid abc\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +${g.ahead ?? 0} -${g.behind ?? 2}\n1 .M N... 100644 100644 100644 a b src/app.js\n? notes.txt\n`)
      return out('# branch.oid def\n# branch.head feature\n')
    }
    if (cmd === 'diff --numstat HEAD') return out(cwd === '/proj' ? '3\t1\tsrc/app.js\n' : '')
    if (cmd.startsWith('for-each-ref')) return out('main\torigin/main\tbehind 2\nfeature\t\t\nold\torigin/old\tgone\n')
    if (cmd.startsWith('fetch')) return out('')
    if (cmd === 'pull --ff-only') return g.pullFails ? out('', 128, 'fatal: Not possible to fast-forward, aborting.') : out('Updating abc..123\n')
    if (cmd.startsWith('push')) return out('')
    if (cmd === 'remote') return out('origin\n')
    return out('')
  })
}

async function start($: any) {
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true } as any)
}

const mount = ($: any) => $.ui.mount({ plugin: 'repo-worktree', surface: 'desktop', component: 'Pane', requestId: 'repo-worktree', props: paneProps })
const ran = (g: Git, words: string) => g.calls.some((c) => c.join(' ').includes(words))

test('/watch adds the repo, saves it, and the pane shows worktrees, behind counts and branches', { timeoutMs: 20_000 }, async ($, on) => {
  const g: Git = { calls: [], store: {}, opened: 0 }
  stubEngine(on, g)
  await start($)
  const r: any = await $.command.run({ command: 'watch', args: '', origin: { kind: 'person' }, presentation: { isFullscreen: false, columns: 100 } } as any)
  expect(r.text).toContain('watching proj')
  expect(g.store.repos).toEqual(['/proj'])
  expect(g.store.paneOpen).toBe(true)
  expect(ran(g, 'fetch --all --prune')).toBe(true)
  const ui = await mount($)
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('### Repos')
  expect(drawn).toContain('▸ main')
  expect(drawn).toContain('↓2 behind')
  expect(drawn).toContain('2 changes')
  expect(drawn).toContain('▸ feature')
  expect(drawn).toContain('worktree · .wt/feature')
  expect(drawn).toContain('Other branches')
  expect(drawn).toContain('upstream gone')
  expect(drawn).not.toContain('"main"\\t')
  await ui.press({ key: 'branch:/proj' })
  expect(JSON.stringify(await ui.drawn())).toContain('src/app.js')
  await ui.unmount()
})

test('after a restart the saved repos and the open pane come back', { timeoutMs: 20_000 }, async ($, on) => {
  const g: Git = { calls: [], store: { repos: ['/proj'], paneOpen: true }, opened: 0 }
  stubEngine(on, g)
  await start($)
  expect(g.opened).toBe(1)
  const ui = await mount($)
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('"proj"')
  expect(drawn).toContain('1 repo')
  await ui.unmount()
})

test('Sync on a diverged branch stops and says so, without pushing', { timeoutMs: 20_000 }, async ($, on) => {
  const g: Git = { calls: [], store: { repos: ['/proj'] }, opened: 0, ahead: 1, behind: 2, pullFails: true }
  stubEngine(on, g)
  await start($)
  await $.command.run({ command: 'repos', args: '', origin: { kind: 'person' }, presentation: { isFullscreen: false, columns: 100 } } as any)
  const ui = await mount($)
  await ui.drawn()
  await ui.press({ key: 'sync:/proj' })
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('Diverged from origin/main (1 ahead, 2 behind)')
  expect(ran(g, 'push')).toBe(false)
  await ui.unmount()
})

test('a double press on the repo name opens it in VS Code', { timeoutMs: 20_000 }, async ($, on) => {
  const g: Git = { calls: [], store: { repos: ['/proj'] }, opened: 0 }
  stubEngine(on, g)
  await start($)
  await $.command.run({ command: 'repos', args: '', origin: { kind: 'person' }, presentation: { isFullscreen: false, columns: 100 } } as any)
  const ui = await mount($)
  await ui.drawn()
  await ui.press({ key: 'open:/proj' })
  expect(g.calls.some((c) => c[0] === 'code')).toBe(false)
  await ui.press({ key: 'open:/proj' })
  expect(g.calls.some((c) => c[0] === 'code' && c[1] === '/proj')).toBe(true)
  await ui.unmount()
})

test('a folder outside any repo is refused with a reason', { timeoutMs: 20_000 }, async ($, on) => {
  const g: Git = { calls: [], store: {}, opened: 0 }
  stubEngine(on, g)
  await start($)
  const r: any = await $.command.run({ command: 'watch', args: '/tmp/nothing', origin: { kind: 'person' }, presentation: { isFullscreen: false, columns: 100 } } as any)
  expect(r.text).toContain('Not a git repository: /tmp/nothing')
  expect(g.store.repos).toBeUndefined()
})
