import { TextInput } from '@astryxdesign/core';
import { AtSign } from 'lucide-react';
import { handleInputError } from './handle';

/** Shared handle text field for Account and the first-sign-in claim dialog. */
export function HandleField({
  value,
  error,
  onChange,
}: {
  value: string;
  error: string | null;
  onChange: (value: string) => void;
}) {
  const inputError = handleInputError(value);
  const status = error
    ? { type: 'error' as const, message: error }
    : value && inputError
      ? { type: 'error' as const, message: inputError }
      : undefined;
  return (
    <TextInput
      label="Handle"
      description={value ? `lobster.mp/u/${value}` : 'Letters and numbers only — this becomes your profile URL.'}
      value={value}
      onChange={onChange}
      startIcon={<AtSign size={16} />}
      placeholder="yourname"
      isRequired
      status={status}
    />
  );
}
