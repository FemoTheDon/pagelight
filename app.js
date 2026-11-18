// PageLight by Breadbaskets: the reader's page logic.
// Books are opened by foliate-js (EPUB, MOBI, AZW3, FB2, CBZ) and its
// bundled pdf.js (PDF). The Go side keeps the library on disk.
import './foliate/view.js'
import { makeBook } from './foliate/view.js'

const $ = s => document.querySelector(s)
const $$ = s => [...document.querySelectorAll(s)]
const TOKEN = new URLSearchParams(location.search).get('t') || ''
const native = !!window.pagelightNative

// ---------------------------------------------------------------- server
// The Chromebook / browser version keeps the library in the browser itself.
const WEB = !!globalThis.PAGELIGHT_WEB
const store = WEB ? await import('./store.js') : null
// Shortcut labels: ⌘ on the Mac, Ctrl on a Chromebook.
const keys = t => WEB ? t.replace(/⌃⌘F/g, 'Full-screen key').replace(/⇧⌘/g, 'Ctrl+Shift+').replace(/⌘/g, 'Ctrl+').replace(/⇧ /g, 'Shift+') : t
const covers = new Map() // book id -> object URL (browser version)
const coverURL = b => WEB ? covers.get(b.id) ?? '' : `/api/book/${b.id}/cover?t=${TOKEN}&v=${b.coverV || 0}`
async function loadCovers() {
    for (const b of books) {
        if (!b.cover || covers.has(b.id)) continue
        const blob = await store.coverBlob(b.id).catch(() => null)
        if (blob) covers.set(b.id, URL.createObjectURL(blob))
    }
}
const api = async (path, opts = {}) => {
    if (WEB) return store.localApi(path, opts)
    const headers = { 'X-PageLight': TOKEN, ...(opts.headers || {}) }
    let body = opts.body
    if (body && !(body instanceof Blob) && !(body instanceof ArrayBuffer) && typeof body !== 'string') {
        body = JSON.stringify(body)
        headers['Content-Type'] = 'application/json'
    }
    const res = await fetch('/api/' + path, { ...opts, headers, body })
    if (!res.ok) throw new Error((await res.text()) || res.statusText)
    const type = res.headers.get('Content-Type') || ''
    return type.includes('json') ? res.json() : res
}
const patchBook = (id, patch) => api('book/' + id, { method: 'PATCH', body: patch })

// ---------------------------------------------------------------- settings
const defaults = {
    paper: 'white', night: false, nightAuto: false, nightLevel: 0.86, nightPictures: true,
    focus: false, focusDim: 0.88, focusHide: false,
    fontSize: 19, fontFamily: 'original', lineHeight: 1.5, width: 700,
    flow: 'paginated', cols: 2, justify: true, hyphenate: true,
    spread: 'none', sort: 'recent', keepCopies: true, pdfZoom: 'fit-page',
}
let settings = { ...defaults }
let saveSettingsTimer
const saveSettings = () => {
    clearTimeout(saveSettingsTimer)
    saveSettingsTimer = setTimeout(() => api('settings', { method: 'PUT', body: settings }).catch(() => {}), 400)
}
const set = (key, value) => {
    settings[key] = value
    saveSettings()
    applySettings()
}

// ---------------------------------------------------------------- helpers
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const pct = f => `${Math.round((f || 0) * 100)}%`
const langText = x => !x ? '' : typeof x === 'string' ? x : x[Object.keys(x)[0]] ?? ''
const contributor = c => Array.isArray(c) ? c.map(contributor).filter(Boolean).join(', ')
    : typeof c === 'string' ? c : langText(c?.name)
let toastTimer
const toast = (text, ms = 2200) => {
    const t = $('#toast')
    t.textContent = text
    t.hidden = false
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => t.hidden = true, ms)
}
const showDialog = html => {
    $('#dialog-body').innerHTML = html
    $('#dialog').showModal()
}
const debounce = (fn, ms) => {
    let t
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms) }
}
const fetchFile = async b => {
    const res = await api(`book/${b.id}/file`)
    const blob = await res.blob()
    return new File([blob], b.name, { type: blob.type })
}

// ================================================================ library
let books = []
const tried = new Set()

async function loadLibrary() {
    books = await api('library')
    if (WEB) await loadCovers()
    renderLibrary()
    fillMissingCovers()
}

function sortedBooks() {
    const q = $('#lib-filter').value.trim().toLowerCase()
    let list = books.filter(b => !q || `${b.title} ${b.author} ${b.name}`.toLowerCase().includes(q))
    const by = settings.sort
    const recent = b => Math.max(b.opened || 0, b.added || 0)
    if (by === 'title') list.sort((a, b) => a.title.localeCompare(b.title))
    else if (by === 'author') list.sort((a, b) => (a.author || '~').localeCompare(b.author || '~') || a.title.localeCompare(b.title))
    else if (by === 'added') list.sort((a, b) => b.added - a.added)
    else list.sort((a, b) => recent(b) - recent(a))
    return list
}

const coverHTML = b => `<div class="cover">${b.cover ? `<img src="${coverURL(b)}" alt="">` : ''}<div class="ph">${b.cover ? '' : esc(b.title)}</div></div>`

// Settings › Library: offers to copy books that are only linked.
function renderNote() {
    if (WEB) return
    const linked = books.filter(b => !b.kept && !b.missing)
    $('#keep-status').innerHTML = linked.length
        ? `${linked.length} book${linked.length > 1 ? 's are' : ' is'} only linked to the original file (marked “Linked”). <a href="#" data-note="keepall">Keep copies of ${linked.length > 1 ? 'them' : 'it'}</a>`
        : ''
}

// A word after Open about where the book is kept.
function storageToast(n) {
    if (!n) return
    if (WEB) return toast(`Saved in PageLight on this computer, so ${n > 1 ? 'these books stay' : 'this book stays'} even if you delete the original file.`, 5000)
    const what = n > 1 ? 'These books are' : 'This book is'
    toast(settings.keepCopies
        ? `${what} copied into your library, so ${n > 1 ? 'they stay' : 'it stays'} safe if the original is moved or deleted. To link to originals instead: Settings (⌘,)`
        : `${what} linked to the original file: if it is moved or deleted, it leaves your library. To keep copies instead: Settings (⌘,)`, 6500)
}

