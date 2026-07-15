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
const DEVICE_KEY = 'orca.remote.device'

function pairingCode(): string {
  const query = window.location.hash.includes('?') ? window.location.hash.split('?')[1] : ''
  return new URLSearchParams(query).get('code') ?? ''
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }

function initialView(): View {
  const route = window.location.hash.split('?')[0]
  if (route === '#/approvals') return 'approvals'
  if (route === '#/goal') return 'goal'
  if (route === '#/devices') return 'devices'
  return 'live'
}

function vapidBytes(value: string): ArrayBuffer {
  const padding = '='.repeat((4 - value.length % 4) % 4)
  const raw = atob((value + padding).replace(/-/g, '+').replace(/_/g, '/'))
  const bytes = new Uint8Array(raw.length)
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index)
  return bytes.buffer
}

async function blobBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

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
  const [view, setView] = useState<View>(initialView)
  const [snapshots, setSnapshots] = useState<Record<string, OrchestratorSnapshot>>({})
  const [approvals, setApprovals] = useState<ApprovalItem[]>([])
  const [devices, setDevices] = useState<DeviceInfo[]>([])
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState<string>()
  const [goal, setGoal] = useState('')
  const [recording, setRecording] = useState(false)
  const mediaRecorder = useRef<MediaRecorder>()
  const mediaChunks = useRef<Blob[]>([])
  const mediaStartedAt = useRef(0)
  const reconnect = useRef(0)
  const socketRef = useRef<WebSocket>()
  const commandWaiters = useRef(new Map<string, {
    resolve(value: unknown): void
    reject(error: Error): void
    timer: number
  }>())

  const profiles = useMemo(() => {
    let savedId = ''
    try { savedId = (JSON.parse(localStorage.getItem(DEVICE_KEY) ?? '{}') as DeviceInfo).id ?? '' } catch { /* no saved device */ }
    const scoped = devices.find((device) => device.id === savedId)?.scopes.map((scope) => scope.profileId) ?? []
    return [...new Set([
      ...Object.values(snapshots).map((snapshot) => snapshot.profileId).filter((id): id is string => Boolean(id)),
      ...scoped
    ])]
  }, [devices, snapshots])
  const [profileId, setProfileId] = useState('')
  useEffect(() => { if (!profileId && profiles[0]) setProfileId(profiles[0]) }, [profileId, profiles])

  useEffect(() => {
    if (!token) return
    let timer: number | undefined
    let closed = false
    let fallbackController: AbortController | undefined
    let websocketFailures = 0
    let usingSse = false
    const handleFrame = (frame: RemoteEventFrame): void => {
      setConnected(true)
      reconnect.current = 0
      if (frame.type === 'snapshot') {
        const key = frame.snapshot.workspaceSessionId ?? frame.snapshot.profileId
        if (key) setSnapshots((current) => ({ ...current, [key]: frame.snapshot }))
      } else if (frame.type === 'approvals') setApprovals(frame.approvals)
    }
    const startSse = (): void => {
      if (closed || usingSse) return
      usingSse = true
      socketRef.current = undefined
      fallbackController = new AbortController()
      void consumeSse(token, fallbackController.signal, handleFrame).catch((value) => {
        if (closed || fallbackController?.signal.aborted) return
        usingSse = false
        setConnected(false)
        setError(message(value))
        const delay = Math.min(30_000, 1_000 * 2 ** reconnect.current++)
        timer = window.setTimeout(startSse, delay)
      })
    }
    const connect = (): void => {
      if (typeof WebSocket === 'undefined') return startSse()
      const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const socket = new WebSocket(`${scheme}//${window.location.host}/ws`, [
        'orca-v1', `orca-bearer.${token}`
      ])
      socketRef.current = socket
      socket.onopen = () => {
        setConnected(true)
        reconnect.current = 0
        websocketFailures = 0
      }
      socket.onmessage = (event) => {
        try {
          const value = JSON.parse(String(event.data)) as RemoteEventFrame | {
            type: 'command-result'; requestId?: string; ok: boolean; result?: unknown; error?: string
          }
          if (value.type === 'command-result') {
            const waiter = value.requestId ? commandWaiters.current.get(value.requestId) : undefined
            if (!waiter) return
            clearTimeout(waiter.timer)
            commandWaiters.current.delete(value.requestId!)
            if (value.ok) waiter.resolve(value.result)
            else waiter.reject(new Error(value.error ?? 'Remote command failed.'))
            return
          }
          handleFrame(value)
        } catch { /* Ignore one malformed frame; the authenticated channel stays usable. */ }
      }
      socket.onclose = () => {
        if (closed) return
        if (socketRef.current === socket) socketRef.current = undefined
        setConnected(false)
        for (const waiter of commandWaiters.current.values()) {
          clearTimeout(waiter.timer)
          waiter.reject(new Error('Live-Kanal wurde getrennt.'))
        }
        commandWaiters.current.clear()
        websocketFailures += 1
        if (websocketFailures >= 2) return startSse()
        const delay = Math.min(30_000, 1_000 * 2 ** reconnect.current++)
        timer = window.setTimeout(connect, delay)
      }
      socket.onerror = () => setConnected(false)
    }
    connect()
    return () => {
      closed = true
      fallbackController?.abort()
      socketRef.current?.close()
      if (timer) clearTimeout(timer)
    }
  }, [token])

  useEffect(() => {
    if (!token) return
    void api<{ devices: DeviceInfo[] }>('/devices', token)
      .then((value) => setDevices(value.devices))
      .catch((value) => setError(message(value)))
  }, [token])

  useEffect(() => {
    if (!token || view !== 'devices') return
    void api<{ devices: DeviceInfo[] }>('/devices', token).then((value) => setDevices(value.devices)).catch((value) => setError(message(value)))
  }, [token, view])

  const command = async (id: RemoteCommandId, args: unknown): Promise<unknown> => {
    setError(undefined)
    const socket = socketRef.current
    if (socket?.readyState === WebSocket.OPEN) {
      const requestId = crypto.randomUUID()
      return new Promise<unknown>((resolve, reject) => {
        const timer = window.setTimeout(() => {
          commandWaiters.current.delete(requestId)
          reject(new Error('Remote command timed out.'))
        }, 15_000)
        commandWaiters.current.set(requestId, { resolve, reject, timer })
        socket.send(JSON.stringify({ id, args, requestId }))
      })
    }
    const response = await api<{ result: unknown }>('/command', token, {
      method: 'POST',
      body: JSON.stringify({ id, args, requestId: crypto.randomUUID() })
    })
    return response.result
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
      localStorage.setItem(DEVICE_KEY, JSON.stringify(result.device))
      setToken(result.token)
      window.location.hash = '#/live'
    } catch (value) { setError(message(value)) }
  }

  const currentDevice = useMemo(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(DEVICE_KEY) ?? '{}') as DeviceInfo
      return devices.find((device) => device.id === saved.id) ?? saved
    } catch { return undefined }
  }, [devices])
  const goalProfiles = useMemo(() => profiles.filter((id) =>
    currentDevice?.scopes.some((scope) => scope.profileId === id && scope.allowGoalSubmit)
  ), [currentDevice, profiles])
  useEffect(() => {
    if (!goalProfiles.includes(profileId)) setProfileId(goalProfiles[0] ?? '')
  }, [goalProfiles, profileId])

  const enablePush = async (): Promise<void> => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error('Web-Push wird auf diesem Gerät nicht unterstützt.')
    const permission = await Notification.requestPermission()
    if (permission !== 'granted') throw new Error('Benachrichtigungen wurden nicht erlaubt.')
    const { publicKey } = await api<{ publicKey: string }>('/push/vapid-key', token)
    const registration = await navigator.serviceWorker.ready
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: vapidBytes(publicKey)
    })
    await api('/push/subscribe', token, {
      method: 'POST', body: JSON.stringify(subscription.toJSON())
    })
  }

  const toggleSpeech = async (): Promise<void> => {
    if (recording) {
      mediaRecorder.current?.stop()
      return
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      throw new Error('Audioaufnahme wird auf diesem Gerät nicht unterstützt.')
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    const recorder = new MediaRecorder(stream)
    mediaChunks.current = []
    mediaStartedAt.current = Date.now()
    recorder.ondataavailable = (event) => { if (event.data.size > 0) mediaChunks.current.push(event.data) }
    recorder.onstop = () => {
      const blob = new Blob(mediaChunks.current, { type: recorder.mimeType || 'audio/webm' })
      const durationMs = Date.now() - mediaStartedAt.current
      stream.getTracks().forEach((track) => track.stop())
      setRecording(false)
      void blobBase64(blob)
        .then((audioBase64) => api<{ ok: boolean; text?: string; message?: string }>('/speech/transcribe', token, {
          method: 'POST',
          body: JSON.stringify({ mimeType: blob.type || 'audio/webm', durationMs, audioBase64 })
        }))
        .then((result) => {
          if (!result.ok || !result.text) throw new Error(result.message ?? 'Transkription fehlgeschlagen.')
          setGoal(result.text)
        })
        .catch((value) => setError(message(value)))
    }
    mediaRecorder.current = recorder
    recorder.start()
    setRecording(true)
    window.setTimeout(() => { if (recorder.state === 'recording') recorder.stop() }, 120_000)
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
        {view === 'live' && <Live
          snapshots={Object.values(snapshots)}
          command={command}
          capabilities={currentDevice?.capabilities ?? []}
        />}
        {view === 'approvals' && <Inbox approvals={approvals} command={command} />}
        {view === 'goal' && (
          <section>
            <span className="eyebrow">Neue Arbeit</span><h2>Ziel senden</h2>
            <p className="muted">Remote-Ziele werden immer mit <code>yoloMaster:false</code> über den vorhandenen Idea-Transfer gestartet.</p>
            <label>Workspace<select value={profileId} onChange={(event) => setProfileId(event.target.value)}>{goalProfiles.map((id) => <option key={id}>{id}</option>)}</select></label>
            <label>Ziel<textarea value={goal} onChange={(event) => setGoal(event.target.value)} maxLength={8000} rows={9} placeholder="Was soll der Schwarm erreichen?" /></label>
            {currentDevice?.capabilities?.includes('speech') && <button className="secondary speech" onClick={() => void toggleSpeech().catch((value) => setError(message(value)))}>{recording ? 'Aufnahme stoppen' : 'Ziel sprechen'}</button>}
            <button disabled={!profileId || !goal.trim()} onClick={() => void command('goal.submit', { profileId, text: goal }).then(() => setGoal('')).catch((value) => setError(message(value)))}>Ziel sicher senden</button>
          </section>
        )}
        {view === 'devices' && (
          <section>
            <span className="eyebrow">Sicherheit</span><h2>Geräte</h2>
            {devices.map((device) => <article className="device" key={device.id}><div><strong>{device.name} · {device.actor.displayName}</strong><small>{device.capabilities.join(' · ')} · {device.scopes.length} Scope(s)</small></div><span>{device.revokedAt ? 'widerrufen' : 'aktiv'}</span></article>)}
            {currentDevice?.capabilities?.includes('push') && <button onClick={() => void enablePush().catch((value) => setError(message(value)))}>Push-Benachrichtigungen aktivieren</button>}
            <p className="muted">Auf iOS funktioniert Web-Push nur für eine zum Home-Bildschirm hinzugefügte PWA. In-App-Badges bleiben immer aktiv.</p>
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

function Live({ snapshots, command, capabilities }: {
  snapshots: OrchestratorSnapshot[]
  command(id: RemoteCommandId, args: unknown): Promise<unknown>
  capabilities: DeviceInfo['capabilities']
}): JSX.Element {
  const [maxTokens, setMaxTokens] = useState('')
  const [maxCost, setMaxCost] = useState('')
  const [error, setError] = useState<string>()
  if (snapshots.length === 0) return <Empty title="Noch keine Live-Daten" text="Sobald ein Workspace läuft, erscheint sein DAG hier." />
  const run = (id: RemoteCommandId, args: unknown): void => {
    setError(undefined)
    void command(id, args).catch((value) => setError(message(value)))
  }
  return <>{error && <div className="error">{error}</div>}{snapshots.map((snapshot) => {
    const scope = { profileId: snapshot.profileId!, sessionId: snapshot.workspaceSessionId! }
    return <section key={snapshot.workspaceSessionId ?? snapshot.profileId} className="workspace">
      <span className="eyebrow">{snapshot.profileId}</span><h2>{snapshot.goal?.title ?? 'Workspace bereit'}</h2>
      {snapshot.budget && <div className={`budget ${snapshot.budget.exceeded ? 'exceeded' : ''}`}>
        <strong>{snapshot.budget.tokens.toLocaleString()} Token · ${snapshot.budget.costUsd.toFixed(2)}</strong>
        <small>Caps: {snapshot.budget.caps.maxTokens ?? '–'} Token · ${snapshot.budget.caps.maxCostUsd ?? '–'}</small>
      </div>}
      {capabilities.includes('budget') && <div className="budget-form">
        <input inputMode="numeric" value={maxTokens} onChange={(event) => setMaxTokens(event.target.value)} placeholder="Token-Cap" />
        <input inputMode="decimal" value={maxCost} onChange={(event) => setMaxCost(event.target.value)} placeholder="USD-Cap" />
        <button onClick={() => run('budget.setCaps', {
          ...scope,
          maxTokens: maxTokens ? Number(maxTokens) : null,
          maxCostUsd: maxCost ? Number(maxCost) : null
        })}>Caps setzen</button>
      </div>}
      {snapshot.pendingPlan && <div className="waiting">Wartet auf Plan-Freigabe · {snapshot.pendingPlan.plan.tasks.length} Tasks
        {capabilities.includes('replan') && snapshot.pendingPlan.plan.maxParallel > 1 &&
          <button className="secondary" onClick={() => run('plan.replan', { ...scope, removeTaskIds: [], maxParallel: 1 })}>Parallelität auf 1</button>}
      </div>}
      <div className="dag">{snapshot.tasks.map((task) => <article key={task.id} className={`task status-${task.status}`}>
        <div className="task-line"><strong>{task.title}</strong><span>{task.status}</span></div>
        <small>{task.agentName ?? task.role}{task.lastAction ? ` · ${task.lastAction}` : ''}</small>
        {capabilities.includes('task-control') && (task.status === 'running' || task.status === 'queued') &&
          <button className="secondary task-control" onClick={() => run('task.pause', { ...scope, taskId: task.id })}>Pausieren</button>}
        {capabilities.includes('task-control') && task.status === 'paused' &&
          <button className="secondary task-control" onClick={() => run('task.resume', { ...scope, taskId: task.id })}>Fortsetzen</button>}
        {typeof task.progress === 'number' && <div className="progress"><i style={{ width: `${task.progress}%` }} /></div>}
      </article>)}</div>
    </section>
  })}</>
}

function Inbox({ approvals, command }: { approvals: ApprovalItem[]; command(id: RemoteCommandId, args: unknown): Promise<unknown> }): JSX.Element {
  const [error, setError] = useState<string>()
  const [diff, setDiff] = useState<{ title: string; value: string }>()
  if (!approvals.length) return <Empty title="Alles entschieden" text="Es wartet derzeit kein Plan und keine blockierte Aufgabe." />
  const act = (id: RemoteCommandId, approval: ApprovalItem): void => {
    const args = approval.permission
      ? { profileId: approval.profileId, sessionId: approval.workspaceSessionId, permissionId: approval.permission.id }
      : { profileId: approval.profileId, sessionId: approval.workspaceSessionId }
    void command(id, args).catch((value) => setError(message(value)))
  }
  const showDiff = (approval: ApprovalItem): void => {
    if (!approval.task) return
    void command('task.diff', {
      profileId: approval.profileId,
      sessionId: approval.workspaceSessionId,
      taskId: approval.task.id
    }).then((result) => {
      const value = result as { diff?: string }
      setDiff({ title: approval.task!.title, value: value.diff ?? 'Kein Diff.' })
    }).catch((value) => setError(message(value)))
  }
  return <section><span className="eyebrow">Entscheidungen</span><h2>Approval-Inbox</h2>{error && <div className="error">{error}</div>}{diff && <article className="diff-view"><div><strong>{diff.title}</strong><button className="secondary" onClick={() => setDiff(undefined)}>Schließen</button></div><pre>{diff.value}</pre></article>}{approvals.map((approval) => <article className="approval" key={approval.id}><small>{approval.kind === 'plan-review' ? 'PLAN-REVIEW' : approval.kind === 'pr-publication' ? 'PR-VERÖFFENTLICHUNG' : approval.kind === 'tool-permission' ? 'TOOL-BERECHTIGUNG' : 'BLOCKIERT'}</small><h3>{approval.title}</h3><p>{approval.summary}</p>{approval.task && <button className="secondary diff-button" onClick={() => showDiff(approval)}>Diff ansehen</button>}<div className="actions">{approval.kind === 'tool-permission' ? <><button onClick={() => act('permission.allow', approval)}>Einmal erlauben</button><button className="secondary" onClick={() => act('permission.deny', approval)}>Ablehnen</button></> : approval.kind === 'plan-review' ? <><button onClick={() => act('plan.approve', approval)}>Freigeben</button><button className="secondary" onClick={() => act('plan.reject', approval)}>Ablehnen</button></> : approval.kind === 'pr-publication' ? <><button onClick={() => act('publication.approve', approval)}>Veröffentlichen</button><button className="secondary" onClick={() => act('publication.reject', approval)}>Ablehnen</button></> : <><button onClick={() => act('mode.enableAuto', approval)}>Auto aktivieren</button><button className="secondary" onClick={() => act('run.reset', approval)}>Lauf zurücksetzen</button></>}</div></article>)}</section>
}

function Empty({ title, text }: { title: string; text: string }): JSX.Element {
  return <section className="empty"><div>◌</div><h2>{title}</h2><p>{text}</p></section>
}
