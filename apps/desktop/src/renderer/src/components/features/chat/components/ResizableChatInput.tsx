import { useRef, type ComponentPropsWithoutRef, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';

type Props = ComponentPropsWithoutRef<'textarea'> & {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  inputHeight: number | null;
  onInputHeightChange: (height: number) => void;
};

export function ResizableChatInput({
  textareaRef,
  inputHeight,
  onInputHeightChange,
  ...props
}: Props) {
  const { t } = useTranslation();
  const drag = useRef<{ startY: number; height: number; min: number; max: number } | null>(null);

  return (
    <div className="chat-pane-textarea-wrap">
      <div
        className="chat-pane-textarea-resize-handle"
        title={t('chatPane.resizeInputTitle')}
        aria-label={t('chatPane.resizeInputAria')}
        onPointerDown={(event) => {
          const input = textareaRef.current;
          if (!input || !event.isPrimary || event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          const { minHeight, maxHeight } = getComputedStyle(input);
          drag.current = {
            startY: event.clientY,
            height: input.getBoundingClientRect().height,
            min: Number.parseFloat(minHeight),
            max: Number.parseFloat(maxHeight),
          };
        }}
        onPointerMove={(event) => {
          if (!drag.current || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
          const { startY, height, min, max } = drag.current;
          onInputHeightChange(Math.min(max, Math.max(min, height + startY - event.clientY)));
        }}
        onLostPointerCapture={() => {
          drag.current = null;
        }}
      />
      <textarea
        {...props}
        ref={textareaRef}
        className="chat-pane-textarea"
        rows={2}
        style={inputHeight === null ? undefined : { height: inputHeight }}
      />
    </div>
  );
}