async function keepAll() {
    const linked = books.filter(b => !b.kept && !b.missing)
    let done = 0
    for (const b of linked) {
        try { await api(`book/${b.id}/keep`, { method: 'POST' }); done++ } catch (e) { toast(`${b.title}: ${e.message}`) }
    }
    toast(`Kept copies of ${done} book${done === 1 ? '' : 's'}`)
    loadLibrary()
}

function renderLibrary() {
    renderNote()
    $('#lib-empty').hidden = books.length > 0
    $('#lib-sort').value = settings.sort
    const last = [...books].filter(b => b.opened && !b.missing && b.fraction < 0.995).sort((a, b) => b.opened - a.opened)[0]
    $('#lib-continue').innerHTML = last && !$('#lib-filter').value ? `
        <div class="continue" data-id="${last.id}">
          ${coverHTML(last)}
          <div>
            <div class="k">Continue reading</div>
            <div class="t">${esc(last.title)}</div>
            <div class="a">${esc(last.author)}</div>
            <div class="meter"><i style="width:${pct(last.fraction)}"></i></div>
            <div class="a" style="margin-top:6px;font-size:12px">${pct(last.fraction)} read${last.page ? ' · ' + esc(last.page) : ''}</div>
          </div>
        </div>` : ''
    $('#lib-grid').innerHTML = sortedBooks().map(b => `
        <div class="book${b.missing ? ' missing' : ''}" data-id="${b.id}" title="${esc(b.path)}">
          ${coverHTML(b)}
          <button class="btn more" data-more="${b.id}" title="More"><svg class="ic"><use href="#i-dots"/></svg></button>
          <div class="t">${esc(b.title)}</div>
          <div class="a">${esc(b.author) || '&nbsp;'}</div>
          <div class="row"><span class="fmt">${esc(b.format)}</span>${b.kept ? '' : `<span class="fmt linked" title="Linked to the original file: ${esc(b.path)}">Linked</span>`}
            ${b.opened ? `<span class="meter"><i style="width:${pct(b.fraction)}"></i></span><span>${pct(b.fraction)}</span>` : '<span>New</span>'}
          </div>
        </div>`).join('')
}

// Reads covers and titles of books that haven't been opened yet, one at a
// time in the background.
let filling = false
async function fillMissingCovers() {
    if (filling) return
    filling = true
    try {
        for (const b of books) {
            if (b.cover || b.missing || tried.has(b.id)) continue
            tried.add(b.id)
            try {
                const book = await makeBook(await fetchFile(b))
                await saveBookInfo(b, book)
                book.destroy?.()
                renderLibrary()
            } catch (e) { console.warn('cover', b.name, e) }
        }
    } finally { filling = false }
}

async function saveBookInfo(b, book) {
    const title = langText(book.metadata?.title).trim()
    const author = contributor(book.metadata?.author).trim()
    const patch = {}
    if (title && title !== b.title) patch.title = b.title = title
    if (author && author !== b.author) patch.author = b.author = author
    if (Object.keys(patch).length) await patchBook(b.id, patch).catch(() => {})
    if (!b.cover) {
        const blob = await Promise.resolve(book.getCover?.()).catch(() => null)
        if (blob) {
            const small = await shrinkImage(blob).catch(() => blob)
            await api(`book/${b.id}/cover`, { method: 'PUT', body: small })
            if (WEB) covers.set(b.id, URL.createObjectURL(small))
            b.cover = true
            b.coverV = Date.now()
        }
    }
}

// Covers are kept at a sensible size (a PDF's first page can be huge).
async function shrinkImage(blob) {
    const bmp = await createImageBitmap(blob)
    const scale = Math.min(1, 480 / bmp.width)
    const c = document.createElement('canvas')
    c.width = Math.round(bmp.width * scale)
    c.height = Math.round(bmp.height * scale)
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height)
    return new Promise(r => c.toBlob(r, 'image/jpeg', 0.86))
}

async function openDialog() {
    if (native) {
        const added = await api('open-dialog', { method: 'POST' })
        if (added.length) {
            await loadLibrary()
            await openBook(added[added.length - 1].id)
            storageToast(added.length)
        }
        return
    }
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.accept = '.epub,.pdf,.mobi,.azw,.azw3,.prc,.kf8,.fb2,.fbz,.cbz'
    input.onchange = () => uploadFiles([...input.files])
    input.click()
}

async function uploadFiles(files) {
    let last
    for (const f of files) {
        try {
            const added = await api('upload?name=' + encodeURIComponent(f.name), { method: 'POST', body: f })
            if (added[0]) last = added[0]
        } catch (e) { toast(`${f.name}: ${e.message}`) }
    }
    await loadLibrary()
    if (last && files.length === 1) await openBook(last.id)
    if (last) WEB ? storageToast(files.length) : toast(`Dropped books are kept in your library (Settings › Library explains where).`, 4000)
}

function bookMenu(id, x, y) {
    const b = books.find(b => b.id === id)
    if (!b) return
    closeMenus()
    const m = document.createElement('div')
    m.className = 'menu'
    m.innerHTML = `
        <button data-a="open">Open</button>
        ${native ? '<button data-a="reveal">Show in Finder</button>' : ''}
        <button data-a="info">Book info</button>
        ${b.kept || b.missing ? '' : '<button data-a="keep">Keep a copy in the library</button>'}
        <hr>
        <button data-a="remove">Remove from library</button>`
    document.body.append(m)
    m.style.left = Math.min(x, innerWidth - m.offsetWidth - 8) + 'px'
    m.style.top = Math.min(y, innerHeight - m.offsetHeight - 8) + 'px'
    m.onclick = async e => {
        const a = e.target.dataset.a
        closeMenus()
        if (a === 'open') openBook(id)
        if (a === 'reveal') api(`book/${id}/reveal`, { method: 'POST' })
        if (a === 'info') bookInfo(b)
        if (a === 'keep') {
            await api(`book/${id}/keep`, { method: 'POST' }).then(() => toast('A copy is now kept in the library')).catch(e => toast(e.message))
            loadLibrary()
        }
        if (a === 'remove') {
            const msg = b.kept
                ? `Remove “${b.title}” from the library?\n\nPageLight’s copy of the book is deleted.` + (b.original ? ` Your original file is not touched:\n${b.original}` : '')
                : `Remove “${b.title}” from the library?\n\nThe book file itself is not deleted:\n${b.path}`
            if (!confirm(msg)) return
            await api('book/' + id, { method: 'DELETE' })
            toast(`Removed “${b.title}” from the library`)
            loadLibrary()
        }
    }
}
const closeMenus = () => $$('.menu').forEach(m => m.remove())

