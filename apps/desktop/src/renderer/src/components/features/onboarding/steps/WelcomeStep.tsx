import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '../../../../api';
import { PullRequestIcon } from '../../../common/icons';

export function WelcomeStep({ onStart }: { onStart: () => void }) {
  const { t } = useTranslation();
  // 隐藏后门：连续快速点击 logo 7 次打开 DevTools（每次间隔 > 800ms 则计数清零）。
  // 首启向导下没有菜单 / 状态栏入口，给开发排障留一个不显眼的手势。
  const tapRef = useRef<{ count: number; last: number }>({ count: 0, last: 0 });
  const onLogoTap = (): void => {
    const now = performance.now();
    const t = tapRef.current;
    t.count = now - t.last < 800 ? t.count + 1 : 1;
    t.last = now;
    if (t.count >= 7) {
      t.count = 0;
      void invoke('app:openDevTools', undefined);
    }
  };
  return (
    <div className="onboarding-welcome">
      <div className="onboarding-logo" onClick={onLogoTap} aria-hidden="true">
        <PullRequestIcon size={56} />
      </div>
      <h2 className="onboarding-title">{t('onboarding.welcomeTitle')}</h2>
      <p className="onboarding-lead">{t('onboarding.welcomeLead')}</p>
      <ul className="onboarding-points">
        <li>{t('onboarding.welcomePoint1')}</li>
        <li>{t('onboarding.welcomePoint2')}</li>
      </ul>
      <button type="button" className="btn btn-primary onboarding-start" onClick={onStart}>
        {t('onboarding.startConfig')}
      </button>
    </div>
  );
}
