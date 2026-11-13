-- Detect reuse of a rotated refresh token (OAuth 2.1 recommends revoking the grant when a refresh
-- token is presented again after rotation, since one of the two holders is likely an attacker).
ALTER TABLE oauth_grants ADD COLUMN previous_refresh_token_hash TEXT;
CREATE INDEX oauth_grants_previous_refresh ON oauth_grants(previous_refresh_token_hash);
