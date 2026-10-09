import { expect, test } from 'claude-code/testing'

const paneProps = { title: 'Repos', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} } as any

type Git = { calls: string[][]; store: Record<string, unknown>; opened: number; behind?: number; ahead?: number; pullFails?: boolean; pruneFails?: boolean; envs?: any[] }

const dir = (name: string, mtimeMs = 0) => ({ name, kind: 'dir', size: 0, mtimeMs, isLink: false })
const file = (name: string) => ({ name, kind: 'file', size: 1, mtimeMs: 0, isLink: false })

// A fake computer. The chat's folder /proj is a repo (with a linked worktree);
// the home folder holds alpha (found by the walk), beta (known from
// ~/.claude.json), and a repo under AppData the walk must skip.
const FS: Record<string, any[]> = {
  '/proj': [dir('.git'), dir('src'), file('README.md')],
  '/proj/src': [file('app.js')],
  '/home/me': [dir('Projects'), dir('AppData'), dir('.cache'), file('.claude.json')],
  '/home/me/Projects': [dir('alpha'), dir('notes')],
  '/home/me/Projects/alpha': [dir('.git', 5), file('index.js')],
  '/home/me/Projects/notes': [file('todo.md')],
  '/home/me/AppData': [dir('hidden-repo')],
  '/home/me/AppData/hidden-repo': [dir('.git')],
}
const CLAUDE_JSON = JSON.stringify({ projects: { '/home/me/Projects/beta': {}, '/proj': {}, '/home/me/Projects/notes': {} } })
const REPOS = ['/proj', '/home/me/Projects/alpha', '/home/me/Projects/beta']
// The host hands file calls absolute, native paths (C:\proj on Windows).
const p = (path: string) => path.replace(/^[A-Za-z]:/, '').replace(/\\/g, '/')

function stubEngine(on: any, g: Git) {
  on('session.start' as any, () => ({ cwd: '/proj' }))
  on('session.cwd', () => ({ value: '/proj/src' }))
  for (const ev of ['command.register', 'ui.close', 'ui.toast']) on(ev as any, () => ({ value: undefined }))
  on('ui.open' as any, () => { g.opened++; return { value: { isPlaced: true } } })
  on('clock.every' as any, () => ({ deny: 'no timers in tests' }))
  on('store.get' as any, (_: any, e: any) => ({ value: g.store[e.key] }))
  on('store.set' as any, (_: any, e: any) => { g.store[e.key] = e.value; return { value: undefined } })
  on('env.get' as any, (_: any, e: any) => ({ value: e.name === 'HOME' ? '/home/me' : undefined }))
  on('fs.list' as any, (_: any, e: any) => (FS[p(e.path)] ? { value: FS[p(e.path)] } : { deny: 'ENOENT' }))
  on('fs.read' as any, (_: any, e: any) => (p(e.path) === '/home/me/.claude.json' ? { value: CLAUDE_JSON } : { deny: 'ENOENT' }))
  on('fs.stat' as any, (_: any, e: any) => (p(e.path) === '/home/me/Projects/beta/.git' || p(e.path) === '/proj/.git'
    ? { value: { kind: 'dir', size: 0, mtimeMs: 9, isLink: false } } : { deny: 'ENOENT' }))
  on('fs.exists' as any, () => ({ value: false }))
  on('process.run' as any, (_: any, e: any) => {
    const argv: string[] = [...e.argv]
    g.calls.push(argv)
    g.envs?.push(e.init?.env)
    const cwd: string = e.init?.cwd ?? '/proj'
    const out = (stdout: string, exitCode = 0, stderr = '') => ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } })
    if (argv[0] !== 'git') return out('')
    const cmd = argv.slice(1).join(' ')
    const repo = REPOS.find((r) => cwd === r || cwd.startsWith(r + '/'))
    if (!repo) return out('', 128, 'fatal: not a git repository')
    if (cmd === 'rev-parse --show-toplevel') return out(repo + '\n')
    if (cmd === 'worktree list --porcelain') {
      if (repo !== '/proj') return out(`worktree ${repo}\nHEAD abc\nbranch refs/heads/main\n\n`)
      return out('worktree /proj\nHEAD abc\nbranch refs/heads/main\n\nworktree /proj/.wt/feature\nHEAD def\nbranch refs/heads/feature\n\n')
    }
    if (cmd === 'status --porcelain=v2 --branch') {
      if (cwd === '/proj') return out(`# branch.oid abc\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +${g.ahead ?? 0} -${g.behind ?? 2}\n1 .M N... 100644 100644 100644 a b src/app.js\n? notes.txt\n`)
      return out('# branch.oid def\n# branch.head main\n')
    }
    if (cmd === 'diff --numstat HEAD') return out(cwd === '/proj' ? '3\t1\tsrc/app.js\n' : '')
    if (cmd.startsWith('for-each-ref')) return out(repo === '/proj' ? 'main\torigin/main\tbehind 2\nfeature\t\t\nold\torigin/old\tgone\n' : 'main\t\t\n')
    if (cmd === 'pull --ff-only') return g.pullFails ? out('', 128, 'fatal: Not possible to fast-forward, aborting.') : out('Updating abc..123\n')
    if (cmd === 'fetch --all --prune --quiet' && g.pruneFails) return out('', 1, "error: could not delete references: cannot lock ref 'refs/remotes/origin/x\"y': Invalid argument")
    if (cmd === 'remote') return out('origin\n')
    return out('')
  })
}

