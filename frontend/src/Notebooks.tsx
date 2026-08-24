import { useNavigate } from '@tanstack/react-router';
import { Heading, Icon, List, ListItem, Text, Token, VStack } from '@astryxdesign/core';
import { ChevronRight, FlaskConical } from 'lucide-react';
import { EXPERIMENTS } from './notebooks/catalog';
import './Notebooks.css';

/** Public index of notebook-style experiments. */
export default function ExperimentsPage() {
  const navigate = useNavigate();

  return (
    <VStack className="notebooks-page" gap={5} paddingBlock={6} paddingInline={5} maxWidth={800}>
      <VStack gap={2}>
        <Heading level={1}>Experiments</Heading>
        <Text type="supporting">
          Public studies of how we present market data to models. Each experiment documents
          a setup and, when available, loads a server-saved run so you can read results
          without spending OpenRouter credits yourself.
        </Text>
      </VStack>

      <List density="spacious" hasDividers header="Studies">
        {EXPERIMENTS.map((experiment) => (
          <ListItem
            key={experiment.slug}
            label={experiment.title}
            description={experiment.subtitle}
            startContent={<Icon icon={FlaskConical} size="md" color="secondary" />}
            endContent={(
              <>
                <Token
                  label={experiment.status}
                  color={experiment.status === 'ready' ? 'teal' : 'gray'}
                  size="sm"
                />
                <Icon icon={ChevronRight} size="sm" color="tertiary" />
              </>
            )}
            onClick={() => {
              void navigate({
                to: experiment.slug === 'text-vs-image'
                  ? '/experiments/text-vs-image'
                  : '/experiments',
              });
            }}
          />
        ))}
      </List>
    </VStack>
  );
}
