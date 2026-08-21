import { Button, HStack, Text, TextArea, TextInput, VStack } from '@astryxdesign/core';
import { REPLY_NOTE_MAX, REPLY_STYLE_OPTIONS } from './replyStyle';
import { useReplyStyle } from './useReplyStyle';

/**
 * Canned Copilot audience + optional 240-char note.
 * Compact: chips + one-line note (chat composer). Full: same, with description (Account).
 */
export function ReplyStylePicker({
  compact = false,
}: {
  compact?: boolean;
}) {
  const { pref, setStyle, setNote, signedIn } = useReplyStyle();

  return (
    <VStack gap={compact ? 2 : 3} className="reply-style-picker">
      <VStack gap={1}>
        <Text type={compact ? 'supporting' : 'body'} weight="semibold">
          How Lobster replies
        </Text>
        {!compact && (
          <Text type="supporting">
            Same tools as everyone else — this only changes voice. Signed-in choices save to your account
            {signedIn ? '' : '; sign in to keep them across devices'}.
          </Text>
        )}
      </VStack>
      <HStack gap={2} wrap="wrap">
        {REPLY_STYLE_OPTIONS.map((option) => (
          <Button
            key={option.id}
            size="sm"
            variant={pref.style === option.id ? 'primary' : 'secondary'}
            label={option.label}
            onClick={() => setStyle(option.id)}
          />
        ))}
      </HStack>
      <Text type="supporting">
        {REPLY_STYLE_OPTIONS.find((option) => option.id === pref.style)?.hint}
        {` · ${pref.note.length}/${REPLY_NOTE_MAX}`}
      </Text>
      {compact ? (
        <TextInput
          label="Optional note"
          value={pref.note}
          onChange={(value) => setNote(value.slice(0, REPLY_NOTE_MAX))}
          placeholder="e.g. I trade SPX 0DTE"
        />
      ) : (
        <TextArea
          label="Optional note"
          description={`Flavor only — ${REPLY_NOTE_MAX} characters max. e.g. “I trade SPX 0DTE” or “I’m learning verticals”.`}
          value={pref.note}
          onChange={(value) => setNote(value.slice(0, REPLY_NOTE_MAX))}
          placeholder="e.g. I trade SPX 0DTE"
        />
      )}
    </VStack>
  );
}
