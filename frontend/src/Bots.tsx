import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Button, Heading, Text, TextArea, TextInput, Token, VStack } from '@astryxdesign/core';
import { useIsAdmin } from './useAdmin';
import { api, type BotProfile, type BotRun, type BotSchedule } from './api';
import { rememberChatId, stashBotSession, stashPendingPrompt } from './chatSession';
import './Bots.css';

const EMPTY_FORM = {
  handle: '',
  display_name: '',
  persona: '',
  bio: '',
  system_prompt_extra: '',
  seed_prompts: '',
  model: '',
  reasoning_effort: '',
  enabled: true,
};

/** Create-form presets — seeded bots + the original yololobster template. */
const BOT_PRESETS = {
  nowlobster: {
    handle: 'nowlobster',
    display_name: 'Now Lobster',
    persona: "What's happening now",
    bio: 'Live desk commentary on the session — indexes, sector leadership, and the options tape that explains the move.',
    system_prompt_extra:
      'You write present-tense market commentary for what is happening right now. Lead with the tape: index posture (SPX/NDX/QQQ/IWM), sector leadership or rotation, and the single-name or factor moves that matter. Ground every claim in tool results (quotes, unusual options volume/OI, IV, news, macro calendar) — no invented catalysts. Prefer unusual options flow and tradable liquid names over thin lottery tickets. Close with a sharp 1–3 sentence desk takeaway a trader can act on or dismiss in under 30 seconds. Stay opinionated but honest about uncertainty when the data is mixed.',
    seed_prompts: [
      "What's happening in the market right now? Lead with the index move, then the unusual options flow and single-name catalysts that explain it.",
      'Give me live market commentary for this session — SPX/QQQ posture, sector leadership, and the options tape that matters.',
      "What is the market pricing right now? Pull IV, unusual volume, and the catalysts driving today's move.",
    ].join('\n'),
  },
  yololobster: {
    handle: 'yololobster',
    display_name: 'Yolo Lobster',
    persona: 'High risk, high reward',
    bio: 'Asymmetric upside hunter — short-dated lottery tickets with real flow, always flagged as able to go to zero.',
    system_prompt_extra:
      'You chase asymmetric upside. Prefer lottery-ticket OTM structures, meme-adjacent names with real flow, and short-dated catalysts. Always flag that the idea can go to zero. Still require tradable quotes. When a standout name has a chartable series (volume/OI leaders, IV smile, or short-dated price action), query a compact frame and call render_chart so the public timeline post paints a figure — do not narrate a chart without that tool.',
    seed_prompts: [
      'Find the juiciest short-dated call lottery tickets with real volume and open interest today.',
      'Scan for OTM call flow with real volume and open interest — pick the asymmetric upside names that can still go to zero.',
      "What are today's highest-conviction short-dated yolo calls? Require tradable quotes and flag the wipeout risk.",
    ].join('\n'),
  },
  macrolobster: {
    handle: 'macrolobster',
    display_name: 'Macro Lobster',
    persona: 'Rates, the curve, and the cycle',
    bio: 'Macro desk — Treasury curve, real rates, policy, and what equities are pricing from the rates complex.',
    system_prompt_extra:
      'You are the macro / rates desk. Lead with options.yields (DGS* constant-maturity curve, T10Y2Y/T10Y3M spreads, TIPS/breakevens, DFF/SOFR) before bond ETF proxies. For direction asks (e.g. 30Y), pull multi-year levels and recent 1w/1m/3m/1y changes, place them in curve and policy context, then weigh the next FOMC/CPI catalysts via eco_calendar. Cross-check with TLT / ZB=F / ZN=F in options.ohlc when useful — say when you are using price proxies vs yield levels. Chart the curve or a key series with render_chart when the answer has a time series. Stay opinionated but honest: data-grounded lean, not a crystal-ball forecast. Close with a sharp 1–3 sentence rates takeaway.',
    seed_prompts: [
      'What is the US Treasury curve doing — levels, shape, and recent changes across 2Y/10Y/30Y?',
      'What do you think the direction of the 30-year yield is? Ground it in DGS30 history, curve spreads, and the next macro catalysts.',
      'Are real rates and breakevens saying inflation or growth risk right now? Use TIPS and T*YIE series plus the Fed calendar.',
      'How are policy rates (DFF/SOFR) lining up with the front end of the curve, and what is equities pricing?',
    ].join('\n'),
  },
} as const;

