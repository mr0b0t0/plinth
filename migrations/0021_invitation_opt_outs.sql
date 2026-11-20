-- Invitation emails (docs/spec.md "Invitation emails"): the addresses whose holders turned
-- invitation emails off on the app's /invitation-emails page, after signing in as that address.
-- An invitation to one is never sent (the answer still costs the owner what an email would);
-- the grant itself still applies.
--
-- address_hash is services/invitations.ts invitationAddressHash (the first 32 hex characters of
-- SHA-256 of "invite\n<mailbox>", the mailbox being the address lowercased, without a +tag and,
-- for Gmail, without dots: invitationMailbox), the same key the invitation counters use, so the
-- table never holds an address and one row covers every variant of an inbox. Turning invitations
-- back on deletes the row. Rows are kept when an account is erased: the opt-out belongs to the
-- address, and dropping it would let invitations reach that inbox again.
CREATE TABLE invitation_opt_outs (
  address_hash TEXT PRIMARY KEY CHECK (length(address_hash) = 32),
  created_at TEXT NOT NULL CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*') -- UTC ISO 8601
);
