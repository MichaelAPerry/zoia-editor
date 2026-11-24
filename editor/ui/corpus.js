import { parseCorpus } from './logic.js'
import { $, button, el } from './view.js'

const columns = [
  ['title', 'Title'], ['author', 'Author'], ['category', 'Category'],
  ['tags', 'Tags'], ['downloads', 'Downloads'],
]

async function fetchOk(path) {
  const response = await fetch(path)
  if (!response.ok) throw new Error(`Could not read ${path} (HTTP ${response.status})`)
  return response
}

export function initCorpus(openPatch) {
  const dialog = $('corpus')
  const search = $('corpus-search')
  const status = $('corpus-status')
  const head = el('tr')
  $('corpus-head').append(head)
  let rows
  let pending
  let loadingPatch = false
  let sort = 'downloads'
  let descending = true
  let metadataError = ''

  function render() {
    const query = search.value.trim().toLowerCase()
    const visible = (rows ?? []).filter(row => columns.some(([key]) => String(row[key] ?? '').toLowerCase().includes(query)))
    visible.sort((a, b) => {
      const order = sort === 'downloads' ? Number(a.downloads || 0) - Number(b.downloads || 0)
        : String(a[sort] ?? '').localeCompare(String(b[sort] ?? ''))
      return (descending ? -order : order) || a.title.localeCompare(b.title)
    })
    Array.from(head.children).forEach((cell, index) => {
      const active = columns[index][0] === sort
      if (active) cell.setAttribute('aria-sort', descending ? 'descending' : 'ascending')
      else cell.removeAttribute('aria-sort')
      cell.firstChild.textContent = columns[index][1] + (active ? (descending ? ' ↓' : ' ↑') : '')
    })
    const tableRows = visible.map(row => {
      const tr = el('tr')
      const title = el('td')
      title.append(button(row.title || row.file, async () => {
        if (loadingPatch) return
        loadingPatch = true
        status.textContent = `Opening ${row.title || row.file}…`
        try {
          const response = await fetchOk(`../${row.directory}/${encodeURIComponent(row.file)}`)
          openPatch(await response.arrayBuffer(), row.file)
          dialog.close()
        } catch (error) {
          status.textContent = error.message
        } finally {
          loadingPatch = false
        }
      }))
      tr.append(title, ...columns.slice(1).map(([key]) => el('td', row[key] || '—')))
      return tr
    })
    $('corpus-rows').replaceChildren(...tableRows)
    status.textContent = rows ? `${visible.length} of ${rows.length} patches${metadataError}` : 'Loading patch index…'
  }

  for (const [key, name] of columns) {
    const th = el('th')
    th.scope = 'col'
    th.append(button(name, () => {
      descending = sort === key ? !descending : key === 'downloads'
      sort = key
      render()
    }))
    head.append(th)
  }
  search.oninput = render
  $('browse').onclick = async () => {
    dialog.showModal()
    search.focus()
    render()
    if (rows || pending) return
    pending = Promise.allSettled([
      fetchOk('../corpus/INDEX.csv').then(response => response.text()).then(parseCorpus),
      fetchOk('manifest.json').then(response => response.json()),
    ])
    const [corpus, local] = await pending
    pending = null
    rows = [corpus, local].flatMap((result, index) => result.status === 'fulfilled'
      ? result.value.map(row => ({ ...row, directory: index ? 'out' : 'corpus' })) : [])
    metadataError = corpus.status === 'rejected' ? ' · Corpus index unavailable'
      : local.status === 'rejected' ? ' · Local manifest unavailable' : ''
    render()
    if (corpus.status === 'rejected') rows = null
  }
}