function bookInfo(b) {
    const md = current?.book?.metadata
    const rows = [
        ['Title', b.title], ['Author', b.author], ['Format', b.format],
        ['Publisher', md && current.id === b.id ? contributor(md.publisher) : ''],
        ['Language', md && current.id === b.id ? langText(md.language) : ''],
        ['Read', pct(b.fraction)], ['Bookmarks', b.bookmarks?.length || 0],
        ['Size', b.size ? (b.size / 1048576).toFixed(1) + ' MB' : ''],
        [b.kept ? 'Kept at' : 'Linked to', b.path], ['Copied from', b.original ?? ''],
    ].filter(r => r[1] !== '' && r[1] != null)
    showDialog(`<h2>Book info</h2><table>${rows.map(([k, v]) => `<tr><td>${k}</td><td>${esc(v)}</td></tr>`).join('')}</table>`)
}

// ================================================================ reader
let current = null // { id, b, book, view }
let lastLocation = null
let searchRun = 0

async function openBook(id) {
    const b = books.find(x => x.id === id) ?? await api('book/' + id).catch(() => null)
    if (!b) return
    if (b.missing) {
        showDialog(`<h2>Book not found</h2><p>PageLight can’t find <b>${esc(b.name)}</b> any more. It was at:</p><p><code>${esc(b.path)}</code></p><p>If you moved it, open it again from its new place.</p>`)
        return
    }
    closeReader()
    document.body.className = document.body.className.replace(/\bview-\w+/, 'view-reader')
    $('#loading').hidden = false
    $('#loading-text').textContent = `Opening ${b.title}…`
    $('#book-title').textContent = b.title
    $('#book-chapter').textContent = ''
    try {
        const book = await makeBook(await fetchFile(b))
        if (book.rendition?.layout === 'pre-paginated' && settings.spread === 'none') book.rendition.spread = 'none'
        const view = document.createElement('foliate-view')
        current = { id, b, book, view }
        $('#page').append(view)
        await view.open(book)
        document.body.classList.toggle('fixed', view.isFixedLayout)
        view.addEventListener('relocate', onRelocate)
        view.addEventListener('load', onDocLoad)
        view.addEventListener('external-link', e => { e.preventDefault(); window.open(e.detail.a.href, '_blank') })
        applyRenderer()
        buildTOC(book)
        renderBookmarks()
        resetSearch()

        const title = langText(book.metadata?.title) || b.title
        $('#book-title').textContent = title
        $('#panel-title').textContent = title
        $('#panel-author').textContent = contributor(book.metadata?.author)
        $('#panel-cover').removeAttribute('src')
        if (b.cover) $('#panel-cover').src = coverURL(b)
        setChrome()

        try {
            await view.init({ lastLocation: b.location || null, showTextStart: !b.location })
        } catch {
            if (b.fraction) await view.goToFraction(b.fraction)
            else await view.next()
        }
        b.opened = Date.now()
        patchBook(id, { opened: b.opened })
        saveBookInfo(b, book).then(() => {
            if (b.cover) $('#panel-cover').src = coverURL(b)
        }).catch(() => {})
    } catch (e) {
        console.error(e)
        closeReader()
        showLibrary()
        showDialog(`<h2>This book couldn’t be opened</h2><p><b>${esc(b.name)}</b></p><p>${esc(e.message || e)}</p><p>Kindle books bought from Amazon (with DRM) can’t be opened by any reader except Kindle’s own.</p>`)
        return
    } finally {
        $('#loading').hidden = true
    }
    setTimeout(() => current?.view?.focus(), 50)
}

function closeReader() {
    saveProgressNow()
    if (current) {
        current.view.close?.()
        current.view.remove()
        current.book.destroy?.()
    }
    current = null
    lastLocation = null
    closePanel()
    closePop()
}

function showLibrary() {
    closeReader()
    document.body.className = document.body.className.replace(/\bview-\w+/, 'view-library')
    setChrome()
    loadLibrary()
}

// Book styles (only for reflowable books: EPUB, MOBI, AZW3, FB2).
function bookCSS() {
    const s = settings
    const ink = getComputedStyle(document.body).getPropertyValue('--ink').trim() || '#1c1b19'
    const font = s.fontFamily !== 'original' ? `
        html, body, p, div, span, li, blockquote, dd, dt, td, th, a, em, i, b, strong, h1, h2, h3, h4, h5, h6 {
            font-family: ${s.fontFamily} !important;
        }` : ''
    const pictures = s.night && s.nightPictures ? `
        img, svg, video, picture, image, canvas { filter: invert(1) hue-rotate(180deg); }` : ''
    return `
        @namespace epub "http://www.idpf.org/2007/ops";
        html { color: ${ink}; font-size: ${s.fontSize}px !important; color-scheme: light; }
        html, body { background: transparent !important; }
        body { color: inherit; }
        p, li, blockquote, dd {
            line-height: ${s.lineHeight} !important;
            text-align: ${s.justify ? 'justify' : 'start'};
            -webkit-hyphens: ${s.hyphenate ? 'auto' : 'manual'};
            hyphens: ${s.hyphenate ? 'auto' : 'manual'};
            widows: 2; orphans: 2;
        }
        [align="left"] { text-align: left; } [align="right"] { text-align: right; } [align="center"] { text-align: center; }
        pre { white-space: pre-wrap !important; }
        a:link { color: #2a6db0; }
        ::selection { background: rgba(201,130,43,.35); }
        aside[epub|type~="footnote"], aside[epub|type~="endnote"], aside[epub|type~="note"], aside[epub|type~="rearnote"] { display: none; }
        ${font}${pictures}`
}

