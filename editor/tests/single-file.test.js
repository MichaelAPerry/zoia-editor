import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { inflateSync } from 'node:zlib'

const editor = new URL('../', import.meta.url)

test('builds a self-contained editor with valid app and worklet scripts', async () => {
  execFileSync('python3', ['build_single.py'], { cwd: editor, stdio: 'inherit' })
  const html = readFileSync(new URL('dist/zoia-editor.html', editor), 'utf8')
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
  assert.equal(scripts.length, 1)
  const script = scripts[0][1]
  const markup = html.replace(script, '')
  for (const match of markup.matchAll(/\s(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    assert.match(match[1] ?? match[2] ?? match[3], /^(?:data:|#)/i)
  }
  assert.doesNotMatch(markup, /@import\b|\burl\s*\(/i)

  const worklet = JSON.parse(script.match(/^const embeddedWorklet = (.+);$/m)[1])
  for (const code of [script, worklet]) {
    assert.doesNotMatch(code, /\bimport\b[^;]*?\bfrom\s*['"]\./)
    assert.doesNotMatch(code, /\bfetch\s*\(|\bimport\.meta\b/)
    assert.doesNotThrow(() => new Function(code))
  }
  const processors = []
  runInNewContext(worklet, {
    AudioWorkletProcessor: class {},
    registerProcessor: (name, implementation) => processors.push([name, typeof implementation]),
  })
  assert.deepEqual(processors, [['zoia-simulator', 'function'], ['zoia-wav-capture', 'function']])

  const assets = JSON.parse(script.match(/^const embeddedAssets = (.+);$/m)[1])
  const unpack = name => inflateSync(Buffer.from(assets[name], 'base64'))
  const index = readFileSync(new URL('../corpus/INDEX.csv', editor))
  assert.deepEqual(unpack('INDEX.csv'), index)
  const helpers = script.split('\n// Editor modules\n')[0]
  const { readEmbeddedAsset, loadEmbeddedWorklet } = runInNewContext(
    helpers + 'return { readEmbeddedAsset, loadEmbeddedWorklet };\n})();',
    { atob, btoa, Blob, DecompressionStream, Response, TextEncoder, URL, console: { warn() {} } },
  )
  const response = await readEmbeddedAsset('INDEX.csv')
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), index)
  // Exercise the primary data URL and force a retry through the Blob fallback.
  await loadEmbeddedWorklet({
    audioWorklet: {
      async addModule(url) {
        assert.match(url, /^data:/)
        assert.equal(await (await fetch(url)).text(), worklet)
      },
    },
  })
  let workletURL
  await loadEmbeddedWorklet({
    audioWorklet: {
      async addModule(url) {
        if (url.startsWith('data:')) throw new Error('Data URL refused')
        workletURL = url
        assert.match(url, /^blob:/)
        assert.equal(await (await fetch(url)).text(), worklet)
      },
    },
  })
  await assert.rejects(fetch(workletURL))
  const manifest = JSON.parse(unpack('manifest.json'))
  for (const [directory, prefix] of [
    ['corpus/', 'corpus/'],
    ['out/', 'out/'],
    ['out/bench/to_zoia/', 'out/bench/to_zoia/'],
  ]) {
    const folder = new URL(`../${directory}`, editor)
    for (const filename of readdirSync(folder).filter(name => name.endsWith('.bin'))) {
      assert.deepEqual(unpack(prefix + filename), readFileSync(new URL(filename, folder)), prefix + filename)
    }
  }
  for (const { file } of manifest) assert.ok(Object.hasOwn(assets, 'out/' + file), file)
})
