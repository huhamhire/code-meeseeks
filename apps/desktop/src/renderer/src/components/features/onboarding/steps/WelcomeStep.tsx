import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '../../../../api';
import { PullRequestIcon } from '../../../common';

export function WelcomeStep({ onStart }: { onStart: () => void }) {
  const { t } = useTranslation();
  // Hidden backdoor: 7 rapid clicks on the logo open DevTools (an interval > 800ms between clicks resets the count).
  // The onboarding wizard has no menu / status bar entry, so this leaves an unobtrusive gesture for dev troubleshooting.
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
