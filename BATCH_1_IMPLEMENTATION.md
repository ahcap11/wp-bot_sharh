# SHARH WhatsApp Bot — Funnel Correctness Batch

## Implemented

This batch converts the bot from prompt-led qualification into an application-controlled SHARH funnel.

### Deterministic funnel ownership

- Seller and buyer stages are persisted per chat.
- The application chooses exactly one next required field.
- Standard qualification turns bypass the AI provider.
- The AI prompt is now a constrained fallback and cannot decide qualification or handoff state.
- Provider message IDs are deduplicated and capped to prevent unbounded state growth.

### Seller qualification

A seller is not qualified until the client name, WhatsApp phone, explicit terms acceptance, and all of the following are captured:

- Business activity
- Emirate and area
- Annual revenue
- Lease and rent information
- Expected selling price
- Establishment year
- Employee count
- Monthly operating expenses
- Monthly net profit
- Liabilities
- Licences and important contracts
- Sale reason and desired timing
- Included assets

### Buyer qualification

A general buyer is not qualified until the following are captured:

- Client name and WhatsApp phone
- Sector or business type
- Budget
- Preferred location
- Acquisition timeline
- Operating or passive involvement
- Funding status
- Additional requirements

A request containing an `SH-####` listing code is escalated for controlled listing/version and confidential-access handling.

### Multilingual behavior

- English, Russian, and Arabic deterministic prompts are included.
- Structured money, year, phone, location, and common intent extraction is multilingual.
- The selected language remains stable across short neutral answers.
- “Unknown / to confirm” is represented explicitly rather than silently passing a field.

### Handoff reliability

- Manager notifications are marked delivered only after a successful transport send.
- Failed notifications remain retryable.
- Concurrent duplicate handoff attempts are coalesced.
- The manager summary includes funnel stage, completion, and captured seller/buyer facts.
- After delivery, one closing message is sent and the bot suppresses further automated qualification.
- Human-ownership transitions are exported to Google Sheets when that optional integration is enabled.

## Changed files

- `src/services/lead-capture.service.ts`
- `src/services/handoff.service.ts`
- `src/services/chatbot.service.ts`
- `src/services/google-sheets.service.ts`
- `src/services/ai.service.ts`
- `src/__tests__/lead-capture.service.test.ts`
- `src/__tests__/handoff.service.test.ts`
- `README.md`
- `env.example`

## Production configuration

Set at least one manager WhatsApp JID:

```env
HANDOFF_WHATSAPP_JIDS=971502106179@s.whatsapp.net
```

Keep client role switching disabled while allowing the manager number as an operator:

```env
ROLE_SWITCH_ENABLED=false
OPERATOR_JIDS=971502106179@s.whatsapp.net
```

For a single-instance pilot, persist the state path on a mounted volume:

```env
PERSISTENCE_ENABLED=true
PERSISTENCE_PATH=./.state/state.json
```

## Verification performed

- TypeScript semantic check under strict project flags using dependency type shims.
- Runtime seller funnel assertions through 100% qualification.
- Runtime buyer funnel assertions through 100% qualification.
- Specific-listing escalation assertion.
- Russian language retention assertion.
- Human-ownership suppression assertion.
- Handoff failure/retry/deduplication assertions.

The package registry available in the execution environment did not permit a normal `npm ci`, so the repository's Jest suite was not executed here. Run `npm ci && npm test && npm run build` in the deployment environment before release.

## Next integration batch

The next batch should replace direct Neon lookup and file-backed funnel state with authenticated SHARH backend APIs and PostgreSQL entities for contacts, seller intakes, buyer enquiries, listing-version lookup, NDA/access requests, handoffs, and analytics events.
