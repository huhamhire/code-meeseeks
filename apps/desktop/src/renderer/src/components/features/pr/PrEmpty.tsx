import { useTranslation } from 'react-i18next';

/**
 * PR workspace empty state: main-area placeholder when no PR is selected. Shows
 * different guidance based on whether a connection is configured (has connection →
 * prompt to pick a PR on the left; no connection → prompt to add one in settings).
 */
export function PrEmpty({ hasConnections }: { hasConnections: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="main-empty">
      {hasConnections ? (
        <div>
          <p>{t('mainPane.emptySelectPr')}</p>
          <p className="muted" style={{ marginTop: 12 }}>
            {t('mainPane.emptySelectPrHint')}
          </p>
        </div>
      ) : (
        <div>
          <p>{t('mainPane.emptyNoConnections')}</p>
          <p className="muted" style={{ marginTop: 12 }}>
            {t('mainPane.emptyNoConnectionsHint')}
          </p>
        </div>
      )}
    </div>
  );
}
