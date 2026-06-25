/**
 * 通用开关（switch）：受控布尔输入，无障碍走 role="switch" + aria-checked。点击 / 空格 / 回车切换。
 * 视觉为轨道 + 滑块，开态走 accent 色（样式见 base.scss .switch）。
 */
export function Switch({
  checked,
  onChange,
  ariaLabel,
  disabled = false,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  ariaLabel: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      className={`switch${checked ? ' switch-on' : ''}`}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="switch-knob" aria-hidden="true" />
    </button>
  );
}
