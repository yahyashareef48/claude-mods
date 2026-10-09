import { expect, test } from 'claude-code/testing'

const paneProps = { title: 'Replay', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } as any

const ok = (_: any, e: any) =>
  e.tool === 'Bash' ? { result: { stdout: 'Hello, world!', stderr: '', interrupted: false }, text: 'Hello, world!' } : { result: { content: 'ok' } }

function stubEngine(on: any, cwd: string, toolResult: ($: any, e: any) => any = ok) {
  on('session.start' as any, () => ({ cwd }))
  on('turn.start' as any, () => ({ turnId: 't1' }))
  on('turn.complete' as any, () => ({ text: '' }))
  for (const ev of ['command.register', 'ui.close']) on(ev as any, () => ({ value: undefined }))
  on('tool.call' as any, toolResult)
  on('ui.open' as any, () => ({ value: { isPlaced: true } }))
  on('clock.sleep' as any, () => ({ value: undefined }))
  on('session.cwd', () => ({ value: cwd }))
  on('fs.exists', () => ({ value: false }))
  on('fs.read', () => ({ value: 'welcome()\n' }))
}

async function openPane($: any) {
  await $.command.run({ command: 'replay', args: '', origin: { kind: 'person' }, presentation: { isFullscreen: false, columns: 80 } } as any)
  return $.ui.mount({ plugin: 'replay-theater', surface: 'desktop', component: 'Pane', requestId: 'replay-theater', props: paneProps })
}

async function turn($: any, cwd: string, calls: any[]) {
  await $.session.start({ cwd, surface: 'desktop', isInteractive: true } as any)
  await $.turn.start({ turnId: 't1' } as any)
  for (const c of calls) await $.tool.call(c)
  await $.turn.complete({ turnId: 't1', answer: 'done' } as any)
}

test('the desktop pane draws the summary, the timeline and the diff, and Next moves on', { timeoutMs: 20_000 }, async ($, on) => {
  stubEngine(on, '/proj')
  await turn($, '/proj', [
    { tool: 'Edit', file_path: '/proj/src/app.js', old_string: 'greet()', new_string: 'welcome()' },
    { tool: 'Write', file_path: '/proj/src/utils/format.js', content: 'export const shout = (t) => t.toUpperCase()\n' },
  ])
  const ui = await openPane($)
  const first = JSON.stringify(await ui.drawn())
  expect(first).toContain('### Last turn')
  expect(first).toContain('2 steps · 2 edits')
  expect(first).toContain('Step 1 of 2')
  expect(first).toContain('"Edit · src"')
  expect(first).toContain('@@ -1,1 +1,1 @@')
  expect(first).toContain('-greet()')
  expect(first).toContain('+welcome()')
  await ui.press({ key: 'next' })
  const second = JSON.stringify(await ui.drawn())
  expect(second).toContain('Step 2 of 2')
  expect(second).toContain('"New file · src/utils"')
  await ui.unmount()
})

test('commands are recorded with their output, and the filter narrows the list', { timeoutMs: 20_000 }, async ($, on) => {
  stubEngine(on, '/proj')
  await turn($, '/proj', [
    { tool: 'Bash', command: 'node src/app.js', description: 'Run the app' },
    { tool: 'Edit', file_path: '/proj/src/app.js', old_string: 'greet()', new_string: 'welcome()' },
  ])
  const ui = await openPane($)
  const first = JSON.stringify(await ui.drawn())
  expect(first).toContain('2 steps · 1 edit · 1 command')
  expect(first).toContain('Run the app')
  expect(first).toContain('"source":"node src/app.js"')
  expect(first).toContain('Hello, world!')
  await ui.press({ key: 'filter-edit' })
  const edits = JSON.stringify(await ui.drawn())
  expect(edits).toContain('Step 1 of 1')
  expect(edits).not.toContain('Run the app')
  await ui.unmount()
})

test('Windows paths are shown relative to the session folder', { timeoutMs: 20_000 }, async ($, on) => {
  stubEngine(on, 'C:\\Users\\me\\proj')
  await turn($, 'C:\\Users\\me\\proj', [{ tool: 'Edit', file_path: 'c:\\Users\\me\\proj\\src\\cli.js', old_string: 'a', new_string: 'b' }])
  const ui = await openPane($)
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('"cli.js"')
  expect(drawn).toContain('"Edit · src"')
  expect(drawn).not.toContain('Users')
  await ui.unmount()
})

test('a failed edit shows as failed, with no diffstat', { timeoutMs: 20_000 }, async ($, on) => {
  stubEngine(on, '/proj', (_: any, e: any) => (e.old_string === 'missing' ? { result: 'String not found', text: 'String not found', isError: true } : { result: { content: 'ok' } }))
  await turn($, '/proj', [{ tool: 'Edit', file_path: '/proj/a.js', old_string: 'missing', new_string: 'x' }])
  const ui = await openPane($)
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('Failed')
  expect(drawn).toContain("Didn't apply")
  expect(drawn).toContain('String not found')
  expect(drawn).not.toContain('lines added')
  await ui.unmount()
})

