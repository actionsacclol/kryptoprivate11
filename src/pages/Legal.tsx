import { useEffect, useState } from 'react';
import { FileText, ShieldCheck } from 'lucide-react';
import { ALL_DOCUMENTS, type LegalDocument } from '@shared/legal/documents';
import { entityInfo, COPYRIGHT_LINE } from '@shared/legal/entity';
import { Card, Page, Section } from '../components/common';
import { cls } from '../utils/format';

// The full documents, readable offline.
//
// legalcheck.md wants the full text reachable from the clickwrap and from a
// footer. In a desktop app with no browser chrome, "opens in a new tab" means
// this page — and it must work with no network, because a user who has just
// been asked to agree to something is entitled to read it even if their
// connection is down.

function DocumentBody({ doc }: { doc: LegalDocument }) {
  return (
    <div className="space-y-4">
      {doc.sections.map((sec) => (
        <div key={sec.heading}>
          <h3
            className={cls(
              'text-note font-semibold mb-1',
              sec.emphasis ? 'text-arc-gold' : 'text-white',
            )}
          >
            {sec.heading}
          </h3>
          {sec.body.map((para, i) => (
            <p
              key={i}
              className={cls(
                'text-body leading-relaxed mb-1.5',
                // Emphasised sections are the ones a court expects to be
                // conspicuous: warranty disclaimer, liability cap, arbitration.
                sec.emphasis ? 'text-white/90 font-medium' : 'text-krypt-muted',
              )}
            >
              {para}
            </p>
          ))}
        </div>
      ))}
    </div>
  );
}

export function LegalPage() {
  const [open, setOpen] = useState<LegalDocument['id']>('terms');
  const [status, setStatus] = useState<{ acceptedAt: string | null; acceptedVersion: string | null } | null>(null);
  const info = entityInfo();

  useEffect(() => {
    void (async () => {
      const r = await window.krypt.legal.status();
      if (r.ok && r.data) setStatus({ acceptedAt: r.data.acceptedAt, acceptedVersion: r.data.acceptedVersion });
    })();
  }, []);

  const doc = ALL_DOCUMENTS.find((d) => d.id === open) ?? ALL_DOCUMENTS[0];

  return (
    <Page title="Legal" subtitle={`${info.entity} · terms version ${info.termsVersion}`}>
      <Section title="Your acceptance">
        <Card>
          <div className="flex items-start gap-2">
            <ShieldCheck className="h-4 w-4 text-emerald-300 mt-0.5 flex-shrink-0" />
            <div className="text-body leading-relaxed text-krypt-muted">
              {status?.acceptedAt ? (
                <>
                  You accepted version <span className="text-white">{status.acceptedVersion}</span> on{' '}
                  <span className="text-white">{new Date(status.acceptedAt).toLocaleString()}</span>. The record is
                  stored on this machine, including a checksum of the exact text you were shown.
                </>
              ) : (
                <>No acceptance recorded on this machine yet.</>
              )}
              {!info.suffixConfirmed && (
                <div className="mt-1.5 text-arc-gold/80">
                  Note: the operator&apos;s registered legal name has not yet been confirmed against the company
                  register, including whether it carries a suffix such as LLC.
                </div>
              )}
            </div>
          </div>
        </Card>
      </Section>

      <Section title="Documents">
        <div className="flex flex-wrap gap-2 mb-3">
          {ALL_DOCUMENTS.map((d) => (
            <button
              key={d.id}
              onClick={() => setOpen(d.id)}
              className={cls(
                'inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-body font-semibold transition',
                d.id === open
                  ? 'border-krypt-purple/40 bg-krypt-purple/15 text-white'
                  : 'border-white/10 bg-black/25 text-krypt-muted hover:text-white',
              )}
            >
              <FileText className="h-3.5 w-3.5" />
              {d.title}
            </button>
          ))}
        </div>
        <Card>
          <div className="mb-3">
            <div className="font-display text-value font-semibold text-white">{doc.title}</div>
            <div className="text-label text-krypt-muted/70">{doc.subtitle}</div>
          </div>
          <DocumentBody doc={doc} />
        </Card>
      </Section>

      <Section title="Contact">
        <Card>
          <p className="text-body leading-relaxed text-krypt-muted">
            {info.entity} · {info.email} · {info.website}
          </p>
          <p className="mt-1 text-body text-krypt-muted/70">
            Provided as-is with no warranty. No affiliation with, sponsorship by, or endorsement from any third party
            is implied; all third-party names and marks belong to their owners. {COPYRIGHT_LINE}
          </p>
        </Card>
      </Section>
    </Page>
  );
}
