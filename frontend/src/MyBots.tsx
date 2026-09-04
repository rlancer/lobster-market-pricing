import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { Button, Heading, HStack, Spinner, Text, TextArea, TextInput, Token, VStack } from '@astryxdesign/core';
import { MultiSelector } from '@astryxdesign/core/MultiSelector';
import { Selector } from '@astryxdesign/core/Selector';
import { Switch } from '@astryxdesign/core/Switch';
import { api, type UserBot, type UserBotPortfolioOption, type UserBotPreset, type UserBotRun, type UserBotTemplate } from './api';
import { authClient } from './auth';
import { SignInEmptyState } from './SignInEmptyState';

const FALLBACK_BOOKS: UserBotPortfolioOption[] = [
  { id: 'paper', label: 'Paper book', source: 'paper', account_id: null },
];

const EMPTY_FORM = {
  name: '',
  template_id: 'portfolio_risk' as string,
  prompt: '',
  schedule_preset: 'hourly_market',
  portfolio_ids: ['paper'] as string[],
  email_alerts: true,
  publish_to_timeline: false,
};

function bookOptions(
  portfolios: UserBotPortfolioOption[],
  books: UserBotPortfolioOption[],
): UserBotPortfolioOption[] {
  const fromApi = books.length ? books : portfolios.filter((item) => item.id === 'paper' || Boolean(item.account_id));
  return fromApi.length ? fromApi : FALLBACK_BOOKS;
}

function botPortfolioIds(bot: Pick<UserBot, 'portfolio_ids' | 'portfolio_id' | 'attach_portfolio'>): string[] {
  if (Array.isArray(bot.portfolio_ids)) return bot.portfolio_ids;
  if (bot.portfolio_id) return bot.portfolio_id === 'none' ? [] : [bot.portfolio_id];
  return bot.attach_portfolio ? ['paper'] : [];
}

function expandPortfolioIds(ids: string[], books: UserBotPortfolioOption[]): string[] {
  const schwabIds = books.filter((item) => item.account_id).map((item) => item.id);
  const selected = new Set<string>();
  for (const id of ids) {
    if (id === 'paper' || id === 'all') selected.add('paper');
    if (id === 'schwab' || id === 'all') schwabIds.forEach((item) => selected.add(item));
    if (id.startsWith('schwab:')) selected.add(id);
  }
  return [...selected];
}

function portfolioHint(ids: string[], books: UserBotPortfolioOption[]): string {
  const selected = expandPortfolioIds(ids, books);
  const hasPaper = selected.includes('paper');
  const schwab = selected.filter((id) => id.startsWith('schwab:'));
  if (!hasPaper && schwab.length === 0) return 'The briefing runs without reading a book.';
  if (hasPaper && schwab.length === 0) return 'Reads your paper book — tracked Copilot suggestions and cash.';
  if (!hasPaper && schwab.length === 1) {
    const label = books.find((item) => item.id === schwab[0])?.label ?? 'that Schwab account';
    return `Reads only ${label}.`;
  }
  if (!hasPaper) return 'Reads the selected Schwab accounts.';
  return schwab.length === 1
    ? 'Reads the paper book and the selected Schwab account.'
    : 'Reads the paper book and the selected Schwab accounts.';
}

function portfolioLabel(ids: string[], books: UserBotPortfolioOption[]): string {
  const selected = expandPortfolioIds(ids, books);
  if (selected.length === 0) return 'No portfolio';
  return selected
    .map((id) => books.find((item) => item.id === id)?.label ?? (id === 'paper' ? 'Paper book' : id))
    .join(', ');
}

function formatRelativeAge(createdAtMs: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - createdAtMs) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function runStatusColor(status: UserBotRun['status']): 'green' | 'red' | 'blue' {
  if (status === 'shared' || status === 'completed') return 'green';
  if (status === 'failed') return 'red';
  return 'blue';
}

function presetLabel(presets: UserBotPreset[], id: string): string {
  return presets.find((preset) => preset.id === id)?.label ?? id;
}

/**
 * Signed-in personal bots — friendly schedules, portfolio attached, private
 * by default (no timeline post unless the owner opts in).
 */
