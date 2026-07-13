import type { AgentProviderId } from '@shared/providers'
import { modelCatalogLabel, type ProviderModelCatalog } from '@renderer/modelCatalog'

interface ModelCatalogStatusProps {
  provider: AgentProviderId
  catalog: ProviderModelCatalog
}

export default function ModelCatalogStatus({
  provider,
  catalog
}: ModelCatalogStatusProps): JSX.Element {
  return (
    <div
      className={`model-catalog-status ${catalog.source}`}
      aria-live="polite"
      title={catalog.detail}
    >
      <span>{modelCatalogLabel(provider, catalog)}</span>
      {catalog.detail && <span className="model-catalog-detail">{catalog.detail}</span>}
    </div>
  )
}