function applyRenderer() {
    if (!current) return
    const r = current.view.renderer
    const s = settings
    document.body.classList.toggle('scrolled', !current.view.isFixedLayout && s.flow === 'scrolled')
    if (current.view.isFixedLayout) {
        const z = s.pdfZoom
        r.setAttribute('zoom', typeof z === 'number' ? String(z / 100 * PT) : z)
        setTimeout(updateZoomLabel, 120)
        return
    }
    r.setAttribute('flow', s.flow)
    r.setAttribute('max-inline-size', s.width + 'px')
    r.setAttribute('max-column-count', String(s.cols))
    r.setAttribute('gap', '7%')
    r.setAttribute('margin', '36px')
    r.setAttribute('animated', '')
    r.setStyles?.(bookCSS())
    // The page card's width follows the text width so the space around it
    // is "outside the page" (and dims in focus mode).
    const pageMax = s.flow === 'scrolled' ? s.width + 160 : s.width * s.cols + 160
    document.body.style.setProperty('--page-max', pageMax + 'px')
}

// ---------------------------------------------------------------- location
const saveProgress = debounce(() => saveProgressNow(), 700)
function saveProgressNow() {
    if (!current || !lastLocation) return
    const { b } = current
    const page = locLabel(lastLocation)
    b.fraction = lastLocation.fraction ?? b.fraction
    b.location = lastLocation.cfi ?? b.location
    b.page = page
    patchBook(b.id, { fraction: b.fraction, location: b.location, page }).catch(() => {})
}

function locLabel(loc) {
    if (!current) return ''
    if (current.view.isFixedLayout && loc.section) return `Page ${loc.section.current + 1} of ${loc.section.total}`
    if (loc.pageItem) return `Page ${loc.pageItem.label}`
    if (loc.location) return `Location ${loc.location.current + 1} of ${loc.location.total}`
    return ''
}

function onRelocate({ detail }) {
    lastLocation = detail
    if (current?.view.isFixedLayout) {
        const r = current.view.renderer
        requestAnimationFrame(() => { r.scrollTop = scrollToEnd ? r.scrollHeight : 0; scrollToEnd = false; updateZoomLabel() })
    }
    else updateZoomLabel()
    const { fraction, tocItem, time } = detail
    $('#progress').value = fraction ?? 0
    $('#loc-left').textContent = locLabel(detail)
    let right = pct(fraction)
    if (time?.section != null && !current?.view.isFixedLayout) {
        const m = Math.round(time.section)
        right = (m >= 1 ? `${m} min left in chapter · ` : 'End of chapter · ') + right
    }
    $('#loc-right').textContent = right
    $('#book-chapter').textContent = tocItem?.label ?? ''
    markTOC(tocItem?.href)
    $('#bm-btn').classList.toggle('on', isBookmarked())
    $('#bm-btn').classList.toggle('toggle', true)
    saveProgress()
}

function onDocLoad({ detail: { doc } }) {
    if (current?.view.isFixedLayout) { lastFixedDoc = doc; setTimeout(updateZoomLabel, 150) }
    doc.addEventListener('keydown', onKey)
    doc.addEventListener('wheel', onWheel, { passive: false })
    doc.addEventListener('gesturestart', onGesture)
    doc.addEventListener('gesturechange', onGesture)
    doc.addEventListener('pointerdown', () => { closePop(); closeMenus() })
}

// Trackpad and mouse wheel turn pages in page layout.
let wheelSum = 0, wheelLock = 0
function onWheel(e) {
    if (!current || $('#panel').contains(e.target) || $('#appearance').contains(e.target)) return
    // Trackpad pinch arrives as a wheel event with Ctrl held.
    if (e.ctrlKey) {
        e.preventDefault()
        pinchSum += e.deltaY
        if (Math.abs(pinchSum) > 25) { run(pinchSum < 0 ? 'bigger' : 'smaller'); pinchSum = 0 }
        return
    }
    if (current.view.isFixedLayout && zoomed()) {
        // A zoomed PDF page scrolls; at the top or bottom the page turns.
        e.preventDefault()
        const r = current.view.renderer
        const before = r.scrollTop
        r.scrollBy(e.deltaX, e.deltaY)
        const atEdge = r.scrollTop === before
        if (!atEdge) { edgeSum = 0; return }
        edgeSum += e.deltaY
        const now = Date.now()
        if (now > wheelLock && Math.abs(edgeSum) > 160) {
            edgeSum > 0 ? turnZoomed(1) : turnZoomed(-1)
            edgeSum = 0
            wheelLock = now + 500
        }
        return
    }
    const scrolled = !current.view.isFixedLayout && settings.flow === 'scrolled'
    if (scrolled) return
    e.preventDefault()
    const now = Date.now()
    if (now < wheelLock) return
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
    wheelSum += d
    if (Math.abs(wheelSum) > 60) {
        wheelSum > 0 ? current.view.next() : current.view.prev()
        wheelSum = 0
        wheelLock = now + 450
    }
}

// ---------------------------------------------------------------- zoom (PDF and other fixed-page books)
const PT = 4 / 3 // 100% = the page's printed size on screen, as in Preview
const ZOOMS = [25, 33, 50, 67, 75, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400]
let lastFixedDoc = null, pinchSum = 0, edgeSum = 0, scrollToEnd = false, gestureScale = 1
const zoomed = () => settings.pdfZoom !== 'fit-page'

