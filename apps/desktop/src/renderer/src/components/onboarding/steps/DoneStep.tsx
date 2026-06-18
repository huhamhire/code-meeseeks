import { useTranslation } from 'react-i18next';
import { SuccessBadgeIcon } from '../../common/icons';

export function DoneStep({ submitting, error }: { submitting: boolean; error: string | null }) {
  const { t } = useTranslation();
  return (
    <div className="onboarding-done">
      <div className="onboarding-done-badge" aria-hidden="true">
        <SuccessBadgeIcon size={76} />
      </div>
      <h2 className="onboarding-title">{t('onboarding.doneTitle')}</h2>
      <p className="onboarding-lead">{t('onboarding.doneLead')}</p>
      {submitting && <p className="muted">{t('onboarding.doneSubmitting')}</p>}
      {error && <p className="error-text">{t('onboarding.doneError', { error })}</p>}
    </div>
  );
}
