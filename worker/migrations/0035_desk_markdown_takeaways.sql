-- Desk / bot takeaways are Markdown (paragraphs, bold, bullets), not a
-- one-line 1–3 sentence blob. REPLACE is idempotent: a second apply is a
-- no-op once the old phrase is gone. Does not overwrite unrelated admin edits.

UPDATE bot_profiles
SET
  system_prompt_extra = REPLACE(
    system_prompt_extra,
    'Close with a sharp 1–3 sentence desk takeaway a trader can act on or dismiss in under 30 seconds.',
    'Close with a sharp Markdown desk takeaway a trader can act on or dismiss in under 30 seconds — short paragraphs, **bold** key numbers, optional bullets. Never one run-on sentence.'
  ),
  updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE handle = 'nowlobster'
  AND instr(system_prompt_extra, '1–3 sentence desk takeaway') > 0;

UPDATE bot_profiles
SET
  system_prompt_extra = REPLACE(
    system_prompt_extra,
    'Close with a sharp 1–3 sentence rates/inflation takeaway.',
    'Close with a sharp Markdown rates/inflation takeaway — short paragraphs, **bold** key numbers, optional bullets. Never one run-on sentence.'
  ),
  updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE handle = 'macrolobster'
  AND instr(system_prompt_extra, '1–3 sentence rates/inflation takeaway') > 0;

-- Older seed (0023) used "rates takeaway" without "inflation".
UPDATE bot_profiles
SET
  system_prompt_extra = REPLACE(
    system_prompt_extra,
    'Close with a sharp 1–3 sentence rates takeaway.',
    'Close with a sharp Markdown rates/inflation takeaway — short paragraphs, **bold** key numbers, optional bullets. Never one run-on sentence.'
  ),
  updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE handle = 'macrolobster'
  AND instr(system_prompt_extra, '1–3 sentence rates takeaway') > 0;
