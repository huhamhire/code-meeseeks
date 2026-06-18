import { useTranslation } from 'react-i18next';
import { LANGUAGE_OPTIONS, type SupportedLanguage } from '@meebox/shared';

export function LanguageSection({
  language,
  onChange,
}: {
  language: SupportedLanguage;
  onChange: (next: SupportedLanguage) => void;
}) {
  const { t } = useTranslation();
  return (
    <section className="modal-section">
      <div className="modal-section-head">
        <h4>{t('settings.languageTitle')}</h4>
        <select
          className="settings-input settings-language-select"
          value={language}
          onChange={(e) => onChange(e.target.value as SupportedLanguage)}
          aria-label={t('settings.languageTitle')}
        >
          {LANGUAGE_OPTIONS.map((opt) => (
            <option key={opt.code} value={opt.code}>
              {opt.endonym}
            </option>
          ))}
        </select>
      </div>
      <p className="muted" style={{ margin: 0 }}>
        {t('settings.languageHint')}
      </p>
    </section>
  );
}
