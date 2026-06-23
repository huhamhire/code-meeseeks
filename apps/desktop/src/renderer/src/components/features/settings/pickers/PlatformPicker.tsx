import { useTranslation } from 'react-i18next';
import { PLATFORM_META } from '../../../common';
import type { ConnKind } from '../ConnectionForm';

/**
 * 集成平台选择列表（左侧栏）：图标 + 名称 + 副标题，单选高亮。
 * 首启向导平台步与设置面板「连接」子模态共用同一视觉（配置选择器左右布局，见 config-picker.scss）。
 *
 * readOnly：编辑既有连接时不允许切平台（base_url / token 语义随平台而异）——当前项保持高亮、
 * 其余置灰，整列禁用交互。
 */
export function PlatformPicker({
  value,
  onChange,
  readOnly = false,
  ariaLabel,
}: {
  value: ConnKind;
  onChange: (kind: ConnKind) => void;
  readOnly?: boolean;
  ariaLabel?: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="config-pick-list" role="radiogroup" aria-label={ariaLabel}>
      {PLATFORM_META.map((p) => {
        const selected = p.kind === value;
        // 可点选：平台已实现且非只读。置灰：未实现平台，或只读态下的非当前项。
        const interactive = p.available && !readOnly;
        const dim = !p.available || (readOnly && !selected);
        return (
          <button
            type="button"
            key={p.kind}
            className={`config-pick-item${selected ? ' selected' : ''}${dim ? ' disabled' : ''}`}
            role="radio"
            aria-checked={selected}
            aria-disabled={!interactive}
            disabled={!interactive}
            onClick={() => {
              if (interactive) onChange(p.kind as ConnKind);
            }}
          >
            <span className={`config-pick-icon${p.available ? '' : ' muted-icon'}`}>
              <p.Icon size={24} />
            </span>
            <span className="config-pick-text">
              <span className="config-pick-name">{p.label}</span>
              <span className="config-pick-meta">{t(p.subKey)}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
