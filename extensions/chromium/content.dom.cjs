const { app, BrowserWindow } = require('electron')
const { readFileSync } = require('node:fs')
const assert = require('node:assert/strict')
app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
  await win.loadURL('data:text/html,' + encodeURIComponent('<form><input id="first" value="alice"><input id="password" type="password" value="synthetic-secret"><button>Submit</button></form>'))
  const source = readFileSync(require('node:path').join(__dirname, 'content.js'), 'utf8')
  const result = await win.webContents.executeJavaScript(`(() => {
    let handler;
    window.chrome = {runtime:{onMessage:{addListener(fn){handler=fn}}}};
    let submitted = 0;
    document.querySelector('form').addEventListener('submit', event => { event.preventDefault(); submitted++; });
    ${source}
    const call = message => { let response; handler(message, {}, value => { response=value }); return response; };
    const first = call({type:'snapshot'});
    document.querySelector('#first').focus();
    const tab = call({type:'press', key:'Tab'});
    const focused = document.activeElement.id;
    const filled = call({type:'fill', ref:first.nodes[0].ref, text:'bob', submit:true});
    call({type:'snapshot'});
    const stale = call({type:'click', ref:first.nodes[0].ref});
    const unsupported = call({type:'press', key:'ArrowDown'});
    return {first, tab, focused, filled, submitted, stale, unsupported};
  })()`)
  assert(!JSON.stringify(result.first.nodes).includes('synthetic-secret'))
  assert.equal(result.focused, 'password')
  assert.equal(result.tab.ok, true)
  assert.equal(result.filled.ok, true)
  assert.equal(result.submitted, 1)
  assert.match(result.stale.error, /unknown ref/)
  assert.match(result.unsupported.error, /unsupported key/)
  win.destroy()
  app.quit()
}).catch(error => { console.error(error); app.exit(1) })

