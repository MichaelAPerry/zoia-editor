import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'

// Set CHROME to a Chromium binary. Audio is muted on purpose (--mute-audio).
const CHROME = process.env.CHROME ?? 'chromium'
const [,, htmlPath, shotDir, dlDir] = process.argv
mkdirSync(shotDir, { recursive: true }); rmSync(dlDir, { recursive: true, force: true }); mkdirSync(dlDir, { recursive: true })
const port = 9400 + Math.floor(Math.random() * 300)
const proc = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--mute-audio', '--hide-scrollbars',
  '--force-device-scale-factor=1', '--allow-file-access-from-files', `--remote-debugging-port=${port}`,
  `--user-data-dir=/tmp/chr-zoia-${port}`, 'about:blank'],
  { stdio: 'ignore' })
let ws
for (let i = 0; i < 100; i++) {
  try { const l = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); const pg = l.find(x => x.type === 'page'); if (pg) { ws = pg.webSocketDebuggerUrl; break } } catch {}
  await new Promise(r => setTimeout(r, 200))
}
const sock = new WebSocket(ws); await new Promise(r => sock.onopen = r)
let id = 0; const pend = {}; const errors = []
sock.onmessage = m => { const d = JSON.parse(m.data)
  if (d.id && pend[d.id]) { pend[d.id](d); delete pend[d.id] }
  else if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text)
  else if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') errors.push(d.params.args.map(a => a.value ?? a.description).join(' ')) }
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend[i] = d => d.error ? rej(new Error(JSON.stringify(d.error))) : res(d.result); sock.send(JSON.stringify({ id: i, method, params })) })
const sleep = ms => new Promise(r => setTimeout(r, ms))
const ev = async expr => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed: ' + expr); return r.result.value }
const results = []
const check = (name, ok, detail = '') => { results.push([name, ok]); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`) }
const shot = async name => { const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(`${shotDir}/${name}.png`, Buffer.from(r.data, 'base64')) }
const size = async (w, h = 1000) => send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false })
const fullShot = async name => { const h = await ev('document.documentElement.scrollHeight'); await size(await ev('innerWidth'), h); await sleep(150); await shot(name) }
const center = async sel => ev(`(()=>{const r=document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]})()`)
const click = async sel => { const [x, y] = await center(sel); await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }); await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }); await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }) }

await send('Page.enable'); await send('Runtime.enable')
await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir })
await send('Page.addScriptToEvaluateOnNewDocument', { source: 'localStorage.clear()' })
await size(1440)
await send('Page.navigate', { url: 'file://' + htmlPath }); await sleep(1500)

check('title', (await ev('document.title')) === 'Patch Editor for the ZOIA')
check('editor heading', (await ev('document.querySelector("h1").textContent')).trim() === 'Patch Editor for the ZOIA')
check('grid has 40 pads', (await ev('document.querySelectorAll("#grid .pad").length')) === 40)
check('OLED shows patch screen', (await ev('$=0;document.getElementById("oled").innerText')).includes('TEST THRU'))
await ev('document.getElementById("theme").value="dark";document.getElementById("theme").dispatchEvent(new Event("change"))')
await fullShot('01-start-dark-1440')

// theme toggle
const pedalBg = () => ev('getComputedStyle(document.querySelector(".pedal")).backgroundImage')
const bgDark = await ev('getComputedStyle(document.body).backgroundColor'); const pd = await pedalBg()
await ev('document.getElementById("theme").value="light";document.getElementById("theme").dispatchEvent(new Event("change"))'); await sleep(200)
const bgLight = await ev('getComputedStyle(document.body).backgroundColor')
check('theme toggle changes page, pedal stays black', bgDark !== bgLight && pd === await pedalBg() && (await ev('document.documentElement.dataset.theme')) === 'light', `${bgDark} -> ${bgLight}`)
await fullShot('01-start-light-1440')
await ev('document.getElementById("theme").value="dark";document.getElementById("theme").dispatchEvent(new Event("change"))')

// corpus load
await click('#browse'); await sleep(800)
await ev('(()=>{const s=document.getElementById("corpus-search");s.value="aetherverb";s.dispatchEvent(new Event("input"))})()'); await sleep(200)
await shot('03-corpus-dialog-dark-1440')
const picked = await ev('document.querySelector("#corpus-rows button").textContent')
await click('#corpus-rows button'); await sleep(1000)
const name = await ev('document.getElementById("patch-name").value')
check('corpus patch loaded', name.length > 0 && !(await ev('document.getElementById("corpus").open')), `${picked} -> ${name}`)
const status0 = await ev('document.getElementById("status").textContent')
const origFile = status0.replace('Opened ', '')
// Round-trip save before any edit
await ev('document.getElementById("save-bin").click()'); await sleep(800)
let files = readdirSync(dlDir).filter(f => f.endsWith('.bin'))
const orig = readFileSync(`${htmlPath.replace('/editor/dist/zoia-editor.html', '')}/corpus/${origFile}`)
check('save .bin of untouched corpus patch is byte-exact', files.length === 1 && readFileSync(`${dlDir}/${files[0]}`).equals(orig), `${origFile} -> ${files}`)
await fullShot('02-corpus-patch-dark-1440')

// select a pad with a knob
const padSel = await ev(`(()=>{for (const p of document.querySelectorAll("#grid .pad.occupied")) { if (!p.dataset.signal || p.dataset.signal.endsWith("_in") || p.dataset.signal==="param") {} } const pads=[...document.querySelectorAll("#grid .pad.occupied")]; const i=pads.findIndex(p=>/·/.test(p.title) && !/Audio (In|Out)/.test(p.title)); return pads[i]?'#grid .pad[data-position="'+pads[i].dataset.position+'"]':null})()`)
await click(padSel); await sleep(300)
const oled1 = await ev('document.getElementById("oled").innerText')
check('select module on grid shows param screen', await ev('document.querySelector(".is-lit")!==null') && oled1.length > 5, oled1.replace(/\n/g, ' | '))
const knobState = () => ev('({idle:document.getElementById("knob").classList.contains("idle"),raw:document.getElementById("knob").getAttribute("aria-valuenow"),oled:document.getElementById("oled").innerText})')
let k0 = await knobState()
if (k0.idle) {
  // try other occupied pads until one is a knob
  const positions = await ev('[...document.querySelectorAll("#grid .pad.occupied")].map(p=>p.dataset.position)')
  for (const p of positions) { await click(`#grid .pad[data-position="${p}"]`); await sleep(150); k0 = await knobState(); if (!k0.idle) break }
}
check('knob becomes active on a knob button', !k0.idle, JSON.stringify(k0.raw))
const [kx, ky] = await center('#knob')
await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: kx, y: ky, deltaX: 0, deltaY: -300 })
await sleep(100)
const k1 = await knobState()
check('knob wheel changes value (OLED + dial)', k1.raw !== k0.raw && k1.oled !== k0.oled, `${k0.raw} -> ${k1.raw}`)
await sleep(700)
const inspSlider = await ev('document.querySelector("#inspector input[type=range]")?.value')
check('knob commit reaches model/inspector, undo enabled', Number(inspSlider) === Number(k1.raw) && !(await ev('document.getElementById("undo").disabled')), `${inspSlider}`)
// drag knob
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: kx, y: ky })
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: kx, y: ky, button: 'left', clickCount: 1 })
for (let i = 1; i <= 10; i++) await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: kx, y: ky + i * 3, button: 'left' })
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: kx, y: ky + 30, button: 'left', clickCount: 1 })
await sleep(500)
const k2 = await knobState()
check('knob drag down lowers value', Number(k2.raw) < Number(k1.raw), `${k1.raw} -> ${k2.raw}`)
await ev('document.getElementById("knob").focus()')
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 }); await sleep(600)
const k3 = await knobState()
check('knob arrow key raises value', Number(k3.raw) > Number(k2.raw), `${k2.raw} -> ${k3.raw}`)
await fullShot('03-knob-edit-dark-1440')
// undo key
await click('#key-undo'); await sleep(300)
check('UNDO key reverts last knob edit', Number((await knobState()).raw) !== Number(k3.raw))

