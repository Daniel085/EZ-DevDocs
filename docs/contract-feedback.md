# Feedback on the Guides Bundle Contract

The feedback lives in the portal repository, next to the contract it is about:

- **File:** `docs/contracts/guides-contract-feedback.md` in `daniel085/ez-devportal`
- **Link:** <https://github.com/daniel085/ez-devportal/blob/claude/hopeful-darwin-fuei2f/docs/contracts/guides-contract-feedback.md>
  (on the working branch until it is merged; after that, the same path on the default branch)
- **Companion:** `docs/contracts/guides-module-status.md` in the same directory describes what this
  module emits today, for the portal side.

It holds the answers to the contract's open questions, the proposed changes, the assumptions this
module makes where the contract is silent, and the validator's error codes.

There is no copy here. Portal sessions cannot read this repository, so anything the portal side
needs to know goes in that file. When this module starts relying on a new assumption, or finds
something the contract cannot express, edit the file there in the same piece of work.