function seedsToText(seeds: string[]): string {
  return seeds.join('\n');
}

function textToSeeds(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function normalizePrompt(prompt: string): string {
  return prompt.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Prefer an unused seed so the prompt field previews what generate will send. */
function nextUnusedSeed(seeds: string[], runs: BotRun[]): string {
  const used = new Set(runs.map((run) => normalizePrompt(run.prompt)).filter(Boolean));
  for (const seed of seeds) {
    const trimmed = seed.trim();
    if (trimmed && !used.has(normalizePrompt(trimmed))) return trimmed;
  }
  return '';
}

function formFromBot(bot: BotProfile) {
  return {
    handle: bot.handle,
    display_name: bot.display_name,
    persona: bot.persona,
    bio: bot.bio ?? '',
    system_prompt_extra: bot.system_prompt_extra,
    seed_prompts: seedsToText(bot.seed_prompts),
    model: bot.model ?? '',
    reasoning_effort: bot.reasoning_effort ?? '',
    enabled: bot.enabled,
  };
}

/** Relative age from epoch ms — compact for dense admin run rows. */
function formatRelativeAge(createdAtMs: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - createdAtMs) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function runStatusColor(status: BotRun['status']): 'green' | 'red' | 'blue' {
  if (status === 'shared') return 'green';
  if (status === 'failed') return 'red';
  return 'blue';
}

/**
 * Admin-only bot profiles — edit personas and trigger a Copilot chat that
 * shares publicly under the bot handle (e.g. @yololobster).
 */
export default function BotsPage() {
  const navigate = useNavigate();
  const { isAdmin, isPending } = useIsAdmin();
  const [bots, setBots] = useState<BotProfile[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [runs, setRuns] = useState<BotRun[]>([]);
  const [schedule, setSchedule] = useState<BotSchedule | null>(null);
  const [scheduleForm, setScheduleForm] = useState({
    enabled: true,
    cadence_seconds: '3600',
    market_gated: true,
    prompt: '',
  });
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!isPending && !isAdmin) {
      void navigate({ to: '/' });
    }
  }, [isAdmin, isPending, navigate]);

  const load = useCallback(async () => {
    const response = await api.adminBots();
    setBots(response.items);
  }, []);

  useEffect(() => {
    if (!isAdmin) return;
    load().catch((err) => setError(String((err as Error)?.message ?? err)));
  }, [isAdmin, load]);

  const selectBot = async (handle: string) => {
    setError(null);
    setNotice(null);
    setCreating(false);
    setSelected(handle);
    const detail = await api.adminBot(handle);
    setForm(formFromBot(detail.bot));
    setRuns(detail.runs);
    setSchedule(detail.schedule);
    setScheduleForm({
      enabled: detail.schedule?.enabled ?? true,
      cadence_seconds: String(detail.schedule?.cadence_seconds ?? 3600),
      market_gated: detail.schedule?.market_gated ?? true,
      prompt: detail.schedule?.prompt
        ?? "Hourly market overview: what's happening right now? Lead with SPX/QQQ/IWM posture, sector leadership or rotation, and the unusual options flow or single-name catalysts that explain the tape. Close with a sharp desk takeaway.",
    });
    setPrompt(nextUnusedSeed(detail.bot.seed_prompts, detail.runs));
  };

  const startCreate = (preset: keyof typeof BOT_PRESETS = 'nowlobster') => {
    const template = BOT_PRESETS[preset];
    setCreating(true);
    setSelected(null);
    setForm({
      ...EMPTY_FORM,
      ...template,
    });
    setRuns([]);
    setSchedule(null);
    setScheduleForm({
      enabled: true,
      cadence_seconds: '3600',
      market_gated: true,
      prompt:
        "Hourly market overview: what's happening right now? Lead with SPX/QQQ/IWM posture, sector leadership or rotation, and the unusual options flow or single-name catalysts that explain the tape. Close with a sharp desk takeaway.",
    });
    setPrompt(textToSeeds(template.seed_prompts)[0] ?? '');
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const body = {
        handle: form.handle.trim().toLowerCase(),
        display_name: form.display_name.trim(),
        persona: form.persona.trim(),
        bio: form.bio.trim() || null,
        system_prompt_extra: form.system_prompt_extra,
        seed_prompts: textToSeeds(form.seed_prompts),
        model: form.model.trim() || null,
        reasoning_effort: form.reasoning_effort.trim() || null,
        enabled: form.enabled,
      };
      if (creating) {
        const created = await api.createBot(body);
        setNotice(`Created @${created.bot.handle}`);
        await load();
        setCreating(false);
        await selectBot(created.bot.handle);
      } else if (selected) {
        const updated = await api.updateBot(selected, body);
        setNotice(`Saved @${updated.bot.handle}`);
        await load();
        await selectBot(updated.bot.handle);
      }
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!selected) return;
    if (!window.confirm(`Delete @${selected}? Existing shares keep their links but lose bot attribution.`)) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteBot(selected);
      setSelected(null);
      setForm(EMPTY_FORM);
      setRuns([]);
      setSchedule(null);
      setNotice(`Deleted @${selected}`);
      await load();
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    } finally {
      setBusy(false);
    }
  };

  const saveSchedule = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const cadence = Number(scheduleForm.cadence_seconds);
      const result = await api.upsertBotSchedule(selected, {
        enabled: scheduleForm.enabled,
        cadence_seconds: cadence,
        market_gated: scheduleForm.market_gated,
        prompt: scheduleForm.prompt.trim(),
      });
      setSchedule(result.schedule);
      setNotice(`Saved schedule for @${selected}`);
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    } finally {
      setBusy(false);
    }
  };

  const clearSchedule = async () => {
    if (!selected) return;
    if (!window.confirm(`Remove schedule for @${selected}?`)) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteBotSchedule(selected);
      setSchedule(null);
      setNotice(`Cleared schedule for @${selected}`);
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    } finally {
      setBusy(false);
    }
  };

  const triggerSchedule = async (force: boolean) => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api.triggerBotSchedule(selected, force);
      if (result.deferred) {
        setNotice(`Deferred (${result.reason}) — next run ${result.next_run_at ? new Date(result.next_run_at).toLocaleString() : 'soon'}`);
      } else if (result.share_url) {
        setNotice(`Scheduled run shared: ${result.share_url}`);
      } else {
        setNotice('Schedule triggered.');
      }
      await selectBot(selected);
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    } finally {
      setBusy(false);
    }
  };

  const generate = async () => {
    const handle = creating ? form.handle.trim().toLowerCase() : selected;
    if (!handle) {
      setError('Save the bot before generating a chat.');
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (creating) {
        setError('Save the bot before generating a chat.');
        return;
      }
      // Empty / already-used prompts are resolved server-side to an unused seed
      // or an invented question that is not a repeat of prior chats.
      const response = await api.generateBotChat(handle, prompt.trim() || undefined);
      rememberChatId(response.chat_id);
      stashBotSession(response.bot.handle, response.run_id);
      stashPendingPrompt(response.prompt);
      const sourceNote =
        response.prompt_source === 'invent'
          ? ' (invented a new question)'
          : response.prompt_source === 'seed'
            ? ' (next unused seed)'
            : '';
      setNotice(`Opening Copilot as @${response.bot.handle}${sourceNote}…`);
      void navigate({ to: '/chat/$chatId', params: { chatId: response.chat_id } });
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    } finally {
      setBusy(false);
    }
  };

  const failRun = async (runId: string) => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.updateBotRun(runId, { status: 'failed', error: 'marked failed by admin' });
      setNotice('Run marked failed.');
      const detail = await api.adminBot(selected);
      setRuns(detail.runs);
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    } finally {
      setBusy(false);
    }
  };

  if (isPending || !isAdmin) return null;

  return (
    <section className="bots-page">
      <header className="bots-hero">
        <Heading level={1}>Bot profiles</Heading>
        <Text type="supporting">
          Admin-only personas that chat with Copilot and publish under a public handle
          (e.g. @nowlobster for live market commentary, @macrolobster for rates / the
          curve, @yololobster for high risk / high reward). Generate opens Chat with the
          persona loaded — successful answers
          auto-share to the timeline as that bot.
        </Text>
      </header>

      {error && <p className="bots-error" role="alert">{error}</p>}
      {notice && <p className="bots-notice">{notice}</p>}

      <div className="bots-layout">
        <aside className="bots-list" aria-label="Bot profiles">
          <div className="bots-list-head">
            <Heading level={2}>Bots</Heading>
            <Button variant="secondary" size="sm" label="New bot" onClick={() => startCreate()} />
          </div>
          {bots.length === 0 && !creating && (
            <Text type="supporting">No bots yet — @nowlobster, @macrolobster, and @yololobster seed on deploy, or create one here.</Text>
          )}
          <ul className="bots-handles">
            {bots.map((bot) => (
              <li key={bot.handle}>
                <button
                  type="button"
                  className={selected === bot.handle && !creating ? 'bots-handle active' : 'bots-handle'}
                  onClick={() => { void selectBot(bot.handle); }}
                >
                  <b>@{bot.handle}</b>
                  <span>{bot.persona}</span>
                  {!bot.enabled && <Token label="off" color="gray" />}
                </button>
              </li>
            ))}
          </ul>
        </aside>

        <VStack className="bots-editor" gap={4}>
          {(selected || creating) ? (
            <>
              <Heading level={2}>{creating ? 'New bot' : `Edit @${selected}`}</Heading>
              <TextInput
                label="Handle"
                value={form.handle}
                onChange={(value) => setForm((prev) => ({ ...prev, handle: value }))}
                isDisabled={!creating || busy}
                description="Public slug at /u/{handle} — lowercase letters and numbers."
              />
              <TextInput
                label="Display name"
                value={form.display_name}
                onChange={(value) => setForm((prev) => ({ ...prev, display_name: value }))}
                isDisabled={busy}
              />
              <TextInput
                label="Persona"
                value={form.persona}
                onChange={(value) => setForm((prev) => ({ ...prev, persona: value }))}
                isDisabled={busy}
                description='Short label, e.g. "High risk, high reward".'
              />
              <TextArea
                label="Bio"
                value={form.bio}
                onChange={(value) => setForm((prev) => ({ ...prev, bio: value }))}
                isDisabled={busy}
                rows={2}
              />
              <TextArea
                label="System prompt extra"
                value={form.system_prompt_extra}
                onChange={(value) => setForm((prev) => ({ ...prev, system_prompt_extra: value }))}
                isDisabled={busy}
                rows={6}
                description="Appended to the base quant Copilot prompt."
              />
              <TextArea
                label="Seed prompts"
                value={form.seed_prompts}
                onChange={(value) => setForm((prev) => ({ ...prev, seed_prompts: value }))}
                isDisabled={busy}
                rows={4}
                description="One starter question per line. Generate prefers the next unused seed, then invents a new question."
              />
              <TextInput
                label="Model override"
                value={form.model}
                onChange={(value) => setForm((prev) => ({ ...prev, model: value }))}
                isDisabled={busy}
                description="Optional OpenRouter model id. Leave blank to use the site default."
              />
              <TextInput
                label="Reasoning effort"
                value={form.reasoning_effort}
                onChange={(value) => setForm((prev) => ({ ...prev, reasoning_effort: value }))}
                isDisabled={busy}
                description="Optional: xhigh | high | medium | low | minimal | none."
              />
              <label className="bots-enabled">
                <input
                  type="checkbox"
                  checked={form.enabled}
                  disabled={busy}
                  onChange={(event) => setForm((prev) => ({ ...prev, enabled: event.target.checked }))}
                />
                Enabled
              </label>
              <div className="bots-actions">
                <Button variant="primary" label={busy ? 'Saving…' : 'Save'} isDisabled={busy} onClick={() => { void save(); }} />
                {!creating && selected && (
                  <Button variant="destructive" label="Delete" isDisabled={busy} onClick={() => { void remove(); }} />
                )}
              </div>

              {!creating && selected && (
                <section className="bots-generate" aria-label="Schedule">
                  <Heading level={3}>Schedule</Heading>
                  <Text type="supporting">
                    Server-side Copilot runs on a cadence (cron wakes due rows). Market-gated
                    schedules only fire during the US session — use force to test after hours.
                    @nowlobster, @macrolobster, and @yololobster ship with hourly market-hours schedules.
                  </Text>
                  <label className="bots-enabled">
                    <input
                      type="checkbox"
                      checked={scheduleForm.enabled}
                      disabled={busy}
                      onChange={(event) => setScheduleForm((prev) => ({ ...prev, enabled: event.target.checked }))}
                    />
                    Schedule enabled
                  </label>
                  <TextInput
                    label="Cadence (seconds)"
                    value={scheduleForm.cadence_seconds}
                    onChange={(value) => setScheduleForm((prev) => ({ ...prev, cadence_seconds: value }))}
                    isDisabled={busy}
                    description="3600 = hourly."
                  />
                  <label className="bots-enabled">
                    <input
                      type="checkbox"
                      checked={scheduleForm.market_gated}
                      disabled={busy}
                      onChange={(event) => setScheduleForm((prev) => ({ ...prev, market_gated: event.target.checked }))}
                    />
                    Market hours only
                  </label>
                  <TextArea
                    label="Schedule prompt"
                    value={scheduleForm.prompt}
                    onChange={(value) => setScheduleForm((prev) => ({ ...prev, prompt: value }))}
                    isDisabled={busy}
                    rows={3}
                    description="Fixed prompt reused each run (unlike manual generate uniqueness)."
                  />
                  {schedule && (
                    <Text type="supporting">
                      Next run {new Date(schedule.next_run_at).toLocaleString()}
                      {schedule.last_run_at ? ` · last ${formatRelativeAge(schedule.last_run_at)}` : ''}
                      {schedule.consecutive_failures > 0 ? ` · ${schedule.consecutive_failures} failure(s)` : ''}
                      {schedule.last_error ? ` · ${schedule.last_error}` : ''}
                    </Text>
                  )}
                  <div className="bots-actions">
                    <Button variant="primary" label={busy ? 'Saving…' : 'Save schedule'} isDisabled={busy} onClick={() => { void saveSchedule(); }} />
                    <Button variant="secondary" label={busy ? 'Running…' : 'Run now'} isDisabled={busy} onClick={() => { void triggerSchedule(false); }} />
                    <Button variant="secondary" label="Force run" isDisabled={busy} onClick={() => { void triggerSchedule(true); }} />
                    {schedule && (
                      <Button variant="destructive" label="Clear" isDisabled={busy} onClick={() => { void clearSchedule(); }} />
                    )}
                  </div>
                </section>
              )}

              {!creating && selected && (
                <section className="bots-generate" aria-label="Generate chat">
                  <Heading level={3}>Generate chat</Heading>
                  <Text type="supporting">
                    Opens Copilot as @{selected} with a prompt that has not already been used
                    in a prior run. Leave blank to take the next unused seed or invent a new
                    question. Successful answers auto-share to the timeline as this bot.
                  </Text>
                  <TextArea
                    label="Prompt (optional)"
                    value={prompt}
                    onChange={setPrompt}
                    isDisabled={busy}
                    rows={3}
                    description="If this matches a prior chat, generate invents or picks an unused seed instead."
                  />
                  <Button
                    variant="primary"
                    label={busy ? 'Starting…' : 'Generate with Copilot'}
                    isDisabled={busy}
                    onClick={() => { void generate(); }}
                  />
                  {runs.length > 0 && (
                    <ul className="bots-runs">
                      {runs.map((run) => (
                        <li key={run.run_id}>
                          <div className="bots-run-main">
                            <Token label={run.status} color={runStatusColor(run.status)} />
                            <time
                              className="bots-run-age"
                              dateTime={new Date(run.created_at).toISOString()}
                              title={new Date(run.created_at).toLocaleString()}
                            >
                              {formatRelativeAge(run.created_at)}
                            </time>
                            <span className="bots-run-prompt">{run.prompt}</span>
                          </div>
                          <div className="bots-run-meta">
                            <a href={`/chat/${run.chat_id}`}>/chat/{run.chat_id.slice(0, 8)}…</a>
                            {run.share_id && (
                              <a href={`/share/${run.share_id}`}>/share/{run.share_id}</a>
                            )}
                            {(run.status === 'queued' || run.status === 'running') && (
                              <Button
                                variant="destructive"
                                size="sm"
                                label="Fail"
                                isDisabled={busy}
                                onClick={() => { void failRun(run.run_id); }}
                              />
                            )}
                          </div>
                          {run.error && <p className="bots-run-error">{run.error}</p>}
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              )}
            </>
          ) : (
            <Text type="supporting">Select a bot or create one to edit its persona and generate chats.</Text>
          )}
        </VStack>
      </div>
    </section>
  );
}
