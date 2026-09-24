// Automation → AI connection (MCP).
//
// The panel itself lived in Settings from 2026-09-21 until 2026-09-23, where
// nobody found it. It is here now because an AI trading through the app is
// one more way of acting without your click — which is what the Automation
// workspace is for. Settings keeps a pointer to this page.
//
// The page leads with what MCP IS in plain words, because the name means
// nothing to most people and the panel below assumes you already know.

import { Card, Page, Section } from '../components/common';
import { McpPanel } from '../components/terminal/McpPanel';

export function AiConnectionPage() {
  return (
    <Page
      title="AI connection"
      subtitle="Let an AI assistant, like Claude, read this app — and trade through it only if you allow it."
    >
      <Section title="What this is">
        <Card className="space-y-2">
          <p className="text-body leading-relaxed text-krypt-muted">
            <span className="text-white">MCP</span> (Model Context Protocol) is the standard way AI assistants plug into
            other programs. Turn it on here and an assistant like Claude can ask this app questions:{' '}
            <span className="text-white">what am I holding, look up this coin, what did the scanner flag today</span>.
          </p>
          <p className="text-body leading-relaxed text-krypt-muted">
            It only talks to this computer. It starts <span className="text-white">off</span>, and when you turn it on it
            starts <span className="text-white">read-only</span>. If you let it trade, it asks the app for a buy or a sell
            and the app builds it the same way as the buttons: same fees, same limits, same safety breakers, plus the
            spending limits you set below. It can never sign anything, move funds or change a setting.
          </p>
          <p className="text-label leading-relaxed text-krypt-muted/70">
            Step-by-step: Guides → AI connection.
          </p>
        </Card>
      </Section>

      <Section
        title="Connection"
        description="Switch it on, choose how far it reaches, then copy the line that connects your assistant. The limits only matter once you choose Live."
      >
        <McpPanel />
      </Section>
    </Page>
  );
}
