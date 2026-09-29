-- Misi tanpa-wallet (BI-safe): renewal Kahade+ via DANA direct.
-- Kolom nullable aditif: payment DANA untuk renewal menunjuk subscription
-- yang diperpanjang (new-subscribe memakai relasi subscription.paymentTxId).
ALTER TABLE "payment_transactions" ADD COLUMN "renewalForSubscriptionId" TEXT;