// The zoom the page is shown at right now, in percent.
function effectiveZoom() {
    try {
        const frame = lastFixedDoc?.defaultView?.frameElement
        const vp = lastFixedDoc.querySelector('meta[name=viewport]')?.content ?? ''
        const w = parseFloat(/width=([\d.]+)/.exec(vp)?.[1])
        const shown = frame.parentElement.getBoundingClientRect().width
        if (w && shown) return shown / w / PT * 100
    } catch {}
    return typeof settings.pdfZoom === 'number' ? settings.pdfZoom : 100
}
function zoomStep(dir) {
    const cur = effectiveZoom()
    const next = dir > 0 ? ZOOMS.find(z => z > cur + 1) ?? ZOOMS.at(-1) : [...ZOOMS].reverse().find(z => z < cur - 1) ?? ZOOMS[0]
    setZoom(next)
}
function setZoom(z) {
    set('pdfZoom', z)
    toast(z === 'fit-page' ? 'Fit page to window' : z === 'fit-width' ? 'Fit page width' : `Zoom ${z}%`)
}
function updateZoomLabel() {
    if (!current) return
    const fixed = current.view.isFixedLayout
    $('#zoom-label').textContent = fixed ? `${Math.round(effectiveZoom())}%` : `${settings.fontSize}`
    $('#zoom-label').title = keys(fixed ? 'Fit page to window (⌘0)' : 'Text size: click to reset (⌘0)')
    for (const b of $$('[data-fit]')) b.classList.toggle('on', settings.pdfZoom === b.dataset.fit)
}
function turnZoomed(dir) {
    scrollToEnd = dir < 0
    dir > 0 ? current.view.next() : current.view.prev()
}
// Safari's own pinch events (the Mac app's web view sends these).
function onGesture(e) {
    if (!current) return
    e.preventDefault()
    if (e.type === 'gesturestart') { gestureScale = 1; return }
    if (e.scale / gestureScale > 1.12) { run('bigger'); gestureScale = e.scale }
    else if (e.scale / gestureScale < 0.89) { run('smaller'); gestureScale = e.scale }
}
// Keys for a zoomed page: up/down and Space scroll first, then turn.
function zoomedKey(e) {
    const r = current.view.renderer
    const page = r.clientHeight * 0.9
    const by = { ArrowDown: 80, ArrowUp: -80, ' ': e.shiftKey ? -page : page, PageDown: page, PageUp: -page }[e.key]
    if (by == null) return false
    e.preventDefault()
    const before = r.scrollTop
    r.scrollBy(0, by)
    if (r.scrollTop === before) turnZoomed(by > 0 ? 1 : -1)
    return true
}

// ---------------------------------------------------------------- contents
let tocLinks = new Map()
function buildTOC(book) {
    tocLinks = new Map()
    const ol = $('#toc')
    ol.innerHTML = ''
    const make = (items, parent) => {
        for (const item of items ?? []) {
            const li = document.createElement('li')
            const a = document.createElement('a')
            a.textContent = (item.label ?? '').trim() || '—'
            if (item.href) {
                a.href = '#'
                a.onclick = e => {
                    e.preventDefault()
                    current?.view.goTo(item.href).catch(console.error)
                    if (innerWidth < 1100) closePanel()
                }
                if (!tocLinks.has(item.href)) tocLinks.set(item.href, a)
            }
            li.append(a)
            if (item.subitems?.length) {
                const sub = document.createElement('ol')
                make(item.subitems, sub)
                li.append(sub)
            }
            parent.append(li)
        }
    }
    make(book.toc, ol)
    if (!book.toc?.length) ol.innerHTML = '<li class="none">This book has no table of contents.</li>'
}
function markTOC(href) {
    for (const a of $$('#toc a.current')) a.classList.remove('current')
    const a = href && tocLinks.get(href)
    if (a) {
        a.classList.add('current')
        if ($('#panel').classList.contains('open')) a.scrollIntoView({ block: 'nearest' })
    }
}

// ---------------------------------------------------------------- bookmarks
const isBookmarked = () => !!(current && lastLocation?.cfi && current.b.bookmarks?.some(b => b.cfi === lastLocation.cfi))
async function toggleBookmark() {
    if (!current || !lastLocation?.cfi) return
    const b = current.b
    b.bookmarks ??= []
    if (isBookmarked()) {
        b.bookmarks = b.bookmarks.filter(x => x.cfi !== lastLocation.cfi)
        toast('Bookmark removed')
    } else {
        const label = [lastLocation.tocItem?.label?.trim(), locLabel(lastLocation)].filter(Boolean).join(' · ') || pct(lastLocation.fraction)
        b.bookmarks.push({ cfi: lastLocation.cfi, label, fraction: lastLocation.fraction ?? 0, added: Date.now() })
        b.bookmarks.sort((x, y) => x.fraction - y.fraction)
        toast('Bookmarked')
    }
    $('#bm-btn').classList.toggle('on', isBookmarked())
    renderBookmarks()
    await patchBook(b.id, { bookmarks: b.bookmarks }).catch(() => {})
}
function renderBookmarks() {
    const list = current?.b.bookmarks ?? []
    $('#bm-list').innerHTML = list.length ? list.map((bm, i) => `
        <li data-bm="${i}"><div class="main">${esc(bm.label)}<div class="sub">${pct(bm.fraction)} · ${new Date(bm.added || Date.now()).toLocaleDateString()}</div></div>
        <button class="btn del" data-delbm="${i}" title="Delete"><svg class="ic"><use href="#i-trash"/></svg></button></li>`).join('')
        : keys('<li class="sub">No bookmarks yet. Press ⌘D (or the bookmark button) on any page.</li>')
}

// ---------------------------------------------------------------- search
function resetSearch() {
    searchRun++
    current?.view.clearSearch?.()
    $('#search-results').innerHTML = ''
    $('#search-status').textContent = current?.view.isFixedLayout && current?.b.format === 'PDF' ? 'Searching inside PDFs isn’t available yet.' : ''
}
async function runSearch(query) {
    if (!current || !query.trim()) return
    resetSearch()
    const run = searchRun
    const out = $('#search-results')
    let count = 0
    $('#search-status').textContent = 'Searching…'
    try {
        for await (const r of current.view.search({ query })) {
            if (run !== searchRun) return
            if (r === 'done') break
            if (r.progress != null) { $('#search-status').textContent = `Searching… ${pct(r.progress)}`; continue }
            const items = r.subitems ?? []
            count += items.length
            if (r.label) out.insertAdjacentHTML('beforeend', `<li class="group-label">${esc(r.label)}</li>`)
            for (const it of items) {
                const li = document.createElement('li')
                const ex = it.excerpt ?? {}
                li.innerHTML = `<div class="main">…${esc(ex.pre)}<mark>${esc(ex.match)}</mark>${esc(ex.post)}…</div>`
                li.onclick = () => current?.view.goTo(it.cfi)
                out.append(li)
            }
        }
        if (run === searchRun) $('#search-status').textContent = count ? `${count} found` : 'Nothing found'
    } catch (e) {
        $('#search-status').textContent = 'Search isn’t available for this book.'
    }
}

