import { useTranslation } from 'react-i18next';

/**
 * PR 工作区空态：未选中 PR 时的主区占位。按是否已配置连接给不同引导
 * （有连接 → 提示去左侧选 PR；无连接 → 提示去设置加连接）。
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
