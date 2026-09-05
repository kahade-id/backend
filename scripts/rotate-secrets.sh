#!/usr/bin/env bash
set -euo pipefail

SECRET_NAME="${1:-}"

if [ -z "$SECRET_NAME" ]; then
  echo "Usage: $0 <secret_name>"
  echo ""
  echo "Supported secrets:"
  echo "  JWT_SECRET              - Rotate JWT signing key (invalidates all access tokens)"
  echo "  JWT_REFRESH_SECRET      - Rotate refresh token key (invalidates all refresh tokens)"
  echo "  JWT_ADMIN_SECRET        - Rotate admin JWT key (invalidates admin sessions)"
  echo "  JWT_ADMIN_REFRESH_SECRET - Rotate admin refresh key"
  echo "  JWT_TEMP_SECRET         - Rotate temp JWT key"
  echo "  AES_SECRET_KEY          - Rotate AES encryption key (requires re-encryption of existing data)"
  echo "  HMAC_SECRET_KEY         - Rotate HMAC key (requires re-computation of all HMAC hashes)"
  echo "  WALLET_PIN_PEPPER       - Rotate wallet PIN pepper (all users must reset PINs)"
  echo ""
  echo "Steps performed:"
  echo "  1. Generate new secret value"
  echo "  2. Write to .env.new with timestamp"
  echo "  3. Operator must manually update deployment and restart services"
  echo ""
  echo "WARNING: Rotating AES_SECRET_KEY or HMAC_SECRET_KEY requires a data migration."
  echo "         Run the corresponding migration script after updating the secret."
  exit 1
fi

ROTATABLE_SECRETS=(
  "JWT_SECRET"
  "JWT_REFRESH_SECRET"
  "JWT_ADMIN_SECRET"
  "JWT_ADMIN_REFRESH_SECRET"
  "JWT_TEMP_SECRET"
  "AES_SECRET_KEY"
  "HMAC_SECRET_KEY"
  "WALLET_PIN_PEPPER"
  "AES_KDF_SALT"
)

FOUND=false
for s in "${ROTATABLE_SECRETS[@]}"; do
  if [ "$s" = "$SECRET_NAME" ]; then
    FOUND=true
    break
  fi
done

if [ "$FOUND" = false ]; then
  echo "ERROR: Unknown secret '$SECRET_NAME'. Run without arguments for usage."
  exit 1
fi

case "$SECRET_NAME" in
  AES_SECRET_KEY|HMAC_SECRET_KEY)
    NEW_VALUE=$(openssl rand -hex 32)
    ;;
  AES_KDF_SALT)
    NEW_VALUE=$(openssl rand -base64 48 | tr -d '\n')
    ;;
  *)
    NEW_VALUE=$(openssl rand -base64 48 | tr -d '\n')
    ;;
esac

TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
ROTATION_FILE=".env.rotation.${SECRET_NAME}.$(date +%s)"

echo "# Secret rotation generated at $TIMESTAMP" > "$ROTATION_FILE"
echo "# Secret: $SECRET_NAME" >> "$ROTATION_FILE"
echo "# IMPORTANT: Update your deployment environment and restart all services." >> "$ROTATION_FILE"
echo "$SECRET_NAME=$NEW_VALUE" >> "$ROTATION_FILE"

chmod 600 "$ROTATION_FILE"

echo "[rotate-secrets] New value for $SECRET_NAME generated."
echo "[rotate-secrets] Written to: $ROTATION_FILE"
echo "[rotate-secrets] Timestamp: $TIMESTAMP"
echo ""
echo "Next steps:"
echo "  1. Update the secret in your deployment environment (e.g., Kubernetes secret, Docker env)"
echo "  2. Restart all services to pick up the new value"
if [ "$SECRET_NAME" = "JWT_SECRET" ] || [ "$SECRET_NAME" = "JWT_REFRESH_SECRET" ]; then
  echo "  3. All user sessions will be invalidated — users must re-authenticate"
fi
if [ "$SECRET_NAME" = "AES_SECRET_KEY" ]; then
  echo "  3. Run the AES re-encryption migration to update encrypted data"
fi
if [ "$SECRET_NAME" = "HMAC_SECRET_KEY" ]; then
  echo "  3. Run the HMAC re-computation migration to update all HMAC hashes"
fi