test('the band names the last turn in theme colors', { timeoutMs: 20_000 }, async ($, on) => {
  stubEngine(on, '/proj')
  await turn($, '/proj', [{ tool: 'Bash', command: 'ls', description: 'List files' }])
  const ui = await $.ui.mount({ plugin: 'replay-theater', surface: 'desktop', component: 'AbovePrompt', props: {} as any })
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('Last turn')
  expect(drawn).toContain('1 step · 1 command')
  expect(drawn).not.toContain('magenta')
  await ui.unmount()
})

test('the terminal pane steps through commands and edits', { timeoutMs: 20_000 }, async ($, on) => {
  stubEngine(on, '/proj')
  await turn($, '/proj', [
    { tool: 'Bash', command: 'node src/app.js', description: 'Run the app' },
    { tool: 'Edit', file_path: '/proj/src/app.js', old_string: 'greet()', new_string: 'welcome()' },
  ])
  await $.command.run({ command: 'replay', args: '', origin: { kind: 'person' }, presentation: { isFullscreen: true, columns: 160 } } as any)
  const ui = await $.ui.mount({ plugin: 'replay-theater', surface: 'terminal', component: 'Pane', requestId: 'replay-theater', props: paneProps })
  const first = JSON.stringify(await ui.drawn())
  expect(first).toContain('$ node src/app.js')
  expect(first).toContain('Hello, world!')
  await ui.press({ key: 'next' })
  expect(JSON.stringify(await ui.drawn())).toContain('+ welcome()')
  await ui.unmount()
})

test('the list shows five chips at a time, fading toward what is out of sight', { timeoutMs: 20_000 }, async ($, on) => {
  stubEngine(on, '/proj')
  await turn($, '/proj', Array.from({ length: 14 }, (_, n) => ({ tool: 'Bash', command: `echo ${n}`, description: `Step ${n}` })))
  const ui = await openPane($)
  const first = JSON.stringify(await ui.drawn())
  const chips = (s: string) => (s.match(/"key":"row\d+"/g) ?? []).length
  expect(chips(first)).toBe(5)
  expect(first).toContain('Step 0')
  expect(first).not.toContain('Step 5')
  expect(first).toContain('rgba(142, 142, 147, 0.08)')
  for (let n = 0; n < 12; n++) await ui.press({ key: 'next' })
  const later = JSON.stringify(await ui.drawn())
  expect(chips(later)).toBe(5)
  expect(later).toContain('Step 13 of 14')
  expect(later).toContain('Step 12')
  expect(later).not.toContain('"Step 0"')
  await ui.unmount()
})

test('the pane is live: a step shows as running while its call is in flight', { timeoutMs: 20_000 }, async ($, on) => {
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => { release = r })
  stubEngine(on, '/proj', async (_: any, e: any) => {
    if (e.command === 'sleep 1') await gate
    return { result: { stdout: 'done', stderr: '', interrupted: false }, text: 'done' }
  })
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true } as any)
  await $.turn.start({ turnId: 't1' } as any)
  await $.tool.call({ tool: 'Bash', command: 'ls', description: 'List files' } as any)
  const inFlight = $.tool.call({ tool: 'Bash', command: 'sleep 1', description: 'Wait a second' } as any)
  const ui = await openPane($)
  const live = JSON.stringify(await ui.drawn())
  expect(live).toContain('### This turn')
  expect(live).toContain('Live')
  expect(live).toContain('Wait a second')
  expect(live).toContain('Running')
  release()
  await inFlight
  await $.turn.complete({ turnId: 't1', answer: 'done' } as any)
  const done = JSON.stringify(await ui.drawn())
  expect(done).toContain('### Last turn')
  expect(done).not.toContain('Running')
  await ui.unmount()
})

test('Previous and Next sit in a row of their own, matched, with no key badges', { timeoutMs: 20_000 }, async ($, on) => {
  stubEngine(on, '/proj')
  await turn($, '/proj', [
    { tool: 'Bash', command: 'npm test', description: 'A very long description of a command that would once have pushed the buttons out of the card on license key' },
    { tool: 'Bash', command: 'ls', description: 'List' },
  ])
  const ui = await openPane($)
  const tree: any = await ui.drawn()
  const find = (n: any, key: string): any => n?.props?.key === key ? n : (n?.children ?? []).map((c: any) => find(c, key)).find(Boolean)
  const top = find(tree, 'card-top')
  expect(JSON.stringify(top)).toContain('Step 1 of 2')
  const prev = find(top, 'prev'), next = find(top, 'next')
  expect(prev.props.label).toBe('Previous')
  expect(next.props.label).toBe('Next')
  expect(prev.props.variant).toBe(next.props.variant)
  expect(prev.props.hotkey).toBeUndefined()
  expect(JSON.stringify(find(tree, 'card-head'))).not.toContain('"prev"')
  await ui.press({ key: 'next' })
  expect(JSON.stringify(await ui.drawn())).toContain('Step 2 of 2')
  await ui.unmount()
})
