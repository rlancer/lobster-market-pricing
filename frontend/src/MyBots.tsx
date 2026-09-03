import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { Button, Heading, HStack, Spinner, Text, TextArea, TextInput, Token, VStack } from '@astryxdesign/core';
import { api, type UserBot, type UserBotPortfolioOption, type UserBotPreset, type UserBotRun, type UserBotTemplate } from './api';
import { authClient } from './auth';
import { SignInEmptyState } from './SignInEmptyState';

const FALLBACK_PORTFOLIOS: UserBotPortfolioOption[] = [
  { id: 'none', label: "Don't attach a portfolio", source: 'none', account_id: null },
  { id: 'paper', label: 'Paper book', source: 'paper', account_id: null },
];

const EMPTY_FORM = {
  name: '',
  template_id: 'portfolio_risk' as string,
  prompt: '',
  schedule_preset: 'hourly_market',
  portfolio_id: 'paper',
  email_alerts: true,
  publish_to_timeline: false,
};

function portfolioHint(option: UserBotPortfolioOption | undefined): string {
  if (!option || option.source === 'none') {
    return 'The briefing runs without reading a book.';
  }
  if (option.source === 'paper') {
    return 'Reads your paper book — tracked Copilot suggestions and cash.';
  }
  if (option.source === 'all') {
    return 'Reads the paper book and every linked Schwab account.';
  }
  if (option.account_id) {
    return `Reads only ${option.label}.`;
  }
  return 'Reads every linked Schwab account.';
}

const KNOWN_PORTFOLIO_LABELS: Record<string, string> = {
  none: "Don't attach a portfolio",
  paper: 'Paper book',
  schwab: 'All Schwab accounts',
  all: 'Paper book + Schwab',
};

function botPortfolioId(bot: Pick<UserBot, 'portfolio_id' | 'attach_portfolio'>): string {
  return bot.portfolio_id ?? (bot.attach_portfolio ? 'all' : 'none');
}

function portfolioLabel(portfolios: UserBotPortfolioOption[], selectedId: string): string {
  return withSelectedPortfolio(portfolios, selectedId).find((item) => item.id === selectedId)?.label
    ?? KNOWN_PORTFOLIO_LABELS[selectedId]
    ?? 'Paper book';
}

function withSelectedPortfolio(
  portfolios: UserBotPortfolioOption[],
  selectedId: string,
): UserBotPortfolioOption[] {
  if (portfolios.some((item) => item.id === selectedId)) return portfolios;
  if (!selectedId) return portfolios;
  const source = selectedId === 'none' || selectedId === 'paper' || selectedId === 'schwab' || selectedId === 'all'
    ? selectedId
    : selectedId.startsWith('schwab:') ? 'schwab' : 'paper';
  return [
    ...portfolios,
    {
      id: selectedId,
      label: KNOWN_PORTFOLIO_LABELS[selectedId] ?? selectedId,
      source,
      account_id: source === 'schwab' && selectedId.startsWith('schwab:')
        ? selectedId.slice('schwab:'.length)
        : null,
    },
  ];
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
  const [portfolios, setPortfolios] = useState<UserBotPortfolioOption[]>(FALLBACK_PORTFOLIOS);
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
    setPortfolios(data.portfolios?.length ? data.portfolios : FALLBACK_PORTFOLIOS);
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
        portfolio_id: botPortfolioId(bot),
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
  }, [selected, creating, bots]);

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
        portfolio_id: form.portfolio_id,
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

  async function trigger(force: boolean) {
    if (!selected) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api.triggerMyBot(selected, force);
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
      setError(err instanceof Error ? err.message : 'Could not run bot');
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
          public timeline unless you opt in. Pick which book to attach —
          paper, a Schwab account, or none — so the bot reads that book
          and flags risk.
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
              <Text type="supporting">{portfolioLabel(portfolios, botPortfolioId(bot))}</Text>
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

          <VStack gap={2}>
            <Text type="body" weight="semibold">What should it do?</Text>
            <HStack gap={2} wrap="wrap">
              {templates.map((template) => (
                <Button
                  key={template.id}
                  variant={form.template_id === template.id ? 'primary' : 'secondary'}
                  size="sm"
                  label={template.label}
                  isDisabled={busy}
                  onClick={() => applyTemplate(template.id)}
                />
              ))}
            </HStack>
            <TextArea
              label="Instructions"
              value={form.prompt}
              onChange={(value) => setForm((prev) => ({ ...prev, prompt: value, template_id: 'custom' }))}
              isDisabled={busy}
              rows={5}
              description="Plain English — no cron syntax. The bot repeats this each run."
            />
          </VStack>

          <VStack gap={2}>
            <Text type="body" weight="semibold">How often?</Text>
            {presets.map((preset) => (
              <Button
                key={preset.id}
                variant={form.schedule_preset === preset.id ? 'primary' : 'secondary'}
                size="sm"
                label={preset.label}
                isDisabled={busy}
                onClick={() => setForm((prev) => ({ ...prev, schedule_preset: preset.id }))}
              />
            ))}
            <Text type="supporting">
              {presets.find((preset) => preset.id === form.schedule_preset)?.description}
            </Text>
          </VStack>

          <VStack gap={2}>
            <Text type="body" weight="semibold">Which portfolio?</Text>
            {withSelectedPortfolio(portfolios, form.portfolio_id).map((option) => (
              <Button
                key={option.id}
                variant={form.portfolio_id === option.id ? 'primary' : 'secondary'}
                size="sm"
                label={option.label}
                isDisabled={busy}
                onClick={() => setForm((prev) => ({ ...prev, portfolio_id: option.id }))}
              />
            ))}
            <Text type="supporting">
              {portfolioHint(
                withSelectedPortfolio(portfolios, form.portfolio_id)
                  .find((item) => item.id === form.portfolio_id),
              )}
            </Text>
            {portfolios.every((item) => item.source !== 'schwab') ? (
              <Link to="/portfolio">
                <Text type="supporting">Connect Schwab on Portfolio to attach a brokerage account.</Text>
              </Link>
            ) : null}
            <Button
              variant={form.email_alerts ? 'primary' : 'secondary'}
              size="sm"
              label={form.email_alerts ? 'Email me after each run' : 'No email alerts'}
              isDisabled={busy}
              onClick={() => setForm((prev) => ({ ...prev, email_alerts: !prev.email_alerts }))}
            />
            <Button
              variant={form.publish_to_timeline ? 'primary' : 'secondary'}
              size="sm"
              label={form.publish_to_timeline ? 'Also publish to my timeline' : 'Keep private (not on the timeline)'}
              isDisabled={busy || (!hasHandle && !form.publish_to_timeline)}
              onClick={() => setForm((prev) => ({ ...prev, publish_to_timeline: !prev.publish_to_timeline }))}
            />
            {!hasHandle ? (
              <Text type="supporting">
                Claim a public handle on Account if you want an optional timeline post.
              </Text>
            ) : (
              <Text type="supporting">
                Private is the default. Publishing lists the briefing under your handle, not as a public bot.
              </Text>
            )}
          </VStack>

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
                  onClick={() => { void trigger(false); }}
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
