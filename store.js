// PageLight for Chromebook (and any browser): the library lives in the
// browser's own storage (IndexedDB) instead of the Mac app's Go back end.
// It answers the same /api/... calls as the Mac app, so app.js works
// unchanged on both.

const DB = 'pagelight', VER = 1
let dbp
const db = () => dbp ??= new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, VER)
    r.onupgradeneeded = () => {
        const d = r.result
        for (const s of ['books', 'files', 'covers', 'kv'])
            if (!d.objectStoreNames.contains(s)) d.createObjectStore(s)
    }
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
})
const tx = async (store, mode, fn) => {
    const d = await db()
    return new Promise((resolve, reject) => {
        const t = d.transaction(store, mode)
        const req = fn(t.objectStore(store))
        t.oncomplete = () => resolve(req?.result)
        t.onerror = () => reject(t.error)
        t.onabort = () => reject(t.error ?? new Error('Storage is full'))
    })
}
const get = (s, k) => tx(s, 'readonly', st => st.get(k))
const put = (s, k, v) => tx(s, 'readwrite', st => st.put(v, k))
const del = (s, k) => tx(s, 'readwrite', st => st.delete(k))
const all = s => tx(s, 'readonly', st => st.getAll())

export const FORMATS = {
    epub: 'EPUB', pdf: 'PDF', mobi: 'MOBI', azw: 'MOBI', prc: 'MOBI',
    azw3: 'AZW3', kf8: 'AZW3', fb2: 'FB2', fbz: 'FB2', cbz: 'CBZ',
}
const extOf = name => (/\.([^.]+)$/.exec(name)?.[1] ?? '').toLowerCase()
const newID = () => [...crypto.getRandomValues(new Uint8Array(8))].map(b => b.toString(16).padStart(2, '0')).join('')

let pending = []
export const queueOpen = ids => { pending.push(...ids) }

// Keep the library safe from the browser clearing space.
navigator.storage?.persist?.().catch(() => {})

async function addFile(file) {
    const format = FORMATS[extOf(file.name)]
    if (!format) throw new Error(`PageLight can’t open “${file.name}”`)
    const books = await all('books')
    const same = books.find(b => b.name === file.name && b.size === file.size)
    if (same) return same
    const b = {
        id: newID(), path: file.name, name: file.name, format,
        title: file.name.replace(/\.[^.]+$/, ''), author: '',
        added: Date.now(), opened: 0, fraction: 0, location: '', page: '',
        cover: false, bookmarks: [], missing: false, kept: true, size: file.size,
    }
    await put('files', b.id, file)
    await put('books', b.id, b)
    return b
}

export async function addFiles(files) {
    const out = []
    for (const f of files) out.push(await addFile(f))
    return out
}

const json = v => v
// localApi answers the same calls as the Mac app's server.
export async function localApi(path, opts = {}) {
    const method = (opts.method || 'GET').toUpperCase()
    const [route, query = ''] = path.split('?')
    const parts = route.split('/')
    const body = opts.body
    const parse = () => typeof body === 'string' ? JSON.parse(body) : body
    switch (parts[0]) {
        case 'info': {
            const est = await navigator.storage?.estimate?.().catch(() => null)
            return { version: '1.0', native: false, web: true, used: est?.usage ?? 0 }
        }
        case 'library': {
            const books = await all('books')
            return books.sort((a, b) => Math.max(b.opened, b.added) - Math.max(a.opened, a.added))
        }
        case 'upload': {
            const name = new URLSearchParams(query).get('name') ?? body?.name ?? 'book'
            const file = body instanceof File ? body : new File([body], name)
            return [await addFile(file)]
        }
        case 'pending': {
            const p = pending
            pending = []
            return p
        }
        case 'settings':
            if (method === 'PUT' || method === 'POST') { await put('kv', 'settings', parse()); return { ok: true } }
            return (await get('kv', 'settings')) ?? {}
        case 'chrome':
            return { ok: true }
        case 'book': {
            const id = parts[1], rest = parts.slice(2).join('/')
            const b = await get('books', id)
            if (!b) throw new Error('This book is no longer in the library')
            if (rest === 'file') {
                const blob = await get('files', id)
                if (!blob) throw new Error('The book file is missing from PageLight’s storage')
                return { blob: async () => blob }
            }
            if (rest === 'cover') {
                if (method === 'GET') return { blob: async () => get('covers', id) }
                await put('covers', id, body)
                b.cover = true
                await put('books', id, b)
                return { ok: true }
            }
            if (rest === 'keep' || rest === 'reveal') return b
            if (method === 'DELETE') {
                await del('books', id); await del('files', id); await del('covers', id)
                return { ok: true }
            }
            if (method === 'PATCH' || method === 'POST') {
                const patch = parse() ?? {}
                for (const k of ['title', 'author', 'fraction', 'location', 'page', 'opened', 'bookmarks'])
                    if (k in patch) b[k] = patch[k]
                await put('books', id, b)
                return b
            }
            return b
        }
    }
    throw new Error('Not available in the web version: ' + path)
}

export const coverBlob = id => get('covers', id)
