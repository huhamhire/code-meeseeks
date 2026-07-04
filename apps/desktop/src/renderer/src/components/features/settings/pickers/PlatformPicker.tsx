import { useTranslation } from 'react-i18next';
import { PLATFORM_META } from '../../../common';
import type { ConnKind } from '../ConnectionForm';

/**
 * Integration platform picker list (left column): icon + name + subtitle, single-select highlight.
 * The first-run wizard's platform step and the settings panel's "connections" sub-modal share the same visuals (config picker left/right layout, see config-picker.scss).
 *
 * readOnly: switching platform is not allowed when editing an existing connection (base_url / token semantics vary by platform) —— the current item stays highlighted,
 * the rest are dimmed, and the whole list disables interaction.
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
        // Clickable: platform is implemented and not read-only. Dimmed: unimplemented platform, or non-current item in read-only state.
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