const settle = async (done: () => boolean) => { for (let i = 0; i < 200 && !done(); i++) await new Promise((r) => setTimeout(r, 5)) }
const run = ($: any, command: string, args = '') => $.command.run({ command, args, origin: { kind: 'person' }, presentation: { isFullscreen: false, columns: 100 } } as any)
const mount = ($: any) => $.ui.mount({ plugin: 'repo-worktree', surface: 'desktop', component: 'Pane', requestId: 'repo-worktree', props: paneProps })
const ran = (g: Git, words: string) => g.calls.some((c) => c.join(' ').includes(words))
const found = (g: Git) => (g.store.discovered as any)?.repos?.map((r: any) => r.path) as string[] | undefined

test('the repos in the chat\'s folder are watched on their own, and the pane shows worktrees and branches', { timeoutMs: 20_000 }, async ($, on) => {
  const g: Git = { calls: [], store: {}, opened: 0 }
  stubEngine(on, g)
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true } as any)
  await settle(() => !!found(g))
  expect(g.store.repos).toEqual(['/proj'])
  expect(ran(g, 'fetch --all --prune')).toBe(true)
  const r: any = await run($, 'watch')
  expect(r.text).toContain('already watched')
  const ui = await mount($)
  const drawn = JSON.stringify(await ui.drawn())
  // The repo row: the branch pill, behind count, changes, and the one
  // action that fits (behind, nothing ahead: Pull).
  expect(drawn).toContain('⎇ main')
  expect(drawn).toContain('↓2')
  expect(drawn).toContain('● 2')
  expect(drawn).toContain('"pull:/proj"')
  expect(drawn).toContain('1 worktree')
  // The worktree, nested, with no upstream: Publish.
  expect(drawn).toContain('⎇ feature')
  expect(drawn).toContain('"push:/proj/.wt/feature"')
  expect(drawn).toContain('Publish')
  // Clutter that is gone.
  expect(drawn).not.toContain('Other branches')
  expect(drawn).not.toContain('main worktree')
  expect(drawn).not.toContain('src/app.js')
  await ui.press({ key: 'files:/proj' })
  expect(JSON.stringify(await ui.drawn())).toContain('src/app.js')
  await ui.unmount()
})

test('git runs with long paths on and never prompts', { timeoutMs: 20_000 }, async ($, on) => {
  const g: Git = { calls: [], store: { discovered: { at: Date.now(), repos: [] } }, opened: 0, envs: [] }
  stubEngine(on, g)
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true } as any)
  await settle(() => ran(g, 'fetch'))
  expect(g.envs!.length > 0).toBe(true)
  expect(g.envs![0]).toMatchObject({ GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_KEY_0: 'core.longpaths', GIT_CONFIG_VALUE_0: 'true' })
})

test('every other repo on the computer is offered in one menu, and picking one watches it', { timeoutMs: 20_000 }, async ($, on) => {
  const g: Git = { calls: [], store: {}, opened: 0 }
  stubEngine(on, g)
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true } as any)
  await settle(() => !!found(g))
  // Folders Claude Code worked in come first; the walk's finds after them.
  expect([...found(g)!].sort()).toEqual(['/home/me/Projects/alpha', '/home/me/Projects/beta', '/proj'])
  expect(found(g)!.at(-1)).toBe('/home/me/Projects/alpha')
  await run($, 'repos')
  const ui = await mount($)
  const tree: any = await ui.drawn()
  const findKey = (n: any, key: string): any => n?.props?.key === key ? n : (n?.children ?? []).map((c: any) => findKey(c, key)).find(Boolean)
  const menu = findKey(tree, 'add')
  expect(menu.type).toBe('Select')
  const values = menu.props.options.map((o: any) => o.value)
  expect(values).toEqual(['', '/home/me/Projects/beta', '/home/me/Projects/alpha', '__rescan__'])
  expect(menu.props.options[0].label).toBe('Add repo (2)')
  expect(menu.props.options[2].label).toBe('alpha  ·  Projects')
  const drawn = JSON.stringify(tree)
  expect(drawn).not.toContain('hidden-repo')
  expect(drawn).not.toContain('Watch repos in this folder')
  await ui.select({ key: 'add', value: '/home/me/Projects/alpha' } as any)
  await settle(() => (g.store.repos as string[]).length === 2)
  expect(g.store.repos).toEqual(['/proj', '/home/me/Projects/alpha'])
  expect(JSON.stringify(await ui.drawn())).toContain('"alpha"')
  await ui.unmount()
})