// ---------------------------------------------------------------- panel & popover
function openPanel(tab) {
    if (!current) return
    closePop()
    $('#panel').classList.add('open')
    for (const b of $$('.tabs button')) b.classList.toggle('on', b.dataset.tab === tab)
    for (const t of $$('.tab')) t.classList.toggle('on', t.id === 'tab-' + tab)
    if (tab === 'search') setTimeout(() => $('#search-input').focus(), 50)
    if (tab === 'toc') $('#toc a.current')?.scrollIntoView({ block: 'center' })
}
function togglePanel(tab) {
    const open = $('#panel').classList.contains('open') && $(`.tabs button[data-tab=${tab}]`).classList.contains('on')
    open ? closePanel() : openPanel(tab)
}
function closePanel() {
    $('#panel').classList.remove('open')
    current?.view.focus?.()
}
function togglePop() {
    closePanel()
    if ($('#appearance').classList.toggle('open')) $('#appearance').scrollTop = 0
    syncControls()
}
const closePop = () => $('#appearance').classList.remove('open')

// ---------------------------------------------------------------- appearance
function syncControls() {
    const s = settings
    for (const b of $$('.themes [data-paper]')) b.classList.toggle('on', b.dataset.paper === s.paper)
    for (const b of $$('[data-width]')) b.classList.toggle('on', +b.dataset.width === s.width)
    for (const b of $$('[data-flow]')) b.classList.toggle('on', b.dataset.flow === s.flow)
    for (const b of $$('[data-cols]')) b.classList.toggle('on', +b.dataset.cols === s.cols)
    for (const b of $$('[data-spread]')) b.classList.toggle('on', b.dataset.spread === s.spread)
    $('#font-size').value = s.fontSize
    $('#font-family').value = s.fontFamily
    $('#line-height').value = s.lineHeight
    $('#justify').checked = s.justify
    $('#hyphenate').checked = s.hyphenate
    $('#focus-dim').value = s.focusDim
    $('#focus-hide').checked = s.focusHide
    $('#night-level').value = s.nightLevel
    $('#night-pictures').checked = s.nightPictures
    $('#night-auto').checked = s.nightAuto
    $('#keep-copies').checked = s.keepCopies
}

function applySettings() {
    const s = settings
    const body = document.body
    body.dataset.tone = s.paper
    body.classList.toggle('night', s.night)
    body.classList.toggle('focus', s.focus)
    body.classList.toggle('focus-hide', s.focusHide)
    body.style.setProperty('--dim', s.focusDim)
    body.style.setProperty('--night-level', s.nightLevel)
    $('#focus-btn').classList.toggle('on', s.focus)
    $('#night-btn').classList.toggle('on', s.night)
    $('#lib-night').classList.toggle('on', s.night)
    $('#lib-night').classList.toggle('toggle', true)
    if (current) {
        current.view.toggleAttribute('autohide-cursor', s.focus)
        applyRenderer()
        updateZoomLabel()
    }
    syncControls()
    setChrome()
}

function toggleFocus() {
    set('focus', !settings.focus)
    toast(settings.focus ? 'Focus mode on: press F or Esc to leave' : 'Focus mode off')
}
function toggleNight() {
    autoNightState = null // a manual choice holds until the next sunset/sunrise
    set('night', !settings.night)
    toast(settings.night ? 'Night mode on' : 'Night mode off')
}

// Night mode can come on by itself in the evening.
let autoNightState = null
function autoNight() {
    if (!settings.nightAuto) return
    const h = new Date().getHours()
    const want = h >= 20 || h < 7
    if (want !== autoNightState) {
        autoNightState = want
        if (settings.night !== want) set('night', want)
    }
}

const fontStep = d => {
    set('fontSize', Math.max(12, Math.min(40, settings.fontSize + d)))
    toast(`Text size ${settings.fontSize}`)
}

// The native window's title bar follows the page's colours.
function setChrome() {
    if (!native) return
    const reader = document.body.classList.contains('view-reader')
    const night = settings.night
    const bg = reader ? (night ? '#1e1e1f' : getComputedStyle(document.body).getPropertyValue('--bar').trim()) : (night ? '#1e1e1f' : '#faf8f5')
    api('chrome', { method: 'POST', body: {
        title: reader && current ? $('#book-title').textContent : 'PageLight',
        dark: night,
        focus: reader && settings.focus,
        bg: /^#/.test(bg) ? bg : (night ? '#1e1e1f' : '#faf8f5'),
    } }).catch(() => {})
}