export default function MyBotsPage() {
  const navigate = useNavigate();
  const { data: session, isPending } = authClient.useSession();
  const user = session?.user ?? null;
  const [bots, setBots] = useState<UserBot[]>([]);
  const [presets, setPresets] = useState<UserBotPreset[]>([]);
  const [templates, setTemplates] = useState<UserBotTemplate[]>([]);
  const [books, setBooks] = useState<UserBotPortfolioOption[]>(FALLBACK_BOOKS);
  const [selected, setSelected] = useState<string | null>(null);
  const [runs, setRuns] = useState<UserBotRun[]>([]);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [hasHandle, setHasHandle] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadList = useCallback(async () => {
    const data = await api.myBots();
    setBots(data.items);
    setPresets(data.presets);
    setTemplates(data.templates);
    setBooks(bookOptions(data.portfolios ?? [], data.books ?? []));
    return data;
  }, []);

  useEffect(() => {
    if (!user) {
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    Promise.all([loadList(), api.me()]).then(([data, me]) => {
      if (!active) return;
      setHasHandle(Boolean(me.handle));
      setSelected((current) => current ?? data.items[0]?.bot_id ?? null);
    }).catch((err) => {
      if (active) setError(err instanceof Error ? err.message : 'Could not load bots');
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [user, loadList]);

  useEffect(() => {
    if (!selected || creating) {
      setRuns([]);
      return;
    }
    const bot = bots.find((item) => item.bot_id === selected);
    if (bot) {
      setForm({
        name: bot.name,
        template_id: 'custom',
        prompt: bot.prompt,
        schedule_preset: bot.schedule_preset,
        portfolio_ids: expandPortfolioIds(botPortfolioIds(bot), books),
        email_alerts: bot.email_alerts,
        publish_to_timeline: bot.publish_to_timeline,
      });
    }
    let active = true;
    api.myBot(selected).then((data) => {
      if (active) setRuns(data.runs);
    }).catch(() => {
      if (active) setRuns([]);
    });
    return () => { active = false; };
  }, [selected, creating, bots, books]);

  function startCreate() {
    const template = templates.find((item) => item.id === 'portfolio_risk') ?? templates[0];
    setCreating(true);
    setSelected(null);
    setRuns([]);
    setError(null);
    setNotice(null);
    setForm({
      ...EMPTY_FORM,
      prompt: template?.prompt ?? '',
      template_id: template?.id ?? 'custom',
    });
  }

  function applyTemplate(id: string) {
    const template = templates.find((item) => item.id === id);
    setForm((prev) => ({
      ...prev,
      template_id: id,
      prompt: template && template.prompt ? template.prompt : (id === 'custom' ? prev.prompt : ''),
    }));
  }

  async function save() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const body = {
        name: form.name,
        prompt: form.prompt,
        template_id: form.template_id,
        schedule_preset: form.schedule_preset,
        portfolio_ids: form.portfolio_ids,
        email_alerts: form.email_alerts,
        publish_to_timeline: form.publish_to_timeline,
      };
      if (creating) {
        const created = await api.createMyBot(body);
        setCreating(false);
        setSelected(created.bot.bot_id);
        setNotice('Bot saved. It will run on the next scheduled wake.');
      } else if (selected) {
        await api.updateMyBot(selected, body);
        setNotice('Bot updated.');
      }
      await loadList();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save bot');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteMyBot(selected);
      setSelected(null);
      setCreating(false);
      const data = await loadList();
      setSelected(data.items[0]?.bot_id ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete bot');
    } finally {
      setBusy(false);
    }
  }

  async function toggleEnabled(bot: UserBot) {
    setBusy(true);
    setError(null);
    try {
      await api.updateMyBot(bot.bot_id, { enabled: !bot.enabled });
      await loadList();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update bot');
    } finally {
      setBusy(false);
    }
  }

  async function trigger() {
    if (!selected) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api.triggerMyBot(selected);
      if (result.deferred) {
        setNotice(`Market is closed (${result.reason}). Next run ${result.next_run_at ? new Date(result.next_run_at).toLocaleString() : 'later'}.`);
      } else if (result.chat_id) {
        setNotice('Run finished. Opening the briefing…');
        void navigate({ to: '/chat/$chatId', params: { chatId: result.chat_id } });
      }
      await loadList();
      const detail = await api.myBot(selected);
      setRuns(detail.runs);
    } catch (err) {
      const raw = err instanceof Error ? err.message : 'Could not run bot';
      const jsonStart = raw.indexOf('{');
      if (jsonStart >= 0) {
        try {
          const body = JSON.parse(raw.slice(jsonStart)) as { error?: string };
          if (typeof body.error === 'string' && body.error.includes('already has a run')) {
            setError('A run is already in progress. Wait about two minutes, then try Run now again — do not open the chat while it is generating.');
          } else {
            setError(typeof body.error === 'string' ? body.error : raw);
          }
        } catch {
          setError(raw);
        }
      } else {
        setError(raw);
      }
    } finally {
      setBusy(false);
    }
  }

  if (isPending || (user && loading && bots.length === 0 && !error)) {
    return (
      <VStack gap={5} paddingBlock={6} paddingInline={5}>
        <Spinner size="md" label="Loading bots" />
      </VStack>
    );
  }

  if (!user) {
    return (
      <SignInEmptyState title="My bots">
        Sign in to schedule a private Copilot that watches your portfolio
        — for example every hour during US market hours — and emails you
        when something needs attention.
      </SignInEmptyState>
    );
  }

  const selectedBot = bots.find((bot) => bot.bot_id === selected) ?? null;
  const showForm = creating || selectedBot != null;

  return (
    <VStack gap={6} paddingBlock={6} paddingInline={5} maxWidth={720}>
      <VStack gap={2}>
        <Heading level={1}>My bots</Heading>
        <Text type="supporting">
          Private scheduled briefings for your account. They stay off the
          Floor unless you opt in. Attach the paper book, one or
          more Schwab accounts, or nothing — the bot only reads what you check.
        </Text>
      </VStack>

      <HStack gap={2} wrap="wrap">
        <Button
          variant="primary"
          size="sm"
          label="New bot"
          isDisabled={busy}
          onClick={startCreate}
        />
        <Link to="/account">
          <Text type="supporting">Account settings</Text>
        </Link>
        <Link to="/portfolio">
          <Text type="supporting">Portfolio</Text>
        </Link>
      </HStack>

      {error ? <Text type="supporting">{error}</Text> : null}
      {notice ? <Text type="supporting">{notice}</Text> : null}

      {bots.length > 0 ? (
        <VStack gap={3}>
          <Heading level={2}>Your bots</Heading>
          {bots.map((bot) => (
            <HStack key={bot.bot_id} gap={3} vAlign="center" wrap="wrap">
              <Button
                variant={selected === bot.bot_id && !creating ? 'primary' : 'secondary'}
                size="sm"
                label={bot.name}
                isDisabled={busy}
                onClick={() => {
                  setCreating(false);
                  setSelected(bot.bot_id);
                  setError(null);
                  setNotice(null);
                }}
              />
              <Token label={bot.enabled ? 'On' : 'Paused'} color={bot.enabled ? 'green' : 'red'} />
              <Text type="supporting">{presetLabel(presets, bot.schedule_preset)}</Text>
              <Text type="supporting">{portfolioLabel(botPortfolioIds(bot), books)}</Text>
            </HStack>
          ))}
        </VStack>
      ) : !creating ? (
        <Text type="supporting">
          No bots yet. Create one to get an hourly risk check during the US session.
        </Text>
      ) : null}

      {showForm ? (
        <VStack gap={4}>
          <Heading level={2}>{creating ? 'Create a bot' : selectedBot?.name}</Heading>
          <TextInput
            label="Name"
            value={form.name}
            onChange={(value) => setForm((prev) => ({ ...prev, name: value }))}
            isDisabled={busy}
            placeholder="Portfolio risk"
            description="Shown in Chat history and alert emails."
          />

          <Selector
            label="What should it do?"
            options={templates.map((template) => ({ value: template.id, label: template.label }))}
            value={form.template_id}
            onChange={(value) => applyTemplate(value)}
            isDisabled={busy}
            width="100%"
          />
          <TextArea
            label="Instructions"
            value={form.prompt}
            onChange={(value) => setForm((prev) => ({ ...prev, prompt: value, template_id: 'custom' }))}
            isDisabled={busy}
            rows={5}
            description="Plain English — no cron syntax. The bot repeats this each run."
          />

          <Selector
            label="How often?"
            options={presets.map((preset) => ({ value: preset.id, label: preset.label }))}
            value={form.schedule_preset}
            onChange={(value) => setForm((prev) => ({ ...prev, schedule_preset: value }))}
            description={presets.find((preset) => preset.id === form.schedule_preset)?.description}
            isDisabled={busy}
            width="100%"
          />

          <MultiSelector
            label="Which portfolios?"
            description={portfolioHint(form.portfolio_ids, books)}
            options={books.map((option) => ({ value: option.id, label: option.label }))}
            value={expandPortfolioIds(form.portfolio_ids, books)}
            onChange={(value) => setForm((prev) => ({ ...prev, portfolio_ids: value }))}
            triggerDisplay="labels"
            hasSelectAll={books.length > 1}
            placeholder="Don't attach a portfolio"
            isDisabled={busy}
            width="100%"
          />
          {books.every((item) => item.source !== 'schwab') ? (
            <Link to="/portfolio">
              <Text type="supporting">Connect Schwab on Portfolio to attach a brokerage account.</Text>
            </Link>
          ) : null}

          <Switch
            label="Email me after each run"
            value={form.email_alerts}
            onChange={(checked) => setForm((prev) => ({ ...prev, email_alerts: checked }))}
            isDisabled={busy}
            width="100%"
          />
          <Switch
            label="Publish to my Floor"
            description={
              hasHandle
                ? 'Private is the default. Publishing lists the briefing under your handle, not as a public bot.'
                : 'Claim a public handle on Account if you want an optional Floor post.'
            }
            value={form.publish_to_timeline}
            onChange={(checked) => setForm((prev) => ({ ...prev, publish_to_timeline: checked }))}
            isDisabled={busy || (!hasHandle && !form.publish_to_timeline)}
            disabledMessage={hasHandle ? undefined : 'Claim a public handle on Account first.'}
            width="100%"
          />

          <HStack gap={2} wrap="wrap">
            <Button
              variant="primary"
              label={busy ? 'Saving…' : creating ? 'Create bot' : 'Save changes'}
              isDisabled={busy}
              onClick={() => { void save(); }}
            />
            {!creating && selectedBot ? (
              <>
                <Button
                  variant="secondary"
                  label={selectedBot.enabled ? 'Pause' : 'Resume'}
                  isDisabled={busy}
                  onClick={() => { void toggleEnabled(selectedBot); }}
                />
                <Button
                  variant="secondary"
                  label={busy ? 'Running…' : 'Run now'}
                  isDisabled={busy}
                  onClick={() => { void trigger(); }}
                />
                <Button
                  variant="destructive"
                  label="Delete"
                  isDisabled={busy}
                  onClick={() => { void remove(); }}
                />
              </>
            ) : null}
          </HStack>

          {!creating && selectedBot ? (
            <Text type="supporting">
              Next run {new Date(selectedBot.next_run_at).toLocaleString()}
              {selectedBot.last_run_at ? ` · last ${formatRelativeAge(selectedBot.last_run_at)}` : ''}
              {selectedBot.consecutive_failures > 0 ? ` · ${selectedBot.consecutive_failures} failure(s)` : ''}
              {selectedBot.last_error ? ` · ${selectedBot.last_error}` : ''}
            </Text>
          ) : null}

          {!creating && runs.length > 0 ? (
            <VStack gap={2}>
              <Heading level={3}>Recent runs</Heading>
              {runs.map((run) => (
                <HStack key={run.run_id} gap={2} wrap="wrap" vAlign="center">
                  <Token label={run.status} color={runStatusColor(run.status)} />
                  <Text type="supporting">{formatRelativeAge(run.created_at)}</Text>
                  <Link to="/chat/$chatId" params={{ chatId: run.chat_id }}>
                    <Text type="supporting">Open chat</Text>
                  </Link>
                  {run.share_id ? (
                    <Link to="/share/$shareId" params={{ shareId: run.share_id }}>
                      <Text type="supporting">Share</Text>
                    </Link>
                  ) : null}
                  {run.error ? <Text type="supporting">{run.error}</Text> : null}
                </HStack>
              ))}
            </VStack>
          ) : null}
        </VStack>
      ) : null}
    </VStack>
  );
}
