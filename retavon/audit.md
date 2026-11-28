# Retavon API description: audit for documentation

Prepared 2026-11-27 from Retavon API 0.1.0 as its `/openapi` endpoints served it that day to one
business's key: 565 operations, 470 paths, 845 schemas. Operations of features that business has
turned off are left out by the API and were not seen.

This covers the API description only: what a tool that reads OpenAPI can learn from it. It does not
assess how the API behaves, and no call that changes data was made.

## Update, 2026-11-28

Re-read with every available feature switched on: 795 operations, 643 paths, 1,154 schemas.

- **Finding 3 is fixed.** Every path parameter now has an example (467 of 467).
- **Finding 6 is fixed.** `setNextNumber` has an example.
- **Finding 1 stands**, on all 795 operations. Findings 2 and 4 stand.
- **Finding 5:** five create operations now do not show the new identifier, up from two, because
  more of the API is visible. The generator's list is in `spec-audit.generated.md`.
- **Finding 7:** 61 operations, up from 34, for the same reason.

The generated guides were also run against a real business for the first time. See "What running
the guides showed" at the end; it adds two findings, 8 and 9.

## Summary

From this description a guide generator produced 89 pages and used 241 of the 565 operations in a
guide. It could not produce an errors page or a rate limits page at all, and skipped 10 guides for
reasons in the description.

| # | Finding | Affected | Priority |
|---|---|---|---|
| 1 | No operation declares an error response | 565 of 565 operations | High |
| 2 | No single OpenAPI document is published | The whole description | High |
| 3 | Path parameters have no example | 339 of 340 | Medium |
| 4 | The description does not say how to get an API key | 1 security scheme | Medium |
| 5 | Two responses do not show the identifier a next call needs | 2 operations | Medium |
| 6 | One request body has no example | 1 of 286 | Low |
| 7 | The same body is declared under both 200 and 201 | 34 operations | Low |

What is already strong: every operation has an `operationId`, a summary and a description; 285 of
286 request bodies carry a realistic example; lists page by cursor consistently (120 operations);
and descriptions state the rules a caller needs, such as permissions and what a refusal means.

## Two questions first

Findings 1 and 7 may be features of the view we read, not of your full description. The piecewise
`/openapi` reads are described as built for AI agents.

- Do you keep a fuller description in which each operation declares its 4xx and 5xx responses?
- Is there a single document we should be reading instead?

If the answer to either is yes, findings 1, 2 and 7 change accordingly.

## Findings

### 1. No operation declares an error response

Every operation lists only its success responses. Errors are given in a private field, `x-errors`,
as one line of text, for example on `createSite`:

> 400 bad_request, validation_failed; 401 unauthenticated; 403 forbidden, business_suspended, …;
> 429 too_many_attempts, rate_limited; 503 busy: each a Problem …

Extension fields are not part of OpenAPI. Reference renderers, SDK generators, mock servers and
contract tests do not read them, so to all of those the API never fails. The `Problem` schema is
well described, but nothing links an operation's responses to it.

Effect on the docs: no errors page, no rate limits page (429 appears only in `x-errors`, on all 565
operations), and no error shown beside any call.

**Fix.** Declare each status under `responses`, pointing at the `Problem` schema. A few shared
entries under `components/responses` (one per status) keep it to one line per status per operation.
The error codes now listed in `x-errors` can go in each response's description. `x-errors` can stay
for agents.

### 2. No single OpenAPI document is published

The description is served a piece at a time (`/openapi`, `/openapi/operations/{id}`,
`/openapi/schemas/{name}`), and only with an API key. `/openapi.json` returns 404. Reading all of it
took 1166 requests and an assembly script; the pieces did merge cleanly, with no conflicting
schema definitions.

Effect: standard tools cannot be pointed at the API, and a published document cannot be diffed
between versions. The API grew from 560 to 565 operations between 2026-11-26 and 2026-11-27, which
we saw only by re-reading everything.

**Fix.** Serve the whole document at one URL, with a key if it must be private. The piecewise reads
can stay for agents.

### 3. Path parameters have no example

339 of 340 path parameters have no `example`. A guide never invents an identifier, so where no
earlier call in a guide yields the value, the guide is skipped. Eight were, among them adding a
contact point to a customer, adding lines to a sales order or a purchase order, and adding a task
to a work order.

