import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { cleanProjectConfig, suspendProjectConfig, writeProjectConfig } from './projectConfigOverlay'

const roots: string[] = []
afterEach(()=>{for(const root of roots.splice(0)) rmSync(root,{recursive:true,force:true})})
function path(name='config.json'):string {const root=mkdtempSync(join(tmpdir(),'vertragus-overlay-'));roots.push(root);return join(root,name)}

it('restores absence or exact user bytes for an untouched host config',()=>{
  const file=path()
  writeProjectConfig(file,'{"server":{"url":"host"}}')
  expect(cleanProjectConfig(file,readFileSync(file,'utf8'))).toBeUndefined()
  expect(suspendProjectConfig(file)).toBeUndefined()
  const user=path();writeFileSync(user,'{"theme": "light"}')
  writeProjectConfig(user,'{"theme":"light","host":true}')
  expect(cleanProjectConfig(user,readFileSync(user,'utf8'))).toBe('{"theme": "light"}')
})

it('keeps nested user edits and deletes injected keys across repeated attaches',()=>{
  const file=path();writeFileSync(file,JSON.stringify({server:{url:'user'},theme:'light'}))
  writeProjectConfig(file,JSON.stringify({server:{url:'host',headers:{Authorization:'secret'}},theme:'light'}))
  const edited={server:{url:'host',headers:{Authorization:'secret',custom:'keep'}},theme:'dark'}
  writeFileSync(file,JSON.stringify(edited))
  const cleaned=JSON.parse(cleanProjectConfig(file,JSON.stringify(edited))!)
  expect(cleaned).toEqual({server:{url:'user',headers:{custom:'keep'}},theme:'dark'})
  writeProjectConfig(file,JSON.stringify({...edited,hostGeneration:2}))
  expect(JSON.parse(cleanProjectConfig(file,readFileSync(file,'utf8'))!)).toEqual(cleaned)
})

it('preserves explicit user deletion and replacement of unrelated structured settings',()=>{
  const file=path();writeFileSync(file,JSON.stringify({values:[1],user:{old:true}}))
  writeProjectConfig(file,JSON.stringify({values:[1,2],user:{old:true},host:true}))
  expect(JSON.parse(cleanProjectConfig(file,JSON.stringify({values:[3],user:null,host:true}))!)).toEqual({values:[3],user:null})
})

it('refuses unknown or relocated host credentials rather than writing their token into an index blob',()=>{
  const file=path()
  expect(cleanProjectConfig(file,'{"user":true}')).toBe('{"user":true}')
  expect(()=>cleanProjectConfig(file,'{"vertragus":"http://localhost?token=secret"}')).toThrow(/no known host overlay/)
  writeProjectConfig(file,'{"vertragus":"http://localhost?token=secret"}')
  expect(()=>cleanProjectConfig(file,'{"vertragus":"http://localhost?token=secret","copied":"secret"}')).toThrow(/credential remains/)
  writeFileSync(file,'{"vertragus":"http://localhost?token=secret","copied":"secret"}')
  expect(()=>writeProjectConfig(file,'{"vertragus":"replacement"}')).toThrow(/credential remains/)
})

it('handles a corrupt file at a repeated attach while failing reads closed',()=>{
  const file=path();writeProjectConfig(file,'{"host":true}')
  writeFileSync(file,'{broken')
  writeProjectConfig(file,'{"host":true}')
  expect(cleanProjectConfig(file,'{"host":true}')).toBe('{broken')
  expect(()=>cleanProjectConfig(file,'{"host":true,"user":1}')).toThrow(SyntaxError)
  const dir=path();mkdirSync(dir)
  expect(()=>writeProjectConfig(dir,'{}')).toThrow()
})

it('restores TOML host tables while retaining an unrelated user section',()=>{
  const file=path('config.toml')
  const original='theme = "light"\n\n[user]\nvalue = 1\n'
  const injected=original+'\n[mcp_servers.vertragus]\nurl = "http://localhost?token=secret"\n'
  writeFileSync(file,original);writeProjectConfig(file,injected)
  const edited=injected.replace('value = 1','value = 2')
  expect(cleanProjectConfig(file,edited)).toContain('value = 2')
  expect(cleanProjectConfig(file,edited)).not.toContain('secret')
  writeFileSync(file,edited)
  const restore=suspendProjectConfig(file)!
  expect(readFileSync(file,'utf8')).not.toContain('secret')
  writeFileSync(file,readFileSync(file,'utf8').replace('value = 2','value = 3'))
  restore()
  expect(readFileSync(file,'utf8')).toContain('secret')
  expect(cleanProjectConfig(file,readFileSync(file,'utf8'))).toContain('value = 3')
})

it('suspension is harmless for missing paths and preserves user JSON changes from a merge',()=>{
  expect(suspendProjectConfig(path())).toBeUndefined()
  const file=path();writeFileSync(file,'{"user":1}')
  writeProjectConfig(file,'{"user":1,"host":true}')
  const restore=suspendProjectConfig(file)!
  writeFileSync(file,'{"user":2}')
  restore()
  expect(JSON.parse(readFileSync(file,'utf8'))).toEqual({user:2,host:true})
  const again=suspendProjectConfig(file)!
  again()
  expect(JSON.parse(cleanProjectConfig(file,readFileSync(file,'utf8'))!)).toEqual({user:2})
  rmSync(file)
  expect(suspendProjectConfig(file)).toBeUndefined()
})

it('reattaches only host keys when an incoming merge deletes the tracked config',()=>{
  const file=path();writeFileSync(file,'{"user":1}')
  writeProjectConfig(file,'{"user":1,"host":true}')
  const restore=suspendProjectConfig(file)!
  rmSync(file)
  restore()
  expect(JSON.parse(readFileSync(file,'utf8'))).toEqual({host:true})
  expect(cleanProjectConfig(file,readFileSync(file,'utf8'))).toBeUndefined()
})

it('refuses an altered TOML host table instead of silently retaining its credential',()=>{
  const file=path('config.toml')
  writeFileSync(file,'theme = "light"\n')
  writeProjectConfig(file,'theme = "light"\n[mcp_servers.vertragus]\nurl = "http://localhost?token=secret"\n')
  const altered=readFileSync(file,'utf8').replace('url =','extra = 1\nurl =')
  expect(()=>cleanProjectConfig(file,altered)).toThrow(/credential remains/)
})
