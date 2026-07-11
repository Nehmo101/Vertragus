import { useCallback, useEffect, useState } from 'react'
import type { AppInfo } from '@shared/ipc'
import { PROVIDERS, type ProviderHealth } from '@shared/providers'

function statusClass(h: ProviderHealth | undefined): string {
  if (!h) return 'pending'
  return h.available ? 'ok' : 'err'
}

export default function App(): JSX.Element {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [health, setHealth] = useState<ProviderHealth[]>([])
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const [appInfo, providers] = await Promise.all([
        window.orca.getAppInfo(),
        window.orca.checkProviders()
      ])
      setInfo(appInfo)
      setHealth(providers)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const byId = (id: string): ProviderHealth | undefined => health.find((h) => h.id === id)

  return (
    <div className="app">
      <div className="header">
        <span className="logo">🐋</span>
        <div>
          <div className="title">Orca-Strator</div>
          <div className="subtitle">
            Orchestrate and run multiple AI coding agents in parallel
          </div>
        </div>
        <div className="spacer" />
        {info && (
          <span className="pill">
            v{info.version} · Electron {info.electron} · {info.platform}
          </span>
        )}
      </div>

      <div className="note">
        <strong>Phase 0 — Fundament.</strong> Provider-Erkennung, Konfigurationsspeicher und die
        App-Hülle stehen. Als Nächstes (Phase 0.5) das Layout mit Claude entwerfen, danach Phase 1:
        das Multi-Agent-Grid mit Live-Terminals, Yolo-Mode und Worktree-Isolation.
      </div>

      <div>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
          <h2 className="section-title" style={{ margin: 0 }}>
            Provider &amp; Integrationen
          </h2>
          <div className="spacer" />
          <button className="btn" onClick={() => void refresh()} disabled={loading}>
            {loading ? 'Prüfe…' : 'Neu prüfen'}
          </button>
        </div>

        <div className="grid">
          {PROVIDERS.map((p) => {
            const h = byId(p.id)
            return (
              <div className="card" key={p.id}>
                <div className="card-head">
                  <span className={`dot ${statusClass(h)}`} />
                  <span className="card-name">{p.label}</span>
                  <span className="kind-tag">{p.kind}</span>
                </div>
                <div className="card-detail">
                  {!h && 'Prüfe…'}
                  {h?.available && (h.version || 'installed')}
                  {h && !h.available && 'Nicht gefunden'}
                </div>
                {h?.detail && <div className="card-detail">{h.detail}</div>}
              </div>
            )
          })}
        </div>
      </div>

      {info && (
        <div className="info-row">
          <span>node {info.node}</span>
          <span>chrome {info.chrome}</span>
          <span>app {info.name}</span>
        </div>
      )}
    </div>
  )
}
