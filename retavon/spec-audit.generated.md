# Spec audit: Retavon API 0.1.0

What to change in the API description so that better guides can be generated from it. It covers the description only (OpenAPI 3.1.0, 565 operations, sha256 `5ecac7e43f04e196623f1a8a5903c33b86201a9605dc2490f17a88a469d52539`), not the behavior of the API.

From this description the generator wrote 89 pages and skipped 23. 241 of 565 operations appear in a guide. The run report next to this file lists each skipped page with its reason.

5 findings: 1 high, 3 medium, 1 low.

| Severity | Finding | Affected |
| --- | --- | --- |
| high | Operations that declare no error response | 565 of 565 operations |
| medium | Path parameters with no example | 339 of 340 path parameters |
| medium | Create operations whose response does not show the new identifier | 2 of 58 create operations |
| medium | Request bodies with no example | 1 of 286 request bodies |
| low | Operations that declare the same body under several success statuses | 34 of 565 operations |

**High** means pages are missing or wrong because of it. **Medium** means pages say less than they could. **Low** is polish.

## Operations that declare no error response

Severity: high. Affects 565 of 565 operations. Code: `no-error-responses`.

These operations list no 4xx, 5xx or `default` response, so the description does not say how a call fails. No Errors page could be written, and none on rate limits unless a rate limit header is documented. 565 of them carry the extension field `x-errors`, whose name suggests it describes errors. Extension fields are not part of OpenAPI, and tools that read the standard do not see them.

**Fix:** Declare each error status under `responses`, with a schema for the error body. A shared response under `components/responses` keeps this short.

Affected: `getServiceIndex`, `getHealth`, `getIdentity`, `setAssistantAccess`, `setPinnedScreens`, `signOut`, `getBilling`, `openBillingPortal`, `listApiKeys`, `issueApiKey`, `getApiKey`, `rotateApiKey`, `revokeApiKey`, `listTaxClasses`, `createTaxClass`, `updateTaxClass`, `listTaxJurisdictions`, `createTaxJurisdiction`, `updateTaxJurisdiction`, `setTaxRate`, and 545 more (all are in the run report).

## Path parameters with no example

Severity: medium. Affects 339 of 340 path parameters. Code: `path-parameter-no-example`.

An identifier is never made up. Where no earlier call in a guide yields the value and the parameter has no example, the guide is skipped.

**Fix:** Add an `example` to each path parameter.

In: `getApiKey`, `rotateApiKey`, `revokeApiKey`, `updateTaxClass`, `updateTaxJurisdiction`, `setTaxRate`, `updateTaxHoliday`, `updateTaxArea`, `getLocation`, `updateLocation`, `setLocationHours`, `getZone`, `updateZone`, `getTimeOff`, `updateTimeOff`, `approveTimeOff`, `declineTimeOff`, `withdrawTimeOff`, `getStaffMember`, `updateStaffMember`, and 297 more (all are in the run report).

## Create operations whose response does not show the new identifier

Severity: medium. Affects 2 of 58 create operations. Code: `created-identifier-not-shown`.

The response schema has no field named like the path parameter of the resource, or `id`, at its top level or one level down. A guide cannot carry the new record into the next call.

**Fix:** Return the identifier in the response body, under the name the path parameter uses or `id`.

Affected: `returnAndRefund`, `issueStatements`.

## Request bodies with no example

Severity: medium. Affects 1 of 286 request bodies. Code: `no-request-example`.

Sample values for these are built from the schema: defaults, enum values and, failing those, placeholders such as "string". They are valid but not realistic.

**Fix:** Add an example to the request body or to its schema.

Affected: `setNextNumber`.

## Operations that declare the same body under several success statuses

Severity: low. Affects 34 of 565 operations. Code: `several-success-statuses`.

Two or more 2xx statuses carry an identical schema. The description does not say when each is returned, so a guide can only show one of them.

**Fix:** Keep the status the operation returns, or say in each response description when it applies.

Affected: `recordTimeOff`, `askForTimeOff`, `createStaffMember`, `addCustomerNote`, `sendCustomerPage`, `createCustomer`, `createSite`, `changeSiteOwner`, `addFollowUp`, `changeCategoryPrices`, `createStockCount`, `createSalesOrder`, `emailPurchaseOrder`, `createPurchaseOrder`, `createEquipment`, `bookVisit`, `recordVisitCheck`, `bookDelivery`, `scheduleRedelivery`, `recordSiteCheck`, and 14 more (all are in the run report).
