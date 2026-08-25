/**
 * Content script: snapshot of interactive elements plus click/fill/press by
 * `data-vertragus-ref` (e1, e2, …). Refs are rewritten on every snapshot.
 */
const INTERACTIVE = 'a, button, input, textarea, select, [role="button"], [role="link"], [role="tab"], [contenteditable="true"]'

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== 'object') return
  try {
    if (message.type === 'snapshot') sendResponse(snapshot())
    else if (message.type === 'click') sendResponse(click(String(message.ref || '')))
    else if (message.type === 'fill') {
      sendResponse(fill(String(message.ref || ''), String(message.text || ''), Boolean(message.submit)))
    } else if (message.type === 'press') sendResponse(press(String(message.key || '')))
    else sendResponse({ error: 'unknown' })
  } catch (error) {
    sendResponse({ error: error instanceof Error ? error.message : String(error) })
  }
  return true
})

function snapshot() {
  document.querySelectorAll('[data-vertragus-ref]').forEach((node) => node.removeAttribute('data-vertragus-ref'))
  const nodes = [...document.querySelectorAll(INTERACTIVE)].filter(visible)
  const tree = nodes.map((node, index) => {
    const ref = `e${index + 1}`
    node.setAttribute('data-vertragus-ref', ref)
    return {
      ref,
      tag: node.tagName.toLowerCase(),
      role: node.getAttribute('role') || '',
      type: node.getAttribute('type') || '',
      name: node.getAttribute('name') || '',
      text: (node.innerText || node.getAttribute('aria-label') || node.getAttribute('placeholder') || '')
        .trim()
        .slice(0, 120),
      href: node.getAttribute('href') || '',
      value: 'value' in node ? String(node.value || '').slice(0, 80) : ''
    }
  })
  return { url: location.href, title: document.title, nodes: tree }
}

function visible(node) {
  const style = window.getComputedStyle(node)
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false
  const box = node.getBoundingClientRect()
  return box.width > 0 && box.height > 0
}

function byRef(ref) {
  const node = document.querySelector(`[data-vertragus-ref="${CSS.escape(ref)}"]`)
  if (!node) throw new Error(`unknown ref: ${ref}`)
  return node
}

function click(ref) {
  byRef(ref).click()
  return { ok: true, ref }
}

function fill(ref, text, submit) {
  const node = byRef(ref)
  node.focus()
  if ('value' in node) {
    const proto = Object.getOwnPropertyDescriptor(node.constructor.prototype, 'value')
    if (proto && proto.set) proto.set.call(node, text)
    else node.value = text
    node.dispatchEvent(new Event('input', { bubbles: true }))
    node.dispatchEvent(new Event('change', { bubbles: true }))
  } else if (node.isContentEditable) {
    node.textContent = text
    node.dispatchEvent(new Event('input', { bubbles: true }))
  }
  if (submit) node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  return { ok: true, ref }
}

function press(key) {
  const target = document.activeElement || document.body
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  target.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }))
  return { ok: true, key }
}
