const statusEl = document.getElementById('status')
const urlEl = document.getElementById('url')
const saveEl = document.getElementById('save')

function paint(state) {
  statusEl.textContent = state.connected ? 'Connected' : 'Not connected'
  statusEl.className = state.connected ? 'ok' : ''
  if (state.pairingUrl && !urlEl.value) urlEl.value = state.pairingUrl
}

chrome.runtime.sendMessage({ type: 'status' }, (response) => {
  if (response) paint(response)
})

saveEl.addEventListener('click', () => {
  const url = urlEl.value.trim()
  if (!url) return
  chrome.runtime.sendMessage({ type: 'pair', url }, () => {
    chrome.runtime.sendMessage({ type: 'status' }, (response) => {
      if (response) paint(response)
    })
  })
})
