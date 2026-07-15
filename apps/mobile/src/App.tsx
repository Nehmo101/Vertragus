import { useEffect, useMemo, useRef, useState } from 'react'
import type { OrchestratorSnapshot } from '@shared/orchestrator'
import type {
  ApprovalItem,
  DeviceInfo,
  PairingResult,
  RemoteCommandId,
  RemoteEventFrame
} from '@shared/remote'

type View = 'live' | 'approvals' | 'goal' | 'devices'
const TOKEN_KEY = 'orca.remote.deviceToken'

function pairingCode(): string {
  const query = window.location.hash.includes('?') ? window.location.hash.split('?')[1] : ''
  return new URLSearchParams(query).get('code') ?? ''
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }

async function api<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      Authorization: `Bearer ${token}`,
      ...init.headers
    }
  })
  const body = await response.json().catch(() => ({})) as { error?: string }
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
  return body as T
}

async function consumeSse(
  token: string,
  signal: AbortSignal,
  onFrame: (frame: RemoteEventFrame) => void
): Promise<void> {
  const response = await fetch('/stream', { headers: { Authorization: `Bearer ${token}` }, signal })
  if (!response.ok || !response.body) throw new Error(`Live-Stream nicht verfügbar (${response.status}).`)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (!signal.aborted) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
    let boundary = buffer.indexOf('\n\n')
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      const data = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n')
      if (data) {
        try { onFrame(JSON.parse(data) as RemoteEventFrame) } catch { /* Ignore malformed individual frames. */ }
      }
      boundary = buffer.indexOf('\n\n')
    }
  }
}

export default function App(): JSX.Element {
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY) ?? '')
  const [code, setCode] = useState(pairingCode)
  const [deviceName, setDeviceName] = useState(() => navigator.platform || 'Mobilgerät')
  const [view, setView] = useState<View>('live')
  const [snapshots, setSnapshots] = useState<Record<string, OrchestratorSnapshot>>({})
  const [approvals, setApprovals] = useState<ApprovalItem[]>([])
  const [devices, setDevices] = useState<DeviceInfo[]>([])
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState<string>()
  const [goal, setGoal] = useState('')
  const reconnect = useRef(0)

  const profiles = useMemo(() => [...new Set(Object.values(snapshots).map((snapshot) => snapshot.profileId).filter((id): id is string => Boolean(id)))], [snapshots])
  const [profileId, setProfileId] = useState('')
  useEffect(() => { if (!profileId && profiles[0]) setProfileId(profiles[0]) }, [profileId, profiles])

  useEffect(() => {
    if (!token) return
    const controller = new AbortController()
    let timer: number | undefined
    const connect = (): void => {
      void consumeSse(token, controller.signal, (frame) => {
        setConnected(true)
        reconnect.current = 0
        if (frame.type === 'snapshot') {
          const key = frame.snapshot.workspaceSessionId ?? frame.snapshot.profileId
          if (key) setSnapshots((current) => ({ ...current, [key]: frame.snapshot }))
        } else if (frame.type === 'approvals') setApprovals(frame.approvals)
      }).catch((value) => {
        if (controller.signal.aborted) return
        setConnected(false)
        setError(message(value))
        const delay = Math.min(30_000, 1_000 * 2 ** reconnect.current++)
        timer = window.setTimeout(connect, delay)
      })
    }
    connect()
    return () => { controller.abort(); if (timer) clearTimeout(timer) }
  }, [token])

  useEffect(() => {
    if (!token || view !== 'devices') return
    void api<{ devices: DeviceInfo[] }>('/devices', token).then((value) => setDevices(value.devices)).catch((value) => setError(message(value)))
  }, [token, view])

  const command = async (id: RemoteCommandId, args: unknown): Promise<void> => {
    setError(undefined)
    await api('/command', token, {
      method: 'POST',
      body: JSON.stringify({ id, args, requestId: crypto.randomUUID() })
    })
  }

  const pair = async (): Promise<void> => {
    setError(undefined)
    try {
      const response = await fetch('/pair', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: code.trim(), deviceName: deviceName.trim() })
      })
      const result = await response.json() as PairingResult & { error?: string }
      if (!response.ok) throw new Error(result.error ?? 'Pairing fehlgeschlagen.')
      localStorage.setItem(TOKEN_KEY, result.token)
      setToken(result.token)
      window.location.hash = '#/live'
    } catch (value) { setError(message(value)) }
  }

  if (!token) {
    return (
      <main className="pair-screen">
        <div className="orca-mark">O</div>
        <span className="eyebrow">Orca-Strator</span>
        <h1>Mission Control koppeln</h1>
        <p>Scanne den QR-Code im Desktop oder trage den einmaligen Pairing-Code ein.</p>
        {error && <div className="error">{error}</div>}
        <label>Pairing-Code<input value={code} onChange={(event) => setCode(event.target.value)} autoCapitalize="none" /></label>
        <label>Gerätename<input value={deviceName} onChange={(event) => setDeviceName(event.target.value)} maxLength={80} /></label>
        <button onClick={() => void pair()} disabled={!code.trim() || !deviceName.trim()}>Sicher koppeln</button>
        <small>Der Geräte-Token wird nur in dieser PWA gespeichert und nie an eine URL angehängt.</small>
      </main>
    )
  }

  return (
    <div className="app">
      <header>
        <div><span className="eyebrow">Orca-Strator</span><h1>Mission Control</h1></div>
        <span className={`connection ${connected ? 'online' : ''}`}>{connected ? 'Live' : 'Verbinde…'}</span>
      </header>
      {error && <div className="error" onClick={() => setError(undefined)}>{error}</div>}

      <main>
        {view === 'live' && <Live snapshots={Object.values(snapshots)} />}
        {view === 'approvals' && <Inbox approvals={approvals} command={command} />}
        {view === 'goal' && (
          <section>
            <span className="eyebrow">Neue Arbeit</span><h2>Ziel senden</h2>
            <p className="muted">Remote-Ziele werden immer mit <code>yoloMaster:false</code> über den vorhandenen Idea-Transfer gestartet.</p>
            <label>Workspace<select value={profileId} onChange={(event) => setProfileId(event.target.value)}>{profiles.map((id) => <option key={id}>{id}</option>)}</select></label>
            <label>Ziel<textarea value={goal} onChange={(event) => setGoal(event.target.value)} maxLength={8000} rows={9} placeholder="Was soll der Schwarm erreichen?" /></label>
            <button disabled={!profileId || !goal.trim()} onClick={() => void command('goal.submit', { profileId, text: goal }).then(() => setGoal('')).catch((value) => setError(message(value)))}>Ziel sicher senden</button>
          </section>
        )}
        {view === 'devices' && (
          <section>
            <span className="eyebrow">Sicherheit</span><h2>Geräte</h2>
            {devices.map((device) => <article className="device" key={device.id}><div><strong>{device.name}</strong><small>{device.capabilities.join(' · ')}</small></div><span>{device.revokedAt ? 'widerrufen' : 'aktiv'}</span></article>)}
            <button className="danger" onClick={() => void command('killSwitch.activate', {}).catch((value) => setError(message(value)))}>Master-Not-Aus</button>
          </section>
        )}
      </main>

      <nav>
        <Nav active={view === 'live'} label="Live" icon="⌁" onClick={() => setView('live')} />
        <Nav active={view === 'approvals'} label={`Inbox${approvals.length ? ` ${approvals.length}` : ''}`} icon="✓" onClick={() => setView('approvals')} />
        <Nav active={view === 'goal'} label="Ziel" icon="＋" onClick={() => setView('goal')} />
        <Nav active={view === 'devices'} label="Geräte" icon="⌾" onClick={() => setView('devices')} />
      </nav>
    </div>
  )
}

