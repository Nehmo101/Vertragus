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
    <div className={`model-catalog-status ${catalog.source}`} aria-live="polite">
      {modelCatalogLabel(provider, catalog)}
    </div>
  )
}
