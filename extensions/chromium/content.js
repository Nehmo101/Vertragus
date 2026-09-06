/**
 * Content script: snapshot of interactive elements plus click/fill/press by
 * `data-vertragus-ref` (e1, e2, …). Refs are rewritten on every snapshot.
 */
const documentGeneration = Array.from(crypto.getRandomValues(new Uint8Array(16)), (value) => value.toString(16).padStart(2, '0')).join('')
let snapshotGeneration = 0
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
  snapshotGeneration += 1
  const nodes = [...document.querySelectorAll(INTERACTIVE)].filter(visible)
  const tree = nodes.map((node, index) => {
    const ref = `${documentGeneration}-${snapshotGeneration}-e${index + 1}`
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
      value: node.type !== 'password' && 'value' in node ? String(node.value || '').slice(0, 80) : ''
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
  else throw new Error('element is not editable')
  if (submit) return submitForm(node)
  return { ok: true, ref }
}

function submitForm(node) {
  if (!node.form) throw new Error('focused element has no form')
  if (!node.form.checkValidity()) return { ok: false, error: 'form_invalid' }
  node.form.requestSubmit()
  return { ok: true, action: 'requestSubmit' }
}

function press(key) {
  const target = document.activeElement || document.body
  if (key === 'Tab' || key === 'Shift+Tab') {
    const nodes = [...document.querySelectorAll(INTERACTIVE + ', [tabindex]')]
      .filter((node) => visible(node) && !node.disabled && node.tabIndex >= 0)
      .sort((a, b) => (a.tabIndex || Infinity) - (b.tabIndex || Infinity))
    if (!nodes.length) throw new Error('no focusable element')
    const delta = key === 'Tab' ? 1 : -1
    const current = nodes.indexOf(target)
    const index = current === -1 && delta < 0 ? 0 : current
    const next = nodes[(index + delta + nodes.length) % nodes.length]
    next.focus()
    return { ok: document.activeElement === next, key }
  }
  if (key === 'Enter') {
    if (target instanceof HTMLTextAreaElement) {
      target.setRangeText('\n', target.selectionStart, target.selectionEnd, 'end')
      target.dispatchEvent(new Event('input', { bubbles: true }))
      return { ok: true, action: 'insertLineBreak' }
    }
    if (target.matches('button, a[href], input[type="submit"], input[type="button"]')) {
      target.click()
      return { ok: true, action: 'click' }
    }
    return submitForm(target)
  }
  throw new Error(`unsupported key: ${key}; only Tab, Shift+Tab and Enter have implemented effects`)
}
