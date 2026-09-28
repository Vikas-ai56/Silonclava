Mutual NDA. Use for first-meeting counterparties before sharing materials. Reviewed by ops 2026-05.

Fields the agent must collect before drafting (the `nda-builder` skill renders the document):

- `counterparty_name` — legal name of the other party.
- `counterparty_email` — contact email for legal notice.
- `term_years` — confidentiality term, 1–5.
- `effective_date` — ISO date (YYYY-MM-DD).
- `governing_law` — one of `Singapore`, `India`, `Delaware`.

The agent never writes legal language — only fills these slots. Clause text
lives in `template.docx`, which is reviewed and version-controlled by ops.
