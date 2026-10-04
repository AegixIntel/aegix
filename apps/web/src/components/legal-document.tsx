import type { ReactNode } from "react";
import { SectionLabel, EditorialHeading } from "@/components/ui/primitives";
import { LEGAL_CONTACT_EMAIL, LEGAL_ENTITY } from "@/lib/site";

export interface LegalSection {
  title: string;
  body: ReactNode;
}

/** Shared layout for the Terms of Service, Privacy Policy and Refund Policy. */
export function LegalDocument({
  label,
  title,
  effectiveDate,
  intro,
  sections
}: {
  label: string;
  title: string;
  effectiveDate: string;
  intro: ReactNode;
  sections: LegalSection[];
}) {
  return (
    <div className="pb-24">
      <div className="container-narrow py-20 md:py-24">
        <SectionLabel>{label}</SectionLabel>
        <EditorialHeading as="h1" className="mt-6">
          {title}
        </EditorialHeading>
        <p className="mt-4 text-sm text-muted-2">Effective {effectiveDate}</p>
        <p className="mt-8 editorial-body">{intro}</p>
      </div>

      <div className="container-narrow">
        {sections.map((section) => (
          <section
            key={section.title}
            className="border-t border-ink/10 py-8 text-sm leading-relaxed text-muted-foreground [&_a]:text-ink [&_a]:underline [&_a]:underline-offset-4 [&_li]:mt-1.5 [&_p+p]:mt-3 [&_p+ul]:mt-3 [&_ul+p]:mt-3 [&_ul]:list-disc [&_ul]:pl-5"
          >
            <h2 className="mb-3 font-display text-lg font-semibold text-ink">{section.title}</h2>
            {section.body}
          </section>
        ))}

        <section className="border-t border-ink/10 py-8 text-sm leading-relaxed text-muted-foreground">
          <h2 className="mb-3 font-display text-lg font-semibold text-ink">Contact</h2>
          <p>
            {LEGAL_CONTACT_EMAIL ? (
              <>
                Questions about this document can be sent to {LEGAL_ENTITY} at{" "}
                <a href={`mailto:${LEGAL_CONTACT_EMAIL}`} className="text-ink underline underline-offset-4">
                  {LEGAL_CONTACT_EMAIL}
                </a>
                .
              </>
            ) : (
              <>This document is issued by {LEGAL_ENTITY}.</>
            )}
          </p>
        </section>
      </div>
    </div>
  );
}
