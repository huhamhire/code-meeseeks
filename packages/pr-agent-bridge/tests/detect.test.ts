import { describe, expect, it } from 'vitest';
import { createPrAgentBridge, detectPrAgent } from '../src/detect.js';

// 用 process.execPath（node 本身，响应 `--version`）冒充嵌入式解释器，确定性、离线地
// 验证 embedded 探测/选择/构造，不依赖真实 vendor 运行时或网络。
const FAKE_PY = process.execPath;

describe('detect: embedded strategy 选择', () => {
  it('embeddedPythonPath 存在 + forceStrategy=embedded → 选中 embedded 并构造对应 bridge', async () => {
    const { bridge, status } = await createPrAgentBridge({
      embeddedPythonPath: FAKE_PY,
      forceStrategy: 'embedded',
    });
    expect(status.available).toBe(true);
    if (status.available) {
      expect(status.strategy).toBe('embedded');
      // version 形如 `pr-agent <ver>`；FAKE_PY 非真 python 拿不到版本 → `pr-agent unknown`
      expect(status.version.startsWith('pr-agent ')).toBe(true);
    }
    expect(bridge?.strategy).toBe('embedded');
  });

  it('auto 模式下 embedded 排在最前（路径存在即优先选中）', async () => {
    const status = await detectPrAgent({ embeddedPythonPath: FAKE_PY, forceStrategy: 'auto' });
    expect(status.available).toBe(true);
    if (status.available) expect(status.strategy).toBe('embedded');
  });

  it('forceStrategy=embedded 但路径不存在 → 不回退、报告 unavailable', async () => {
    const status = await detectPrAgent({
      embeddedPythonPath: '/no/such/python-xyz',
      forceStrategy: 'embedded',
    });
    expect(status.available).toBe(false);
  });

  it('未传 embeddedPythonPath → embedded 不参与（回退探测 local-cli）', async () => {
    // 这里只断言不会因 embedded 缺失而抛错；local-cli 是否可用取决于环境
    const status = await detectPrAgent({});
    expect(status.available === true || status.available === false).toBe(true);
    if (status.available) expect(status.strategy).not.toBe('embedded');
  });
});
