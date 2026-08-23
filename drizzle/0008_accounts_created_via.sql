-- eng-0008: social login — the account origin column backing the one-way
-- binding rule (doc-06 Δ1): accounts.created_via records how the account
-- came to exist (email_code | social:{provider}); federated-origin accounts
-- never grow a password (enforced by SocialAccountService.federatedOrigin).

ALTER TABLE accounts ADD COLUMN created_via varchar(32) NOT NULL DEFAULT 'email_code';