test('an unwatched repo stays unwatched when the chat\'s folder is scanned again', { timeoutMs: 20_000 }, async ($, on) => {
  const g: Git = { calls: [], store: {}, opened: 0 }
  stubEngine(on, g)
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true } as any)
  await settle(() => !!found(g))
  await run($, 'repos')
  const ui = await mount($)
  await ui.drawn()
  await ui.press({ key: 'unwatch:/proj' })
  expect(g.store.repos).toEqual([])
  expect(g.store.dismissed).toEqual(['/proj'])
  await ui.unmount()
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true } as any)
  await new Promise((r) => setTimeout(r, 100))
  expect(g.store.repos).toEqual([])
  const r: any = await run($, 'watch')
  expect(r.text).toContain('watching proj')
  expect(g.store.dismissed).toEqual([])
})

test('after a restart the saved repos and the open pane come back', { timeoutMs: 20_000 }, async ($, on) => {
  const g: Git = { calls: [], store: { repos: ['/proj', '/home/me/Projects/beta'], paneOpen: true, discovered: { at: Date.now(), repos: [] } }, opened: 0 }
  stubEngine(on, g)
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true } as any)
  expect(g.opened).toBe(1)
  const ui = await mount($)
  await settle(() => ran(g, 'fetch'))
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('"proj"')
  expect(drawn).toContain('"beta"')
  expect(drawn).toContain('2 repos')
  await ui.unmount()
})

test('Sync on a diverged branch stops and says so, without pushing', { timeoutMs: 20_000 }, async ($, on) => {
  const g: Git = { calls: [], store: { repos: ['/proj'], discovered: { at: Date.now(), repos: [] } }, opened: 0, ahead: 1, behind: 2, pullFails: true }
  stubEngine(on, g)
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true } as any)
  await run($, 'repos')
  const ui = await mount($)
  await settle(() => ran(g, 'status'))
  await ui.drawn()
  await ui.press({ key: 'sync:/proj' })
  expect(JSON.stringify(await ui.drawn())).toContain('Diverged from origin/main (1 ahead, 2 behind)')
  expect(ran(g, 'push')).toBe(false)
  await ui.unmount()
})

test('a double press on the repo name opens it in VS Code', { timeoutMs: 20_000 }, async ($, on) => {
  const g: Git = { calls: [], store: { repos: ['/proj'], discovered: { at: Date.now(), repos: [] } }, opened: 0 }
  stubEngine(on, g)
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true } as any)
  await run($, 'repos')
  const ui = await mount($)
  await ui.drawn()
  await ui.press({ key: 'open:/proj' })
  expect(g.calls.some((c) => c[0] === 'code')).toBe(false)
  await ui.press({ key: 'open:/proj' })
  expect(g.calls.some((c) => c[0] === 'code' && c[1] === '/proj')).toBe(true)
  await ui.unmount()
})

test('a folder outside any repo is refused with a reason', { timeoutMs: 20_000 }, async ($, on) => {
  const g: Git = { calls: [], store: { discovered: { at: Date.now(), repos: [] } }, opened: 0 }
  stubEngine(on, g)
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true } as any)
  const r: any = await run($, 'watch', '/tmp/nothing')
  expect(r.text).toContain('Not a git repository: /tmp/nothing')
})

test('a prune the file system refuses falls back to a plain fetch, with no error shown', { timeoutMs: 20_000 }, async ($, on) => {
  const g: Git = { calls: [], store: { repos: ['/proj'], discovered: { at: Date.now(), repos: [] } }, opened: 0, pruneFails: true }
  stubEngine(on, g)
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true } as any)
  await run($, 'repos')
  const ui = await mount($)
  await settle(() => ran(g, 'fetch --all --quiet'))
  await new Promise((r) => setTimeout(r, 50))
  expect(JSON.stringify(await ui.drawn())).not.toContain('Fetch failed')
  await ui.unmount()
})

test('worktrees are chips of their own, the branch a pill, and the repo path is not shown', { timeoutMs: 20_000 }, async ($, on) => {
  const g: Git = { calls: [], store: { repos: ['/proj'], discovered: { at: Date.now(), repos: [] } }, opened: 0 }
  stubEngine(on, g)
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true } as any)
  await run($, 'repos')
  const ui = await mount($)
  await settle(() => ran(g, 'status'))
  const tree: any = await ui.drawn()
  const findKey = (n: any, key: string): any => n?.props?.key === key ? n : (n?.children ?? []).map((c: any) => findKey(c, key)).find(Boolean)
  const chip = findKey(tree, 'wt:/proj/.wt/feature')
  expect(chip.props.borderStyle).toBe('round')
  expect(findKey(tree, 'wt:/proj').props.borderStyle).toBeUndefined()
  const drawn = JSON.stringify(tree)
  expect(drawn).toContain('"backgroundColor":"rgba(88, 166, 255, 0.14)"')
  expect(drawn).not.toContain('"   /proj"')
  expect(drawn).not.toContain('└')
  // Every status dot has an alt (the desktop drops an image without one).
  expect(drawn).toContain('"alt":"Behind or changed"')
  expect(drawn).not.toContain('"alt":""')
  await ui.unmount()
})
