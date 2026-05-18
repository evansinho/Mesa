-- Store the merchant's WhatsApp Business API access token so outbound
-- messages to customers can be sent from the merchant's own WABA number.
-- Merchant-facing notifications (vendor tap, pending alerts) continue to use
-- Mesa's shared bot number.
--
-- The token is plain text for now. Once F-7 RLS is in place the token will
-- be inaccessible cross-tenant; until then, restrict raw DB access and treat
-- this column as sensitive (it grants the holder the ability to send
-- WhatsApp messages from the merchant's number).

ALTER TABLE merchant_channels
  ADD COLUMN IF NOT EXISTS access_token text;