// pages
const pcount = await ev('document.querySelectorAll("#pages button").length')
await click('#key-page-right'); await sleep(200)
check('page keys', pcount < 2 || (await ev('document.querySelector("#pages [aria-current=page]").textContent')) !== null, `pages=${pcount}`)
await click('#key-back'); await sleep(200)
check('BACK key clears selection (patch screen)', (await ev('document.getElementById("oled").innerText')).toUpperCase().includes(name.toUpperCase().slice(0, 8)))

// play / stop
await click('#play'); await sleep(2500)
check('play: running, stop enabled, LEDs green', (await ev('document.getElementById("status").textContent')).includes('running') && !(await ev('document.getElementById("stop").disabled')) && await ev('document.getElementById("leds").classList.contains("engaged")'), await ev('document.getElementById("status").textContent'))
check('meters / DSP load readout', (await ev('document.getElementById("cpu").textContent')).includes('%') && (await ev('document.getElementById("oled-cpu").textContent')).includes('%'), await ev('document.getElementById("cpu").textContent'))
await fullShot('04-playing-dark-1440')
await click('#stop'); await sleep(300)
check('stop: LEDs red again', !(await ev('document.getElementById("leds").classList.contains("engaged")')) && !(await ev('document.getElementById("play").disabled')))

// new patch, place, cable
await click('#new'); await sleep(400)
async function place(search, pos) {
  await ev(`(()=>{const s=document.getElementById("module-search");s.value=${JSON.stringify(search)};s.dispatchEvent(new Event("input"))})()`); await sleep(150)
  await click('#palette .palette-item'); await sleep(100)
  await click(`#grid .pad[data-position="${pos}"]`); await sleep(250)
}
await place('Audio Input', 8); await place('Audio Output', 12)
await ev('(()=>{const s=document.getElementById("module-search");s.value="";s.dispatchEvent(new Event("input"))})()')
const mods = JSON.parse(await ev('localStorage.getItem("zoia-editor.patch.v1")')).modules.length
check('placement: two modules added', mods === 2, `modules=${mods}`)
// cable: click output glyph on first module then input pad of the second
const outPad = await ev('(()=>{const p=document.querySelector("#grid .pad[data-position=\\"8\\"] .port-out");return !!p})()')
await click('#grid .pad[data-position="8"] .port-out'); await sleep(200)
await shot('05-cable-armed-dark-1440')
await click('#grid .pad[data-position="12"] .port-in'); await sleep(300)
const cables = JSON.parse(await ev('localStorage.getItem("zoia-editor.patch.v1")')).connections?.length ?? 0
check('cabling: two modules connected by cable', cables >= 1 && outPad, `cables=${cables}`)
check('cable selection shown on OLED', (await ev('document.getElementById("oled").innerText')).includes('CONNECTION'), (await ev('document.getElementById("oled").innerText')).replace(/\n/g, ' | '))
await fullShot('05-cabled-dark-1440')
// save new patch .bin and verify decode
rmSync(dlDir, { recursive: true, force: true }); mkdirSync(dlDir)
await ev('document.getElementById("save-bin").click()'); await sleep(800)
files = readdirSync(dlDir).filter(f => f.endsWith('.bin'))
check('save .bin of built patch (32768 bytes)', files.length === 1 && readFileSync(`${dlDir}/${files[0]}`).length === 32768, files.join())
// autosave
check('autosave stores patch', (await ev('localStorage.getItem("zoia-editor.patch.v1")')).includes('Audio Input'))
// widths and themes
for (const [theme, w] of [['dark', 1440], ['light', 1440], ['dark', 800], ['light', 800]]) {
  await ev(`document.getElementById("theme").value=${JSON.stringify(theme)};document.getElementById("theme").dispatchEvent(new Event("change"))`)
  await size(w); await sleep(300); await fullShot(`06-built-${theme}-${w}`)
}
check('no uncaught page errors', errors.length === 0, errors.join(' ; '))
console.log(`${results.filter(r => r[1]).length}/${results.length} checks passed`)
proc.kill(); process.exit(results.every(r => r[1]) ? 0 : 1)