**Fix.** Add an `example` to each path parameter. The identifiers already used in request body
examples (such as `0199a3c4-5d6e-7f80-9a1b-2c3d4e5f6a7b`) would do.

### 4. The description does not say how to get an API key

The security scheme reads "API key issued to a tenant, prefixed rtv_". It does not say where a
developer gets one, what kinds of key exist (the identity response shows `kind`, `is_read_only`,
expiry), or how a sandbox business differs. The quickstart and the authentication page each carry a
gap for a person to fill.

**Fix.** Say it in the security scheme's description: where keys are issued, the kinds of key, and
that `getIdentity` shows what a key may do.

### 5. Two responses do not show the identifier a next call needs

- `returnAndRefund` creates a return, but its response schema has no `return_id` or `id` at the top
  level or one level down. No guide for returns could be written.
- `listEvents` returns events without an identifier a guide could find in the items, so no guide
  for reading the event feed.

`issueStatements` is flagged by the generator for the same reason; it issues many statements at
once, so that one may be as intended.

**Fix.** Return the new record's identifier under the name the path parameter uses.

### 6. One request body has no example

`setNextNumber`. Every other request body has one.

### 7. The same body is declared under both 200 and 201

34 operations that create a record declare 200 and 201 with identical descriptions and schemas, for
example `createCustomer`, `createSite`, `createSalesOrder` and `bookDelivery`. The description says
a repeated `idempotency_key` "answers the first", which may be the 200 case, but no response says
when each status is returned.

**Fix.** In each response's description, say when it applies (for example: 201 when the record is
created, 200 when a repeated key returns the earlier result), or keep one status.

The full list of 34 is in `spec-audit.generated.md`.

## Not Retavon's to fix

These limited the generated guides too, and are faults or limits of the generator:

- Nine resources that are created by an action-style call (such as accepting a quote or making a
  bank deposit) were not recognised as creatable.
- Some identifiers in request bodies are still sent as example values, such as
  `sales_order_line_id` and `package_id`, because nothing was matched that creates them.
- `updateMessageTemplate` was left out of its guide because no valid request body could be built.
- Whether the generated flows run was not tested; they were read, not executed.

## What running the guides showed

On 2026-11-28 the generated guides were sent, call by call, to a Retavon business, with the key of
an agent that acts for no staff member. 236 pages were run; pages that email, text, charge a card,
issue a key or send feedback were left out. The per-page results are in `run-results.json`.

| Outcome | Pages |
|---|---|
| Passed as written | 7 |
| Passed once an example value was changed | 77 |
| Nothing to list | 16 |
| Failed | 136 |

### 8. Example values can be used once

Examples are fixed, and many name something that must be unique: a phone number, a branch code
`BOI`, a brand `Hot Spring`, a ledger account `6600`. The first guide to create that record works.
Every later one, and every second reader, gets `409 customer_exists` or `409 conflict`. 77 of the
84 pages that work at all work only after such a value is changed.

This is a property of examples, not a fault in Retavon's. It still matters to anyone following a
guide in a business that already has data.

**What would help.** Say in the description of each unique field that it is unique (several already
do). Where a refusal names the field and value, as `conflict` does, keep doing so: that is what let
a tool recover. `customer_exists` names the customer but not which phone number or email collided.

### 9. What an agent key may not do is not in the description of the operation

32 pages failed because a call by an agent key "is put to a person" and refused: `createStaffMember`,
`createRole`, `addContactPoint`, `mergeCustomers`, `giveStoreCredit` and others. Six more failed
because the key "acts for nobody" and the call needs a staff member named. The refusals are clear.
The description carries the rule in `x-agent-proposes` and `x-required-permission`, which standard
tools do not read, so a guide cannot warn a reader before the call.

**What would help.** This is finding 1 again: state it in the operation's `description`, which every
tool shows, as well as in the extension.

### The rest of the failures are not Retavon's

- 43 pages sent an example identifier that no earlier step had created. That is the generator's.
- 43 pages hit a business rule because of the order or state the generator chose, such as
  refunding an order that has no payment.
- 2 pages failed because the test tool changed a value it should not have.
