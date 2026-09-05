-- CreateIndex
CREATE INDEX "orders_status_deliveryDeadlineAt_idx" ON "orders"("status", "deliveryDeadlineAt");

-- CreateIndex
CREATE INDEX "orders_status_paymentDeadlineAt_idx" ON "orders"("status", "paymentDeadlineAt");

-- CreateIndex
CREATE INDEX "orders_status_confirmationDeadlineAt_idx" ON "orders"("status", "confirmationDeadlineAt");

-- CreateIndex
CREATE INDEX "orders_status_processingDeadlineAt_idx" ON "orders"("status", "processingDeadlineAt");
