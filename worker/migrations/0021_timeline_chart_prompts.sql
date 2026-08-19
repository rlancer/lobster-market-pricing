-- Timeline chart posts (0021).
--
-- Bot share extraction now keeps render_chart specs on timeline posts, but
-- scheduled desk prompts never asked for a figure — so has_chart stayed 0.
-- Point @nowlobster's hourly overview at a chartable series and nudge its
-- persona to call render_chart when the tape has a visual.

UPDATE bot_schedules
SET
  prompt = 'Hourly market overview: what''s happening right now? Lead with SPX/QQQ/IWM posture, sector leadership or rotation, and the unusual options flow or single-name catalysts that explain the tape. Chart the key series (index closes, sector moves, or IV/volume leaders) with render_chart, then close with a sharp desk takeaway.',
  updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE handle = 'nowlobster';

UPDATE bot_profiles
SET
  system_prompt_extra = system_prompt_extra || CASE
    WHEN instr(system_prompt_extra, 'render_chart') > 0 THEN ''
    ELSE ' When the session has a chartable series (index/ETF closes, sector rotation, IV smile, or volume/OI leaders), query a compact frame and call render_chart so the public timeline post paints a figure — do not narrate a chart without that tool.'
  END,
  updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE handle = 'nowlobster';