// ---------------------------------------------------------------- commands
const commands = {
    library: () => showLibrary(),
    open: () => openDialog(),
    toc: () => togglePanel('toc'),
    bookmarks: () => togglePanel('bookmarks'),
    search: () => current ? openPanel('search') : $('#lib-filter').focus(),
    bookmark: () => toggleBookmark(),
    appearance: () => togglePop(),
    closePop: () => closePop(),
    focus: () => current ? toggleFocus() : toast('Focus mode works while reading a book'),
    night: () => toggleNight(),
    next: () => current?.view.next(),
    prev: () => current?.view.prev(),
    nextChapter: () => current?.view.renderer.nextSection?.(),
    prevChapter: () => current?.view.renderer.prevSection?.(),
    back: () => current?.view.history.back(),
    forward: () => current?.view.history.forward(),
    bigger: () => current && (current.view.isFixedLayout ? zoomStep(1) : fontStep(1)),
    smaller: () => current && (current.view.isFixedLayout ? zoomStep(-1) : fontStep(-1)),
    resetSize: () => current && (current.view.isFixedLayout ? setZoom('fit-page') : (set('fontSize', defaults.fontSize), toast('Text size reset'))),
    fitWidth: () => current?.view.isFixedLayout && setZoom('fit-width'),
    fitPage: () => current?.view.isFixedLayout && setZoom('fit-page'),
    'layout:paginated': () => set('flow', 'paginated'),
    'layout:scrolled': () => set('flow', 'scrolled'),
    closePanel: () => closePanel(),
    reveal: () => current && api(`book/${current.id}/reveal`, { method: 'POST' }),
    info: () => current && bookInfo(current.b),
    about: () => showDialog(`<h2>PageLight</h2><p>Version ${esc(info.version || '1.0')} · by Breadbaskets</p><p>Reads EPUB, PDF, MOBI, AZW3, FB2 and CBZ books.</p><p style="color:var(--muted);font-size:12px">Book rendering by foliate-js and pdf.js (MIT and Apache licences).</p>`),
    help: () => showDialog(keys(`<h2>Keyboard</h2><table>
        <tr><td><kbd>→</kbd> <kbd>Space</kbd></td><td>Next page</td></tr>
        <tr><td><kbd>←</kbd> <kbd>⇧ Space</kbd></td><td>Previous page</td></tr>
        <tr><td><kbd>F</kbd></td><td>Focus mode: everything around the page dims</td></tr>
        <tr><td><kbd>N</kbd></td><td>Night mode: the page is inverted</td></tr>
        <tr><td><kbd>T</kbd> / <kbd>⌘T</kbd></td><td>Contents</td></tr>
        <tr><td><kbd>B</kbd></td><td>Bookmarks</td></tr>
        <tr><td><kbd>⌘D</kbd></td><td>Bookmark this page</td></tr>
        <tr><td><kbd>⌘F</kbd></td><td>Find in book</td></tr>
        <tr><td><kbd>⌘+</kbd> <kbd>⌘−</kbd></td><td>Bigger / smaller text (PDF: zoom in / out; or pinch)</td></tr>
        <tr><td><kbd>⌘0</kbd></td><td>Normal text size (PDF: fit page to window)</td></tr>
        <tr><td><kbd>⌘Y</kbd></td><td>Appearance</td></tr>
        <tr><td><kbd>⌘L</kbd></td><td>Back to the library</td></tr>
        <tr><td><kbd>Esc</kbd></td><td>Close panels, then leave focus mode</td></tr>
        <tr><td><kbd>⌃⌘F</kbd></td><td>Full screen</td></tr></table>
        <p style="font-size:12px;color:var(--muted)">On a trackpad, swipe or scroll to turn pages.</p>`)),
}
const run = cmd => {
    if (cmd.startsWith('layout:') || commands[cmd]) return commands[cmd]?.()
}
window.pagelightMenu = cmd => run(cmd)
window.pagelightPending = async () => {
    const ids = await api('pending').catch(() => [])
    if (ids.length) {
        await loadLibrary()
        openBook(ids[ids.length - 1])
    }
}
window.pagelightQuit = () => saveProgressNow()

// ---------------------------------------------------------------- keys
function onKey(e) {
    const t = e.target
    const typing = t && (t.tagName === 'INPUT' && t.type !== 'range' && t.type !== 'checkbox' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')
    const mod = e.metaKey || e.ctrlKey
    if (e.key === 'Escape') {
        if ($('#dialog').open) return
        if ($$('.menu').length) return closeMenus()
        if ($('#appearance').classList.contains('open')) return closePop()
        if ($('#panel').classList.contains('open')) return closePanel()
        if (settings.focus && current) return toggleFocus()
        return
    }
    if (typing) return
    // In the Mac app the menu bar handles ⌘ shortcuts; in a browser we do.
    if (mod) {
        // Zoom keys are handled here as well as in the Mac menu bar: whichever
        // sees the key first acts, and preventDefault stops the other.
        const zoomKey = { '=': 'bigger', '+': 'bigger', '-': 'smaller', '_': 'smaller', '0': 'resetSize' }[e.key]
        if (zoomKey) { e.preventDefault(); return run(zoomKey) }
        if (native) return
        const map = { o: 'open', l: 'library', t: 'toc', d: 'bookmark', f: 'search', y: 'appearance', ',': 'appearance', '=': 'bigger', '+': 'bigger', '-': 'smaller', '0': 'resetSize' }
        const cmd = e.shiftKey ? { F: 'focus', N: 'night', B: 'bookmarks', f: 'focus', n: 'night', b: 'bookmarks' }[e.key] : map[e.key]
        if (cmd) { e.preventDefault(); run(cmd) }
        return
    }
    if (!current) {
        if (e.key === 'n' || e.key === 'N') toggleNight()
        return
    }
    if (current.view.isFixedLayout && zoomed() && zoomedKey(e)) return
    switch (e.key) {
        case 'ArrowRight': case 'PageDown': e.preventDefault(); current.view.goRight?.() ?? current.view.next(); break
        case 'ArrowLeft': case 'PageUp': e.preventDefault(); current.view.goLeft?.() ?? current.view.prev(); break
        case 'ArrowDown': if (settings.flow !== 'scrolled' || current.view.isFixedLayout) { e.preventDefault(); current.view.next() } break
        case 'ArrowUp': if (settings.flow !== 'scrolled' || current.view.isFixedLayout) { e.preventDefault(); current.view.prev() } break
        case ' ': e.preventDefault(); e.shiftKey ? current.view.prev() : current.view.next(); break
        case 'Home': current.view.goToFraction(0); break
        case 'End': current.view.goToFraction(0.9999); break
        case 'f': case 'F': toggleFocus(); break
        case 'n': case 'N': toggleNight(); break
        case 't': case 'T': togglePanel('toc'); break
        case 'b': case 'B': togglePanel('bookmarks'); break
        case '/': e.preventDefault(); openPanel('search'); break
        case '+': case '=': run('bigger'); break
        case '-': run('smaller'); break
    }
}

// ---------------------------------------------------------------- wiring
let info = {}
async function start() {
    if (WEB) setupWeb()
    info = await api('info').catch(() => ({}))
    try { settings = { ...defaults, ...(await api('settings')) } } catch {}
    settings.focus = false // always start a session out of focus mode
    applySettings()
    autoNight()
    setInterval(autoNight, 60_000)
    await loadLibrary()
    await window.pagelightPending()
}

// Browser version: offline support, "Open with" from the Files app, and
// the Library settings that make sense without a Mac.
function setupWeb() {
    document.body.classList.add('web')
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {})
    if ('launchQueue' in window) {
        window.launchQueue.setConsumer(async params => {
            const files = await Promise.all((params.files ?? []).map(h => h.getFile()))
            if (!files.length) return
            const added = await store.addFiles(files).catch(e => { toast(e.message, 4000); return [] })
            if (added.length) {
                store.queueOpen([added[added.length - 1].id])
                await window.pagelightPending()
            }
        })
    }
    for (const el of $$('[title]')) el.title = keys(el.title)
    $('#keep-copies').closest('label').hidden = true
    $('#keep-hint').textContent = 'Books you open are saved inside PageLight on this computer, so they stay in your library even if you delete or move the original file. Removing a book from the library deletes PageLight’s saved copy only.'
    navigator.storage?.estimate?.().then(e => {
        if (e?.usage) $('#keep-status').textContent = `Your library uses ${(e.usage / 1048576).toFixed(0)} MB.`
    }).catch(() => {})
}

