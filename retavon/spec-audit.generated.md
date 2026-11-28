# Spec audit: Retavon API 0.1.0

What to change in the API description so that better guides can be generated from it. It covers the description only (OpenAPI 3.1.0, 795 operations, sha256 `c6ac4d276e73c4ac267cf8b74c0127ea59384caf834c5cb531092cdc0a4e4ddd`), not the behavior of the API.

From this description the generator wrote 259 pages and skipped 37. 476 of 795 operations appear in a guide. The run report next to this file lists each skipped page with its reason.

3 findings: 1 high, 1 medium, 1 low.

| Severity | Finding | Affected |
| --- | --- | --- |
| high | Operations that declare no error response | 795 of 795 operations |
| medium | Create operations whose response does not show the new identifier | 5 of 97 create operations |
| low | Operations that declare the same body under several success statuses | 61 of 795 operations |

**High** means pages are missing or wrong because of it. **Medium** means pages say less than they could. **Low** is polish.

## Operations that declare no error response

Severity: high. Affects 795 of 795 operations. Code: `no-error-responses`.

These operations list no 4xx, 5xx or `default` response, so the description does not say how a call fails. No Errors page could be written, and none on rate limits unless a rate limit header is documented. 795 of them carry the extension field `x-errors`, whose name suggests it describes errors. Extension fields are not part of OpenAPI, and tools that read the standard do not see them.

**Fix:** Declare each error status under `responses`, with a schema for the error body. A shared response under `components/responses` keeps this short.

Affected: `getServiceIndex`, `getHealth`, `getIdentity`, `setAssistantAccess`, `setPinnedScreens`, `signOut`, `getBilling`, `openBillingPortal`, `listApiKeys`, `issueApiKey`, `getApiKey`, `rotateApiKey`, `revokeApiKey`, `listTaxClasses`, `createTaxClass`, `updateTaxClass`, `listTaxJurisdictions`, `createTaxJurisdiction`, `updateTaxJurisdiction`, `setTaxRate`, and 775 more (all are in the run report).

## Create operations whose response does not show the new identifier

Severity: medium. Affects 5 of 97 create operations. Code: `created-identifier-not-shown`.

The response schema has no field named like the path parameter of the resource, or `id`, at its top level or one level down. A guide cannot carry the new record into the next call.

**Fix:** Return the identifier in the response body, under the name the path parameter uses or `id`.

Affected: `createTaxHoliday`, `returnAndRefund`, `issueStatements`, `runFinanceCharges`, `planShifts`.

## Operations that declare the same body under several success statuses

Severity: low. Affects 61 of 795 operations. Code: `several-success-statuses`.

Two or more 2xx statuses carry an identical schema. The description does not say when each is returned, so a guide can only show one of them.

**Fix:** Keep the status the operation returns, or say in each response description when it applies.

Affected: `recordTimeOff`, `askForTimeOff`, `createStaffMember`, `addCustomerNote`, `sendCustomerPage`, `createCustomer`, `createSite`, `changeSiteOwner`, `recordTaxExemptionCertificate`, `captureLead`, `logLeadActivity`, `addFollowUp`, `changeCategoryPrices`, `createPromotion`, `createStockCount`, `createSalesOrder`, `emailPurchaseOrder`, `createPurchaseOrder`, `createSubscription`, `createEquipment`, and 41 more (all are in the run report).

## Vendor extensions

The description carries 12 extension fields (names that start with `x-`). They are not part of OpenAPI, so tools that read the standard do not see them. Guides show one only when the settings of a build give it a role.

| Extension | Used | On | Role in this build | Example value |
| --- | --- | --- | --- | --- |
| `x-money` | 1033 | parameter, request, schema | ignore | true |
| `x-errors` | 795 | operation | errors | "400 bad\_request, validation\_failed; 429 too\_many\_attempts, rate\_limited: each… |
| `x-response-fields` | 795 | operation | ignore | \{"ServiceIndex":"name, version, map\_url, api\_url, mcp\_url, authentication… |
| `x-natural-key` | 633 | parameter, request, schema | ignore | "branch\_code" |
| `x-feature` | 319 | operation | requires | "tax\_shapes" |
| `x-checks-within` | 213 | operation | permission | \["policy.manage"\] |
| `x-outsider-written` | 210 | schema | ignore | true |
| `x-required-permission` | 206 | operation | permission | "billing.manage" |
| `x-moves` | 97 | operation | note | \["books"\] |
| `x-idempotent` | 50 | operation | note | "A key is revoked once: revoking a key already revoked changes nothing." |
| `x-agent-proposes` | 36 | operation | note | "agent\_staff\_changes" |
| `x-changes-nothing` | 6 | operation | note | true |

What an extension says that readers need (errors, permissions, what must be switched on) is best said in standard fields too: `responses`, `security` and each operation's `description`.
