import { describe, expect, it } from 'vitest';
import { createPrAgentBridge, detectPrAgent } from '../src/detect.js';

// Use process.execPath (node itself, responds to `--version`) to impersonate the embedded interpreter,
// deterministically and offline verifying embedded detect/select/construct, without the real vendor runtime or network.
const FAKE_PY = process.execPath;

describe('detect: embedded strategy selection', () => {
  it('embeddedPythonPath exists + forceStrategy=embedded → selects embedded and constructs the matching bridge', async () => {
    const { bridge, status } = await createPrAgentBridge({
      embeddedPythonPath: FAKE_PY,
      forceStrategy: 'embedded',
    });
    expect(status.available).toBe(true);
    if (status.available) {
      expect(status.strategy).toBe('embedded');
      // version looks like `pr-agent <ver>`; FAKE_PY is not real python so no version → `pr-agent unknown`
      expect(status.version.startsWith('pr-agent ')).toBe(true);
    }
    expect(bridge?.strategy).toBe('embedded');
  });

  it('in auto mode embedded ranks first (selected as soon as the path exists)', async () => {
    const status = await detectPrAgent({ embeddedPythonPath: FAKE_PY, forceStrategy: 'auto' });
    expect(status.available).toBe(true);
    if (status.available) expect(status.strategy).toBe('embedded');
  });

  it('forceStrategy=embedded but path does not exist → no fallback, reports unavailable', async () => {
    const status = await detectPrAgent({
      embeddedPythonPath: '/no/such/python-xyz',
      forceStrategy: 'embedded',
    });
    expect(status.available).toBe(false);
  });

  it('embeddedPythonPath not passed → embedded is excluded (falls back to detecting local-cli)', async () => {
    // Only asserts it does not throw due to missing embedded; whether local-cli is available depends on the environment
    const status = await detectPrAgent({});
    expect(status.available === true || status.available === false).toBe(true);
    if (status.available) expect(status.strategy).not.toBe('embedded');
  });
});
