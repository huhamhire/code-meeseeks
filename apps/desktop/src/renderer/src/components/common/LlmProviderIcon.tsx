import type { JSX } from 'react';
import type { LlmProvider } from '@meebox/shared';

// LLM provider 品牌图标。OpenAI / Anthropic 用官方几何标记；其余几家无干净的
// 官方单色 SVG 资源，按品牌意象手绘为简洁可辨的彩色图标（鲸鱼 / 云 / 火山 /
// 通用 API 字形）。后续如放入正式 logo 资源，替换这里对应分支即可。

function OpenAiGlyph({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#10A37F"
        d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.1419.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"
      />
    </svg>
  );
}

// Anthropic → Claude：放射状 burst 标记（12 道花瓣自中心向外辐射）
function ClaudeGlyph({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="#D97757" aria-hidden="true">
      {Array.from({ length: 12 }, (_, i) => (
        <rect
          key={i}
          x="11.2"
          y="2.4"
          width="1.6"
          height="6.6"
          rx="0.8"
          transform={`rotate(${i * 30} 12 12)`}
        />
      ))}
    </svg>
  );
}

// OpenAI 兼容：通用 API 字形（< / >，代表「任何兼容协议」）
function CompatibleGlyph({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="#9CA3AF"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8.5 7 4 12l4.5 5" />
      <path d="M15.5 7 20 12l-4.5 5" />
      <path d="M13.5 5l-3 14" />
    </svg>
  );
}

// DeepSeek：鲸鱼吉祥物（圆身 + 白肚 + 右上分叉尾鳍 + 眼睛，手绘简化）
function DeepSeekGlyph({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      {/* 圆形身体 */}
      <circle cx="10.4" cy="13.8" r="8" fill="#4D6BFE" />
      {/* 上翘的分叉尾鳍 */}
      <path
        fill="#4D6BFE"
        d="M15.8 9.4c2-1.5 3.5-3.9 4.3-6.3.3 1.5.4 2.8-.2 4 .9-.4 1.9-.3 2.8.1-1.1 1.5-2.7 2.5-4.5 2.9-.8.2-1.6.1-2.4-.7Z"
      />
      {/* 白色肚腩月牙 */}
      <path
        fill="#fff"
        d="M4.6 14.6c0 3.4 2.7 6 6 6 .5 0 1-.1 1.4-.2-1.8-.5-3.3-1.7-4-3.6-.5-1.3-.3-2.6.4-3.6-.5-.3-1.1-.5-1.8-.5-1.1 0-2 .9-2 1.9Z"
      />
      {/* 眼睛 */}
      <circle cx="12.6" cy="11.2" r="1" fill="#fff" />
    </svg>
  );
}

// 阿里百炼（DashScope）→ 千问（Qwen）：紫色「Q」标记
function QwenGlyph({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="#615CED"
      strokeWidth="2.6"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="11" cy="11.5" r="7" />
      <path d="M14.8 15.3 19 19.5" />
    </svg>
  );
}

// 火山方舟（Volcengine Ark）：火山意象（山体 + 顶部火苗）
function VolcengineGlyph({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#1664FF" d="M8.5 10h7l5.5 10H3z" />
      <path
        fill="#FF5E3A"
        d="M12 2.5c.6 1.4.3 2.4-.3 3.3.9-.2 1.5-.8 1.8-1.7.7 1 1.1 2 .6 3.4-.3.9-1 1.5-1.9 1.8h-.4c-1.2 0-2.2-.9-2.2-2.1 0-1.6 1.4-2.4 1.9-4 .2.4.4.8.5 1.3Z"
      />
    </svg>
  );
}

// 本地 CLI：终端窗口 + 提示符（>_），代表「调本机命令行工具」
function CliGlyph({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="#10B981"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7 9l3 3-3 3" />
      <path d="M13 15h4" />
    </svg>
  );
}

const GLYPHS: Record<LlmProvider, (p: { size: number }) => JSX.Element> = {
  openai: OpenAiGlyph,
  'openai-compatible': CompatibleGlyph,
  anthropic: ClaudeGlyph,
  deepseek: DeepSeekGlyph,
  dashscope: QwenGlyph,
  'volcengine-ark': VolcengineGlyph,
  cli: CliGlyph,
};

export function LlmProviderIcon({
  provider,
  size = 28,
}: {
  provider: LlmProvider;
  size?: number;
}) {
  const Glyph = GLYPHS[provider];
  return (
    <span className="llm-provider-glyph" aria-hidden="true">
      <Glyph size={size} />
    </span>
  );
}
