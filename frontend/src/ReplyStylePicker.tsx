import {
  Button,
  Divider,
  Popover,
  RadioList,
  RadioListItem,
  Section,
  Text,
  TextArea,
  VStack,
} from '@astryxdesign/core';
import { SlidersHorizontal } from 'lucide-react';
import {
  isReplyStyleId,
  REPLY_NOTE_MAX,
  REPLY_STYLE_OPTIONS,
} from './replyStyle';
import { useReplyStyle } from './useReplyStyle';

/**
 * Chat voice + optional context.
 * Compact keeps the composer lean with a preferences popover; full uses
 * descriptive radio rows on Account so the choices are easier to compare.
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

  if (compact) {
    return (
      <Popover
        placement="above"
        alignment="start"
        label="Reply preferences"
        width="min(22rem, calc(100vw - var(--spacing-6)))"
        content={
          <VStack gap={3}>
            <VStack gap={1}>
              <Text type="body" weight="semibold">
                How Lobster replies
              </Text>
              <Text type="supporting">
                Choose the voice. The data and tools stay the same.
              </Text>
            </VStack>

            <RadioList
              label="Reply style"
              value={pref.style}
              onChange={onStyleChange}
              size="sm"
              isLabelHidden
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

            <Divider />

            <TextArea
              label="Your context"
              value={pref.note}
              onChange={(value) => setNote(value.slice(0, REPLY_NOTE_MAX))}
              placeholder="“I trade SPX 0DTE” or “I’m learning verticals”"
              rows={2}
              size="sm"
              maxLength={REPLY_NOTE_MAX}
              isOptional
            />
          </VStack>
        }
      >
        <Button
          variant="ghost"
          size="md"
          label={selectedStyle.label}
          tooltip={`Reply style: ${selectedStyle.label}`}
          icon={<SlidersHorizontal size={14} />}
        />
      </Popover>
    );
  }

  return (
    <Section
      variant="muted"
      padding={4}
      dividers={['top', 'bottom']}
    >
      <VStack gap={4}>
        <VStack gap={1}>
          <Text type="body" weight="semibold">
            How Lobster replies
          </Text>
          <Text type="supporting">
            Choose the voice. Market data, tools, and analysis stay the same.
          </Text>
        </VStack>

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

        <Divider />

        <TextArea
          label="Your context"
          description="Share what you trade or what you’re learning. This shapes examples, not the analysis."
          value={pref.note}
          onChange={(value) => setNote(value.slice(0, REPLY_NOTE_MAX))}
          placeholder="“I trade SPX 0DTE” or “I’m learning verticals”"
          rows={3}
          size="md"
          maxLength={REPLY_NOTE_MAX}
          isOptional
        />

        <Text type="supporting">
          {signedIn
            ? 'Saved to your account.'
            : 'Saved in this browser. Sign in to sync across devices.'}
        </Text>
      </VStack>
    </Section>
  );
}
