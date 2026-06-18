import { useTranslation } from 'react-i18next';
import type { LocalPrStatus, PlatformCapabilities, StoredPullRequest } from '@meebox/shared';
import { PrPanel } from '../features/pr/PrPanel';

interface MainPaneProps {
  pr: StoredPullRequest | null;
  hasConnections: boolean;
  onSetStatus: (status: LocalPrStatus) => void;
  /** 合并当前 PR（仅在 mergeStatus.canMerge 时由 header 按钮触发） */
  onMerge: () => void;
  /** 合并请求进行中：按钮置等待态并禁用，防重复点击（远端合并可能较慢）。 */
  merging?: boolean;
  /**
   * 当前 PR 所属连接的平台能力（多平台降级用）。undefined = 未知（无连接/旧数据）→ 不降级。
   * 据此决定审批按钮 显/隐（reviewStatuses）等。
   */
  capabilities?: PlatformCapabilities;
  /** 当前 PR 所属连接的 PAT 用户登录名；用于判定「是否自己的 PR」（不能审批自己）。 */
  currentUserName?: string | null;
  /**
   * M4 跨组件跳转：ChatPane finding card 点"编辑"时由 App 设置，据此切到 Diff tab +
   * 把 nav 透传给 DiffView 做 scroll/highlight/open zone。消费完应调 onDiffNavConsumed 清掉。
   */
  pendingDiffNav?: {
    runId?: string;
    findingId?: string;
    anchor: { path: string; startLine: number; endLine: number };
  } | null;
  onDiffNavConsumed?: () => void;
  /**
   * 反向通道：PR 工作区内部组件 (e.g., PublishReviewModal) 也能触发 Diff 跳转。
   * App 端实际跑 setPendingDiffNav，复用同一条消费链路。
   */
  onRequestDiffNav?: (target: {
    runId?: string;
    findingId?: string;
    anchor: { path: string; startLine: number; endLine: number };
  }) => void;
}

/**
 * 主内容区（layout 薄壳）：未选 PR 时显示空态（按是否有连接给不同引导），
 * 选中 PR 时挂载 PR 评审工作区（features/pr/PrPanel）。PR 详情布局与状态均归 PrPanel。
 */
export function MainPane({
  pr,
  hasConnections,
  onSetStatus,
  onMerge,
  merging = false,
  capabilities,
  currentUserName,
  pendingDiffNav,
  onDiffNavConsumed,
  onRequestDiffNav,
}: MainPaneProps) {
  const { t } = useTranslation();
  if (!pr) {
    return (
      <main className="main">
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
      </main>
    );
  }
  return (
    <main className="main">
      <PrPanel
        pr={pr}
        onSetStatus={onSetStatus}
        onMerge={onMerge}
        merging={merging}
        capabilities={capabilities}
        currentUserName={currentUserName}
        pendingDiffNav={pendingDiffNav}
        onDiffNavConsumed={onDiffNavConsumed}
        onRequestDiffNav={onRequestDiffNav}
      />
    </main>
  );
}
