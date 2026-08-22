import {
  Divider,
  RadioList,
  RadioListItem,
  Section,
  SegmentedControl,
  SegmentedControlItem,
  Text,
  TextArea,
  VStack,
} from '@astryxdesign/core';
import {
  isReplyStyleId,
  REPLY_NOTE_MAX,
  REPLY_STYLE_OPTIONS,
} from './replyStyle';
import { useReplyStyle } from './useReplyStyle';

/**
 * Copilot voice + optional context.
 * Compact uses a segmented control in the composer; full uses descriptive
 * radio rows in Account so the choices are easier to compare.
 */
export function ReplyStylePicker({
  compact = false,
}: {
  compact?: boolean;
}) {
  const { pref, setStyle, setNote, signedIn } = useReplyStyle();
  const selectedStyle = REPLY_STYLE_OPTIONS.find((option) => option.id === pref.style)
    ?? REPLY_STYLE_OPTIONS[0];
  const onStyleChange = (value: string) => {
    if (isReplyStyleId(value)) setStyle(value);
  };

  return (
    <Section
      variant="muted"
      padding={compact ? 3 : 4}
      dividers={['top', 'bottom']}
    >
      <VStack gap={compact ? 3 : 4}>
        <VStack gap={1}>
          <Text type="body" weight="semibold">
            How Lobster replies
          </Text>
          <Text type="supporting">
            Choose the voice. Market data, tools, and analysis stay the same.
          </Text>
        </VStack>

        {compact ? (
          <VStack gap={1.5}>
            <SegmentedControl
              label="Reply style"
              value={pref.style}
              onChange={onStyleChange}
              layout="fill"
              size="sm"
            >
              {REPLY_STYLE_OPTIONS.map((option) => (
                <SegmentedControlItem
                  key={option.id}
                  value={option.id}
                  label={option.label}
                />
              ))}
            </SegmentedControl>
            <Text type="supporting">{selectedStyle.hint}</Text>
          </VStack>
        ) : (
          <RadioList
            label="Reply style"
            description="Choose how much market shorthand Lobster uses."
            value={pref.style}
            onChange={onStyleChange}
          >
            {REPLY_STYLE_OPTIONS.map((option) => (
              <RadioListItem
                key={option.id}
                value={option.id}
                label={option.label}
                description={option.hint}
              />
            ))}
          </RadioList>
        )}

        <Divider />

        <TextArea
          label="Your context"
          description={compact
            ? undefined
            : 'Share what you trade or what you’re learning. This shapes examples, not the analysis.'}
          value={pref.note}
          onChange={(value) => setNote(value.slice(0, REPLY_NOTE_MAX))}
          placeholder="“I trade SPX 0DTE” or “I’m learning verticals”"
          rows={compact ? 2 : 3}
          size={compact ? 'sm' : 'md'}
          maxLength={REPLY_NOTE_MAX}
          isOptional
        />

        {!compact && (
          <Text type="supporting">
            {signedIn
              ? 'Saved to your account.'
              : 'Saved in this browser. Sign in to sync across devices.'}
          </Text>
        )}
      </VStack>
    </Section>
  );
}
