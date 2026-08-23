import { Heading, HStack, Link, Text, VStack } from '@astryxdesign/core';
import './NotebookPage.css';

/** Static marimo islands export (Pyodide WASM + CDN runtime). */
const NOTEBOOK_SRC = '/notebooks/lake-sectors/index.html';

/**
 * Prototype host for marimo WASM notebooks.
 * The notebook runs in-browser; lake data comes from the screener Worker.
 */
export default function NotebookPage() {
  return (
    <VStack className="notebook-page" gap={3} height="100%">
      <VStack gap={1}>
        <HStack gap={3} align="center" justify="between">
          <Heading level={1}>Notebook</Heading>
          <Link href={NOTEBOOK_SRC} isStandalone isExternalLink>
            Open fullscreen
          </Link>
        </HStack>
        <Text color="secondary" size="sm">
          Marimo WASM prototype — first load downloads Pyodide (~30s). Then it
          charts live <code>/api/sectors</code> and runs a small lake SQL query.
          No Python on the Worker.
        </Text>
      </VStack>
      <iframe
        className="notebook-frame"
        title="Lake sectors marimo notebook"
        src={NOTEBOOK_SRC}
        sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-popups"
        allow="fullscreen"
      />
    </VStack>
  );
}
