/**
 * MV3 service worker: one WebSocket to Vertragus `/browser`, command dispatch
 * into chrome.tabs / chrome.scripting. Protocol:
 *   { id, type: 'command', command, params } → { id, type: 'result', ok, result|error }
 */
const COMMANDS = ['tabs', 'navigate', 'snapshot', 'click', 'fill', 'press', 'screenshot']

let socket = null
let pairingUrl = ''

chrome.runtime.onInstalled.addListener(() => connectFromStore())
chrome.runtime.onStartup.addListener(() => connectFromStore())

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.pairingUrl) return
  pairingUrl = String(changes.pairingUrl.newValue || '')
  reconnect()
})

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== 'object') return
  if (message.type === 'status') {
    sendResponse({
      connected: Boolean(socket && socket.readyState === WebSocket.OPEN),
      pairingUrl
    })
    return true
  }
  if (message.type === 'pair' && typeof message.url === 'string') {
    chrome.storage.local.set({ pairingUrl: message.url }, () => {
      pairingUrl = message.url
      reconnect()
      sendResponse({ ok: true })
    })
    return true
  }
})

function connectFromStore() {
  chrome.storage.local.get(['pairingUrl'], (stored) => {
    pairingUrl = typeof stored.pairingUrl === 'string' ? stored.pairingUrl : ''
    reconnect()
  })
}

function reconnect() {
  if (socket) {
    try {
      socket.close()
    } catch {
      /* ignore */
    }
    socket = null
  }
  if (!pairingUrl) return
  let url
  try {
    url = new URL(pairingUrl)
  } catch {
    return
  }
  if (url.protocol !== 'http:' && url.protocol !== 'ws:') return
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') return
  if (url.pathname.replace(/\/$/, '') !== '/browser') return
  const wsUrl = `ws://${url.host}${url.pathname}${url.search}`
  const next = new WebSocket(wsUrl)
  socket = next
  next.addEventListener('open', () => {
    try {
      next.send(JSON.stringify({ type: 'hello', client: 'vertragus-chromium' }))
    } catch {
      /* ignore */
    }
  })
  next.addEventListener('message', (event) => {
    void handleFrame(String(event.data))
  })
  next.addEventListener('close', () => {
    if (socket === next) socket = null
    if (pairingUrl) setTimeout(connectFromStore, 2_000)
  })
  next.addEventListener('error', () => {
    try {
      next.close()
    } catch {
      /* ignore */
    }
  })
}

async function handleFrame(raw) {
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return
  }
  if (!parsed || parsed.type !== 'command' || typeof parsed.id !== 'string') return
  const command = parsed.command
  const params = parsed.params && typeof parsed.params === 'object' ? parsed.params : {}
  try {
    if (!COMMANDS.includes(command)) throw new Error(`unknown command: ${command}`)
    const result = await dispatch(command, params)
    reply(parsed.id, { ok: true, result })
  } catch (error) {
    reply(parsed.id, { ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}

function reply(id, payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return
  socket.send(JSON.stringify({ id, type: 'result', ...payload }))
}

async function dispatch(command, params) {
  if (command === 'tabs') return listTabs()
  if (command === 'navigate') return navigate(params)
  if (command === 'snapshot') return tabMessage('snapshot', params)
  if (command === 'click') return tabMessage('click', params)
  if (command === 'fill') return tabMessage('fill', params)
  if (command === 'press') return tabMessage('press', params)
  if (command === 'screenshot') return screenshot(params)
  throw new Error(`unknown command: ${command}`)
}

async function listTabs() {
  const tabs = await chrome.tabs.query({})
  return {
    tabs: tabs
      .filter((tab) => typeof tab.id === 'number')
      .map((tab) => ({
        id: tab.id,
        title: tab.title || '',
        url: tab.url || '',
        active: Boolean(tab.active)
      }))
  }
}

async function navigate(params) {
  const url = String(params.url || '')
  if (!/^https?:\/\//i.test(url)) throw new Error('url must be http(s)')
  const tabId = Number(params.tabId)
  if (Number.isInteger(tabId) && tabId > 0) {
    const tab = await chrome.tabs.update(tabId, { url, active: true })
    return { id: tab.id, url: tab.url, title: tab.title }
  }
  const tab = await chrome.tabs.create({ url, active: true })
  return { id: tab.id, url: tab.url, title: tab.title }
}

async function resolveTabId(params) {
  const given = Number(params.tabId)
  if (Number.isInteger(given) && given > 0) return given
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  if (!active || typeof active.id !== 'number') throw new Error('no active tab')
  return active.id
}

async function tabMessage(type, params) {
  const tabId = await resolveTabId(params)
  try {
    return await chrome.tabs.sendMessage(tabId, { type, ...params })
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] })
    return await chrome.tabs.sendMessage(tabId, { type, ...params })
  }
}

async function screenshot(params) {
  const tabId = await resolveTabId(params)
  const tab = await chrome.tabs.get(tabId)
  if (typeof tab.windowId === 'number') {
    await chrome.windows.update(tab.windowId, { focused: true })
  }
  await chrome.tabs.update(tabId, { active: true })
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' })
  const comma = dataUrl.indexOf(',')
  return { mimeType: 'image/png', data: comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl }
}