document.addEventListener('keydown', onKey)
document.addEventListener('wheel', e => { if (current && $('#desk').contains(e.target)) onWheel(e) }, { passive: false })
document.addEventListener('gesturestart', e => { if (current && $('#desk').contains(e.target)) onGesture(e) })
document.addEventListener('gesturechange', e => { if (current && $('#desk').contains(e.target)) onGesture(e) })

document.addEventListener('click', e => {
    const cmdEl = e.target.closest('[data-cmd]')
    if (cmdEl) { run(cmdEl.dataset.cmd); return }
    const more = e.target.closest('[data-more]')
    if (more) { e.stopPropagation(); const r = more.getBoundingClientRect(); bookMenu(more.dataset.more, r.left, r.bottom + 4); return }
    if (!e.target.closest('.menu')) closeMenus()
    const card = e.target.closest('.book, .continue')
    if (card) { openBook(card.dataset.id); return }
    if (!e.target.closest('#appearance') && !e.target.closest('[data-cmd=appearance]')) closePop()
    const tab = e.target.closest('.tabs button')
    if (tab) openPanel(tab.dataset.tab)
    const bm = e.target.closest('[data-bm]')
    const del = e.target.closest('[data-delbm]')
    if (del && current) {
        current.b.bookmarks.splice(+del.dataset.delbm, 1)
        renderBookmarks()
        $('#bm-btn').classList.toggle('on', isBookmarked())
        patchBook(current.id, { bookmarks: current.b.bookmarks })
    } else if (bm && current) {
        current.view.goTo(current.b.bookmarks[+bm.dataset.bm].cfi).catch(() => current.view.goToFraction(current.b.bookmarks[+bm.dataset.bm].fraction))
    }
    const paper = e.target.closest('.themes [data-paper]')
    if (paper) set('paper', paper.dataset.paper)
    const w = e.target.closest('[data-width]')
    if (w) set('width', +w.dataset.width)
    const fl = e.target.closest('[data-flow]')
    if (fl) set('flow', fl.dataset.flow)
    const c = e.target.closest('[data-cols]')
    if (c) set('cols', +c.dataset.cols)
    const sp = e.target.closest('[data-spread]')
    if (sp && sp.dataset.spread !== settings.spread) {
        set('spread', sp.dataset.spread)
        if (current?.view.isFixedLayout) { saveProgressNow(); const id = current.id; setTimeout(() => openBook(id), 100) }
    }
})
document.addEventListener('contextmenu', e => {
    const card = e.target.closest('.book')
    if (card) { e.preventDefault(); bookMenu(card.dataset.id, e.clientX, e.clientY) }
    else if (native && !e.target.closest('input')) e.preventDefault()
})

$('#lib-open').onclick = $('#empty-open').onclick = () => openDialog()
$('#keep-status').onclick = e => {
    const a = e.target.closest('[data-note]')?.dataset.note
    if (!a) return
    e.preventDefault()
    if (a === 'keepall') keepAll()
}
$('#lib-night').onclick = () => toggleNight()
$('#lib-filter').oninput = () => renderLibrary()
$('#lib-sort').onchange = e => { settings.sort = e.target.value; saveSettings(); renderLibrary() }
$('#progress').oninput = debounce(e => current?.view.goToFraction(parseFloat(e.target.value)), 60)
$('#search-form').onsubmit = e => { e.preventDefault(); runSearch($('#search-input').value) }
$('#font-size').oninput = e => set('fontSize', +e.target.value)
$('#font-family').onchange = e => set('fontFamily', e.target.value)
$('#line-height').oninput = e => set('lineHeight', +e.target.value)
$('#justify').onchange = e => set('justify', e.target.checked)
$('#hyphenate').onchange = e => set('hyphenate', e.target.checked)
$('#focus-dim').oninput = e => set('focusDim', +e.target.value)
$('#focus-hide').onchange = e => set('focusHide', e.target.checked)
$('#night-level').oninput = e => set('nightLevel', +e.target.value)
$('#night-pictures').onchange = e => set('nightPictures', e.target.checked)
$('#keep-copies').onchange = e => { set('keepCopies', e.target.checked); renderNote() }
$('#night-auto').onchange = e => { set('nightAuto', e.target.checked); autoNightState = null; autoNight() }

// drag and drop books onto the window
let dragDepth = 0
addEventListener('dragenter', e => { if (e.dataTransfer?.types?.includes('Files')) { dragDepth++; $('#drop').hidden = false } })
addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#drop').hidden = true } })
addEventListener('dragover', e => e.preventDefault())
addEventListener('drop', e => {
    e.preventDefault()
    dragDepth = 0
    $('#drop').hidden = true
    const files = [...(e.dataTransfer?.files ?? [])]
    if (files.length) uploadFiles(files)
})
addEventListener('resize', debounce(() => current && applyRenderer(), 150))
addEventListener('beforeunload', () => saveProgressNow())

start()
