import { useEffect } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Heading, Icon, List, ListItem, Text, Token, VStack } from '@astryxdesign/core';
import { ChevronRight, FlaskConical } from 'lucide-react';
import { useIsAdmin } from './useAdmin';
import { NOTEBOOKS } from './notebooks/catalog';
import './Notebooks.css';

/** Admin-only index of experimental notebooks. */
export default function NotebooksPage() {
  const navigate = useNavigate();
  const { isAdmin, isPending } = useIsAdmin();

  useEffect(() => {
    if (!isPending && !isAdmin) {
      void navigate({ to: '/' });
    }
  }, [isAdmin, isPending, navigate]);

  if (isPending || !isAdmin) {
    return (
      <VStack className="notebooks-page" gap={3} paddingBlock={6} paddingInline={5}>
        <Text color="secondary">Checking admin access…</Text>
      </VStack>
    );
  }

  return (
    <VStack className="notebooks-page" gap={5} paddingBlock={6} paddingInline={5} maxWidth={800}>
      <VStack gap={2}>
        <Heading level={1}>Notebooks</Heading>
        <Text type="supporting">
          Admin-only experiments. Each notebook is a standard page that documents a study
          and, when useful, runs live probes against OpenRouter.
        </Text>
      </VStack>

      <List density="spacious" hasDividers header="Experiments">
        {NOTEBOOKS.map((notebook) => (
          <ListItem
            key={notebook.slug}
            label={notebook.title}
            description={notebook.subtitle}
            startContent={<Icon icon={FlaskConical} size="md" color="secondary" />}
            endContent={(
              <>
                <Token
                  label={notebook.status}
                  color={notebook.status === 'ready' ? 'teal' : 'gray'}
                  size="sm"
                />
                <Icon icon={ChevronRight} size="sm" color="tertiary" />
              </>
            )}
            onClick={() => {
              void navigate({
                to: notebook.slug === 'text-vs-image'
                  ? '/notebooks/text-vs-image'
                  : '/notebooks',
              });
            }}
          />
        ))}
      </List>
    </VStack>
  );
}