function Nav(props: { active: boolean; label: string; icon: string; onClick(): void }): JSX.Element {
  return <button className={props.active ? 'active' : ''} onClick={props.onClick}><span>{props.icon}</span>{props.label}</button>
}

function Live({ snapshots }: { snapshots: OrchestratorSnapshot[] }): JSX.Element {
  if (snapshots.length === 0) return <Empty title="Noch keine Live-Daten" text="Sobald ein Workspace läuft, erscheint sein DAG hier." />
  return <>{snapshots.map((snapshot) => <section key={snapshot.workspaceSessionId ?? snapshot.profileId} className="workspace"><span className="eyebrow">{snapshot.profileId}</span><h2>{snapshot.goal?.title ?? 'Workspace bereit'}</h2>{snapshot.pendingPlan && <div className="waiting">Wartet auf Plan-Freigabe</div>}<div className="dag">{snapshot.tasks.map((task) => <article key={task.id} className={`task status-${task.status}`}><div className="task-line"><strong>{task.title}</strong><span>{task.status}</span></div><small>{task.agentName ?? task.role}{task.lastAction ? ` · ${task.lastAction}` : ''}</small>{typeof task.progress === 'number' && <div className="progress"><i style={{ width: `${task.progress}%` }} /></div>}</article>)}</div></section>)}</>
}

function Inbox({ approvals, command }: { approvals: ApprovalItem[]; command(id: RemoteCommandId, args: unknown): Promise<void> }): JSX.Element {
  const [error, setError] = useState<string>()
  if (!approvals.length) return <Empty title="Alles entschieden" text="Es wartet derzeit kein Plan und keine blockierte Aufgabe." />
  const act = (id: RemoteCommandId, approval: ApprovalItem): void => {
    const args = { profileId: approval.profileId, sessionId: approval.workspaceSessionId }
    void command(id, args).catch((value) => setError(message(value)))
  }
  return <section><span className="eyebrow">Entscheidungen</span><h2>Approval-Inbox</h2>{error && <div className="error">{error}</div>}{approvals.map((approval) => <article className="approval" key={approval.id}><small>{approval.kind === 'plan-review' ? 'PLAN-REVIEW' : 'BLOCKIERT'}</small><h3>{approval.title}</h3><p>{approval.summary}</p><div className="actions">{approval.kind === 'plan-review' ? <><button onClick={() => act('plan.approve', approval)}>Freigeben</button><button className="secondary" onClick={() => act('plan.reject', approval)}>Ablehnen</button></> : <><button onClick={() => act('mode.enableAuto', approval)}>Auto aktivieren</button><button className="secondary" onClick={() => act('run.reset', approval)}>Lauf zurücksetzen</button></>}</div></article>)}</section>
}

function Empty({ title, text }: { title: string; text: string }): JSX.Element {
  return <section className="empty"><div>◌</div><h2>{title}</h2><p>{text}</p></section>
}

